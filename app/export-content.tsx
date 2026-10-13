import { useIsFocused } from '@react-navigation/native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';
import { Platform } from 'react-native';
import { Text, View } from '@/components/Themed';
import { ContentExportScreen } from '@/features/content-export/ContentExportScreen';
import {
  EXPORT_CONTENT_LABELS,
  parseExportTarget,
} from '@/features/content-export/entry';
import { getAuthSessionVersion, useAuthStore } from '@/store/useAuthStore';

export default function ExportContentRoute() {
  const params = useLocalSearchParams<{
    type?: string;
    id?: string;
    session?: string;
  }>();
  const session = useAuthStore(() => getAuthSessionVersion());
  const focused = useIsFocused();
  const target = useMemo(
    () =>
      parseExportTarget(
        params.type,
        params.id,
        typeof params.session === 'string' && /^\d+$/.test(params.session)
          ? Number(params.session)
          : NaN,
      ),
    [params.type, params.id, params.session],
  );
  const valid = target && target.sessionVersion === session;
  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen
        options={{
          title: target
            ? `导出${EXPORT_CONTENT_LABELS[target.type]}`
            : '内容导出',
        }}
      />
      {Platform.OS === 'web' ? (
        <Text style={{ padding: 24 }}>
          文件导出请使用 Android 或 iOS 应用。
        </Text>
      ) : !valid ? (
        <Text style={{ padding: 24 }}>
          内容或账号已变化，请返回内容页重新打开导出。
        </Text>
      ) : (
        <ContentExportScreen
          key={`${target.type}:${target.id}:${target.sessionVersion}`}
          target={target}
          active={focused}
        />
      )}
    </View>
  );
}
