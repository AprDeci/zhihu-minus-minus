import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AppState,
  Modal,
  PixelRatio,
  Platform,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import {
  WebView,
  type WebViewMessageEvent,
  type WebViewProps,
} from 'react-native-webview';
import { BouncyButton } from '@/components/BouncyButton';
import { Text, useRuntimeThemeColors } from '@/components/Themed';
import { ContentExportError } from './errors';
import {
  type ImageSlice,
  imageMeasurementScript,
  imagePositionScript,
  planImageSlices,
} from './imagePagination';
import type { ExportTaskContext } from './types';

interface CaptureRequest {
  readonly html: string;
  readonly width: number;
  readonly height: number;
  readonly context: ExportTaskContext;
  readonly resolve: (uris: readonly string[]) => void;
  readonly reject: (error: unknown) => void;
}

export function releaseImageCaptures(uris: readonly string[]): void {
  if (!uris.length) return;
  try {
    const { releaseCapture } =
      require('react-native-view-shot') as typeof import('react-native-view-shot');
    for (const uri of uris) releaseCapture(uri);
  } catch {
    /* The task directory owns copies after generation. */
  }
}

function ImageExportSurface({ request }: { request: CaptureRequest }) {
  const colors = useRuntimeThemeColors();
  const dimensions = useWindowDimensions();
  const webview = useRef<WebView<WebViewProps>>(null);
  const surface = useRef<View>(null);
  const pages = useRef<readonly ImageSlice[]>([]);
  const captured = useRef<string[]>([]);
  const completed = useRef(false);
  const capturing = useRef(false);
  const positioned = useRef(-1);
  const [measuredSize, setMeasuredSize] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const [index, setIndex] = useState(-1);
  const htmlSource = useMemo(() => ({ html: request.html }), [request.html]);
  const height = index < 0 ? request.height : pages.current[index].height;
  const frameReady =
    measuredSize !== null &&
    Math.abs(measuredSize.width - request.width) < 1 &&
    Math.abs(measuredSize.height - height) < 1;
  const fail = useCallback(
    (message = '长图生成失败，请重试或选择 HTML') => {
      if (completed.current) return;
      completed.current = true;
      releaseImageCaptures(captured.current);
      request.reject(new ContentExportError(message));
    },
    [request],
  );
  useEffect(() => {
    const cancel = () => fail('导出已取消');
    request.context.signal.addEventListener('abort', cancel);
    if (request.context.signal.aborted) cancel();
    const timeout = setTimeout(
      () => fail('长图排版超时，请重试或选择 HTML'),
      120_000,
    );
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') fail('长图生成已中断，请回到应用后重试');
    });
    return () => {
      clearTimeout(timeout);
      subscription.remove();
      request.context.signal.removeEventListener('abort', cancel);
      cancel();
    };
  }, [request, fail]);
  useEffect(() => {
    if (
      dimensions.width < request.width ||
      dimensions.height < request.height + 100
    ) {
      fail('屏幕尺寸已变化，请重新生成长图');
    }
  }, [dimensions, request, fail]);

  const capturePage = async () => {
    if (
      completed.current ||
      capturing.current ||
      index < 0 ||
      positioned.current !== index ||
      captured.current.length !== index ||
      !frameReady
    )
      return;
    capturing.current = true;
    let uri: string | undefined;
    try {
      request.context.assertActive();
      const { captureRef } =
        require('react-native-view-shot') as typeof import('react-native-view-shot');
      const slice = pages.current[index];
      const scale = Math.min(2, 1080 / request.width);
      // iOS view-shot sizes are points in a screen-scaled UIGraphics context;
      // Android passes these dimensions directly to a pixel-sized Bitmap.
      const nativeScale = Platform.OS === 'ios' ? PixelRatio.get() : 1;
      uri = await captureRef(surface, {
        format: 'png',
        result: 'tmpfile',
        width: Math.round(request.width * scale) / nativeScale,
        height: Math.round(slice.height * scale) / nativeScale,
      });
      if (completed.current) {
        releaseImageCaptures([uri]);
        return;
      }
      request.context.assertActive();
      captured.current.push(uri);
      uri = undefined;
      request.context.onProgress?.({
        phase: 'render',
        completed: index + 1,
        total: pages.current.length,
      });
      if (index + 1 === pages.current.length) {
        completed.current = true;
        request.resolve(captured.current);
      } else {
        setIndex(index + 1);
      }
    } catch {
      if (uri) releaseImageCaptures([uri]);
      fail('长图生成不可用，请确认已安装包含截图模块的新版本');
    } finally {
      capturing.current = false;
    }
  };

  // The native frame must have its final height before acknowledging its position.
  useEffect(() => {
    if (index < 0 || !frameReady || completed.current) return;
    positioned.current = -1;
    const frame = requestAnimationFrame(() => {
      webview.current?.injectJavaScript(
        imagePositionScript(index, pages.current[index].offset),
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [index, frameReady]);

  const onMessage = (event: WebViewMessageEvent) => {
    if (completed.current) return;
    try {
      request.context.assertActive();
      if (event.nativeEvent.data.length > 2_000_000) throw new Error('size');
      const data: unknown = JSON.parse(event.nativeEvent.data);
      if (!data || typeof data !== 'object' || !('type' in data)) return;
      if (data.type === 'failed') return fail();
      if (
        data.type === 'measured' &&
        index < 0 &&
        'height' in data &&
        'boundaries' in data
      ) {
        if (
          typeof data.height !== 'number' ||
          !Array.isArray(data.boundaries) ||
          !data.boundaries.every((value) => typeof value === 'number')
        )
          throw new Error('measurement');
        pages.current = planImageSlices(
          data.height,
          data.boundaries,
          request.height,
        );
        setIndex(0);
      } else if (
        data.type === 'positioned' &&
        'index' in data &&
        data.index === index
      ) {
        positioned.current = index;
        void capturePage();
      }
    } catch (error) {
      fail(error instanceof ContentExportError ? error.message : undefined);
    }
  };
  return (
    <Modal
      visible
      hardwareAccelerated
      animationType="none"
      onRequestClose={() => fail('导出已取消')}
    >
      <View style={[styles.modal, { backgroundColor: colors.background }]}>
        <Text style={styles.title}>
          {index < 0
            ? '正在排版长图…'
            : `正在截取内容 ${index + 1} / ${pages.current.length}`}
        </Text>
        <View
          ref={surface}
          collapsable={false}
          onLayout={(event) =>
            setMeasuredSize({
              width: event.nativeEvent.layout.width,
              height: event.nativeEvent.layout.height,
            })
          }
          style={{ width: request.width, height, backgroundColor: '#ffffff' }}
        >
          <WebView
            ref={webview}
            source={htmlSource}
            originWhitelist={['*']}
            onShouldStartLoadWithRequest={(navigation) =>
              navigation.url === 'about:blank'
            }
            injectedJavaScript={imageMeasurementScript(request.height)}
            onMessage={onMessage}
            onError={() => fail()}
            onContentProcessDidTerminate={() => fail()}
            onRenderProcessGone={() => {
              fail();
            }}
            javaScriptEnabled
            domStorageEnabled={false}
            sharedCookiesEnabled={false}
            thirdPartyCookiesEnabled={false}
            allowFileAccess={false}
            scrollEnabled={false}
            textZoom={100}
            setSupportMultipleWindows={false}
            style={{ flex: 1, backgroundColor: '#ffffff' }}
          />
        </View>
        <BouncyButton
          accessibilityRole="button"
          accessibilityLabel="取消长图生成"
          onPress={() => fail('导出已取消')}
          style={styles.cancel}
        >
          <Text type="primary">取消</Text>
        </BouncyButton>
      </View>
    </Modal>
  );
}

export function useImageExport() {
  const dimensions = useWindowDimensions();
  const pending = useRef<CaptureRequest | null>(null);
  const [request, setRequest] = useState<CaptureRequest | null>(null);
  const capture = useCallback(
    (html: string, context: ExportTaskContext): Promise<readonly string[]> => {
      if (Platform.OS === 'web')
        return Promise.reject(
          new ContentExportError('长图导出请使用 Android 或 iOS 应用'),
        );
      if (pending.current)
        return Promise.reject(new ContentExportError('已有长图任务正在运行'));
      context.assertActive();
      const width = Math.floor(Math.min(dimensions.width - 32, 540));
      const height = Math.floor(Math.min(dimensions.height - 200, 1000));
      if (
        !Number.isFinite(dimensions.width) ||
        !Number.isFinite(dimensions.height) ||
        width < 100 ||
        height < 100
      )
        return Promise.reject(
          new ContentExportError(
            '当前窗口尺寸不足以生成长图，请放大窗口或旋转屏幕后重试',
          ),
        );
      return new Promise((resolve, reject) => {
        const finish = () => {
          pending.current = null;
          setRequest(null);
        };
        const next: CaptureRequest = {
          html,
          context,
          width,
          height,
          resolve: (uris) => {
            finish();
            resolve(uris);
          },
          reject: (error) => {
            finish();
            reject(error);
          },
        };
        pending.current = next;
        setRequest(next);
      });
    },
    [dimensions.width, dimensions.height],
  );
  return {
    capture,
    renderer: request ? <ImageExportSurface request={request} /> : null,
  };
}

const styles = StyleSheet.create({
  modal: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
    gap: 16,
  },
  title: { fontSize: 16, fontWeight: '600' },
  cancel: { padding: 12, minHeight: 44 },
});
