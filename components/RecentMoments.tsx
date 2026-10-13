import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import React from 'react';
import { Pressable, ScrollView } from 'react-native';
import {
  GestureDetector,
  type NativeGesture,
} from 'react-native-gesture-handler';
import { fetchRecentMoments } from '@/api/zhihu';
import { useNestedHorizontalGesture } from '@/hooks/useNestedHorizontalGesture';
import { StableAvatar } from './StableAvatar';
import { Text, useThemeColor, View } from './Themed';

/**
 * 最近更新的用户头像栏 (朋友圈/动态更新提示)
 */
function RecentMomentsComponent({
  isActive = true,
  onInteractionChange,
  parentGesture,
}: {
  isActive?: boolean;
  onInteractionChange?: (interacting: boolean) => void;
  parentGesture?: NativeGesture;
}) {
  const router = useRouter();
  const primaryColor = useThemeColor({}, 'primary');
  const dangerColor = useThemeColor({}, 'danger');
  const onDanger = useThemeColor({}, 'onDanger');
  const surfaceColor = useThemeColor({}, 'backgroundSecondary');

  const { data } = useQuery({
    queryKey: ['recent-moments'],
    queryFn: fetchRecentMoments,
    // 每 5 分钟自动刷新一次
    refetchInterval: 1000 * 60 * 5,
    // 页面聚焦时刷新
    refetchOnWindowFocus: true,
  });

  const scrollGesture = useNestedHorizontalGesture(
    onInteractionChange,
    isActive && !!data?.data.length,
    parentGesture,
  );

  // 如果没有数据或数据为空，则不渲染
  if (!data?.data || data.data.length === 0) {
    return null;
  }

  return (
    <View className="bg-transparent border-b-[0.5px] border-black/5 dark:border-white/5">
      <GestureDetector gesture={scrollGesture}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerClassName="px-4 py-4"
        >
          {data.data.map((item) => (
            <Pressable
              key={item.actor.id}
              onPress={() => {
                router.push({
                  pathname: '/user/[id]/stream',
                  params: {
                    id: item.actor.url_token || item.actor.id,
                    unreadCount: String(item.unread_count),
                    source: 'recent-moments',
                  },
                });
              }}
              className="items-center mr-4 w-[64px]"
            >
              <View className="relative mb-1.5 bg-transparent">
                {/* 头像外圈，增加一点仪式感 */}
                <View
                  className="p-[2px] rounded-full border-[1.5px]"
                  style={{
                    borderColor:
                      item.unread_count > 0 ? primaryColor : 'transparent',
                  }}
                >
                  <StableAvatar
                    uri={item.actor.avatar_url}
                    className="w-[52px] h-[52px] rounded-full bg-black/5 dark:bg-white/5"
                  />
                </View>

                {/* 未读数字角标 */}
                {item.unread_count > 0 && (
                  <View
                    className="absolute -right-1 -top-1 rounded-full min-w-[20px] h-[20px] justify-center items-center px-1 border-2"
                    style={{
                      backgroundColor: dangerColor,
                      borderColor: surfaceColor,
                    }}
                  >
                    <Text
                      className="font-bold text-center"
                      style={{
                        color: onDanger,
                        fontSize: 10,
                        lineHeight: 12,
                      }}
                    >
                      {item.unread_count > 99 ? '99+' : item.unread_count}
                    </Text>
                  </View>
                )}
              </View>

              <Text
                numberOfLines={1}
                className="text-[10px] text-center w-full"
                type={item.unread_count > 0 ? 'default' : 'secondary'}
              >
                {item.actor.name}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      </GestureDetector>
    </View>
  );
}

export const RecentMoments = React.memo(RecentMomentsComponent);
RecentMoments.displayName = 'RecentMoments';
