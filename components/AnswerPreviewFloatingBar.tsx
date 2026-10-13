import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useEffect } from 'react';
import { StyleSheet, useWindowDimensions } from 'react-native';
import {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import type { ZhihuPreviewAnswerMetadata } from '@/api/zhihu/nextRender';
import { CollectionButton } from '@/components/CollectionButton';
import {
  CONTENT_ACTION_BAR_HEIGHT,
  ContentActionBar,
} from '@/components/ContentActionBar';
import { ContentActionButton } from '@/components/ContentActionButton';
import { MoreActionsButton } from '@/components/MoreActionsButton';
import { SegmentedVoteCapsule } from '@/components/SegmentedVoteCapsule';
import { Text, useRuntimeThemeColors, View } from '@/components/Themed';

interface AnswerPreviewFloatingBarProps {
  answer: ZhihuPreviewAnswerMetadata | null;
  visible: boolean;
  bottomInset: number;
  canCollapse?: boolean;
  onCollapse: (answerId: string) => void;
  onMore: (answer: ZhihuPreviewAnswerMetadata) => void;
}

export function AnswerPreviewFloatingBar({
  answer,
  visible,
  bottomInset,
  canCollapse = true,
  onCollapse,
  onMore,
}: AnswerPreviewFloatingBarProps) {
  const router = useRouter();
  const colors = useRuntimeThemeColors();
  const { width, fontScale } = useWindowDimensions();
  const compact = width / fontScale < 400;
  const showCommentCount = width / fontScale >= 360;
  const shown = visible && answer !== null;
  const progress = useSharedValue(0);
  useEffect(() => {
    progress.value = withTiming(shown ? 1 : 0, { duration: 220 });
  }, [progress, shown]);
  const animatedStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ translateY: (1 - progress.value) * 100 }],
  }));
  const collapseAction =
    shown && answer && canCollapse ? (
      <ContentActionButton
        accessibilityRole="button"
        accessibilityLabel="收起当前回答"
        style={compact ? styles.collapseInline : styles.collapseCircle}
        onPress={() => {
          if (shown) onCollapse(answer.id);
        }}
      >
        <Ionicons name="chevron-up" size={22} color={colors.link} />
      </ContentActionButton>
    ) : null;

  return (
    <ContentActionBar
      bottomInset={bottomInset}
      visible={shown}
      style={animatedStyle}
      variant="islands"
      shrinkLeading
      leading={
        answer ? (
          <SegmentedVoteCapsule
            id={answer.id}
            count={answer.voteup_count}
            voted={answer.relationship.voting}
            type="answers"
            allowCountShrink
          />
        ) : null
      }
      trailing={
        answer ? (
          <View style={styles.trailingGroup}>
            <CollectionButton
              id={answer.id}
              type="answer"
              isCollected={answer.relationship.is_favorited}
              count={answer.favlists_count}
              compact={!showCommentCount}
              disabled={!shown}
            />
            <ContentActionButton
              accessibilityRole="button"
              accessibilityLabel={`${answer.comment_count} 条回答评论`}
              style={styles.action}
              onPress={() => {
                if (!shown) return;
                router.push({
                  pathname: '/comments/[id]',
                  params: {
                    id: answer.id,
                    type: 'answer',
                    count: answer.comment_count,
                  },
                });
              }}
            >
              <Ionicons
                name="chatbubble-outline"
                size={19}
                color={colors.textSecondary}
              />
              {showCommentCount && (
                <Text type="secondary" style={styles.label}>
                  {answer.comment_count}
                </Text>
              )}
            </ContentActionButton>
            <MoreActionsButton
              accessibilityLabel="回答更多操作"
              style={styles.more}
              onPress={() => {
                if (shown) onMore(answer);
              }}
            />
            {compact ? collapseAction : null}
          </View>
        ) : null
      }
      accessory={compact ? null : collapseAction}
    />
  );
}

const styles = StyleSheet.create({
  trailingGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'transparent',
  },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  label: { fontSize: 13, lineHeight: 20, fontWeight: '600' },
  more: { marginLeft: 4 },
  collapseInline: {
    width: 36,
    height: CONTENT_ACTION_BAR_HEIGHT,
    paddingHorizontal: 0,
    paddingVertical: 0,
  },
  collapseCircle: {
    width: CONTENT_ACTION_BAR_HEIGHT,
    height: CONTENT_ACTION_BAR_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 0,
    paddingVertical: 0,
  },
});
