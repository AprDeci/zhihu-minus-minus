import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { Dimensions, Platform } from 'react-native';
import { captureRef, releaseCapture } from 'react-native-view-shot';
import type { WebViewMessageEvent, WebViewProps } from 'react-native-webview';
import { useImageExport } from '../features/content-export/ImageExportRenderer';
import type { ExportTaskContext } from '../features/content-export/types';

let mockWebViewProps: WebViewProps | undefined;
const mockInjectJavaScript = jest.fn();
jest.mock('react-native-webview', () => {
  const react = jest.requireActual<typeof import('react')>('react');
  const native =
    jest.requireActual<typeof import('react-native')>('react-native');
  return {
    WebView: react.forwardRef((props: WebViewProps, ref) => {
      mockWebViewProps = props;
      react.useImperativeHandle(ref, () => ({
        injectJavaScript: mockInjectJavaScript,
      }));
      return react.createElement(native.View, { testID: 'export-webview' });
    }),
  };
});
jest.mock('react-native-view-shot', () => ({
  captureRef: jest.fn(),
  releaseCapture: jest.fn(),
}));
jest.mock('../components/Themed', () => ({
  Text: jest.requireActual<typeof import('react-native')>('react-native').Text,
  useRuntimeThemeColors: () => ({ background: '#ffffff' }),
}));
jest.mock('../components/BouncyButton', () => ({
  BouncyButton:
    jest.requireActual<typeof import('react-native')>('react-native').Pressable,
}));

let startCapture: ReturnType<typeof useImageExport>['capture'];
function Host() {
  const exporter = useImageExport();
  startCapture = exporter.capture;
  return exporter.renderer;
}
function context(controller = new AbortController()): ExportTaskContext {
  return {
    signal: controller.signal,
    assertActive: () => {
      if (controller.signal.aborted) throw new Error('cancelled');
    },
  };
}
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function message(value: object) {
  await act(async () => {
    mockWebViewProps?.onMessage?.({
      nativeEvent: { data: JSON.stringify(value) },
    } as WebViewMessageEvent);
  });
}
async function layout(
  host: Awaited<ReturnType<typeof render>>,
  height: number,
  width = 368,
) {
  await fireEvent(host.getByTestId('export-webview'), 'layout', {
    nativeEvent: { layout: { x: 0, y: 0, width, height } },
  });
}
const originalPlatform = Platform.OS;
beforeEach(() => {
  jest.clearAllMocks();
  Platform.OS = 'android';
  Dimensions.set({
    window: { width: 400, height: 800, scale: 2, fontScale: 1 },
    screen: { width: 400, height: 800, scale: 2, fontScale: 1 },
  });
  mockWebViewProps = undefined;
});
afterEach(() => {
  Platform.OS = originalPlatform;
});

test.each([
  { width: 0, height: 800 },
  { width: 32, height: 800 },
  { width: 32.9, height: 800 },
  { width: 131.9, height: 800 },
  { width: Number.NaN, height: 800 },
  { width: Number.POSITIVE_INFINITY, height: 800 },
  { width: Number.NEGATIVE_INFINITY, height: 800 },
  { width: 400, height: 0 },
  { width: 400, height: 200 },
  { width: 400, height: 299.9 },
  { width: 400, height: Number.NaN },
  { width: 400, height: Number.POSITIVE_INFINITY },
  { width: 400, height: Number.NEGATIVE_INFINITY },
])('rejects unsupported window dimensions $width × $height before opening a capture surface', async ({
  width,
  height,
}) => {
  Dimensions.set({ window: { width, height, scale: 2, fontScale: 1 } });
  const host = await render(<Host />);
  await act(async () => {
    await expect(startCapture('<html></html>', context())).rejects.toThrow(
      '当前窗口尺寸不足以生成长图，请放大窗口或旋转屏幕后重试',
    );
  });
  expect(host.queryByTestId('export-webview')).toBeNull();
  expect(captureRef).not.toHaveBeenCalled();
  expect(releaseCapture).not.toHaveBeenCalled();
});

test('an invalid window does not block retrying after its dimensions recover', async () => {
  Dimensions.set({
    window: { width: 400, height: 299, scale: 2, fontScale: 1 },
  });
  const host = await render(<Host />);
  await act(async () => {
    await expect(startCapture('<html></html>', context())).rejects.toThrow(
      '当前窗口尺寸不足',
    );
    Dimensions.set({
      window: { width: 400, height: 800, scale: 2, fontScale: 1 },
    });
  });
  jest.mocked(captureRef).mockResolvedValue('file:///retry.png');
  const resolved = jest.fn();
  const rejected = jest.fn();
  await act(async () => {
    void startCapture('<html></html>', context()).then(resolved, rejected);
    await expect(startCapture('<html></html>', context())).rejects.toThrow(
      '已有长图任务正在运行',
    );
  });
  await message({ type: 'measured', height: 450, boundaries: [] });
  await layout(host, 450);
  await waitFor(() => expect(mockInjectJavaScript).toHaveBeenCalled());
  await message({ type: 'positioned', index: 0 });
  expect(resolved).toHaveBeenCalledWith(['file:///retry.png']);
  expect(rejected).not.toHaveBeenCalled();
  expect(host.queryByTestId('export-webview')).toBeNull();
});

test('allows the minimum supported capture width and page height', async () => {
  Dimensions.set({
    window: { width: 132, height: 300, scale: 2, fontScale: 1 },
  });
  jest.mocked(captureRef).mockResolvedValue('file:///minimum.png');
  const host = await render(<Host />);
  const resolved = jest.fn();
  const rejected = jest.fn();
  await act(async () => {
    void startCapture('<html></html>', context()).then(resolved, rejected);
  });
  await message({ type: 'measured', height: 100, boundaries: [] });
  await layout(host, 100, 100);
  await waitFor(() => expect(mockInjectJavaScript).toHaveBeenCalled());
  await message({ type: 'positioned', index: 0 });
  expect(captureRef).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ width: 200, height: 200 }),
  );
  expect(resolved).toHaveBeenCalledWith(['file:///minimum.png']);
  expect(rejected).not.toHaveBeenCalled();
});

test('waits for native height and positioned acknowledgement, and ignores duplicate capture messages', async () => {
  const frame = deferred<string>();
  jest.mocked(captureRef).mockReturnValue(frame.promise);
  const host = await render(<Host />);
  const resolved = jest.fn();
  const rejected = jest.fn();
  await act(async () => {
    void startCapture('<html></html>', context()).then(resolved, rejected);
  });
  await layout(host, 600);
  await message({ type: 'measured', height: 450, boundaries: [] });
  await message({ type: 'positioned', index: 0 });
  expect(captureRef).not.toHaveBeenCalled();
  await layout(host, 450);
  await waitFor(() => expect(mockInjectJavaScript).toHaveBeenCalled());
  expect(captureRef).not.toHaveBeenCalled();
  await message({ type: 'positioned', index: 0 });
  await message({ type: 'positioned', index: 0 });
  expect(captureRef).toHaveBeenCalledTimes(1);
  await act(async () => {
    frame.resolve('file:///capture.png');
  });
  expect(resolved).toHaveBeenCalledWith(['file:///capture.png']);
  expect(rejected).not.toHaveBeenCalled();
});

test('cancellation releases a capture that finishes after the surface has closed', async () => {
  const frame = deferred<string>();
  jest.mocked(captureRef).mockReturnValue(frame.promise);
  const controller = new AbortController();
  const host = await render(<Host />);
  const resolved = jest.fn();
  const rejected = jest.fn();
  await act(async () => {
    void startCapture('<html></html>', context(controller)).then(
      resolved,
      rejected,
    );
  });
  await message({ type: 'measured', height: 450, boundaries: [] });
  await layout(host, 450);
  await waitFor(() => expect(mockInjectJavaScript).toHaveBeenCalled());
  await message({ type: 'positioned', index: 0 });
  expect(captureRef).toHaveBeenCalledTimes(1);
  await act(async () => {
    controller.abort();
  });
  expect(rejected).toHaveBeenCalledTimes(1);
  await act(async () => {
    frame.resolve('file:///late-capture.png');
  });
  expect(releaseCapture).toHaveBeenCalledWith('file:///late-capture.png');
  expect(resolved).not.toHaveBeenCalled();
});

test('an abort between scheduling capture and mounting the surface rejects immediately', async () => {
  const controller = new AbortController();
  await render(<Host />);
  const rejected = jest.fn();
  await act(async () => {
    void startCapture('<html></html>', context(controller)).catch(rejected);
    controller.abort();
  });
  expect(rejected).toHaveBeenCalledTimes(1);
  expect(captureRef).not.toHaveBeenCalled();
});

test('stale positioned messages cannot capture the next page', async () => {
  jest
    .mocked(captureRef)
    .mockResolvedValueOnce('file:///first.png')
    .mockResolvedValueOnce('file:///second.png');
  const host = await render(<Host />);
  const resolved = jest.fn();
  await act(async () => {
    void startCapture('<html></html>', context()).then(resolved, () => {});
  });
  await message({ type: 'measured', height: 1000, boundaries: [550] });
  await layout(host, 550);
  await waitFor(() => expect(mockInjectJavaScript).toHaveBeenCalled());
  await message({ type: 'positioned', index: 0 });
  expect(captureRef).toHaveBeenCalledTimes(1);
  await layout(host, 450);
  await waitFor(() => expect(mockInjectJavaScript).toHaveBeenCalled());
  await message({ type: 'positioned', index: 0 });
  expect(captureRef).toHaveBeenCalledTimes(1);
  await message({ type: 'positioned', index: 1 });
  expect(resolved).toHaveBeenCalledWith([
    'file:///first.png',
    'file:///second.png',
  ]);
});

test.each([
  {
    platform: 'ios',
    density: 2,
    windowWidth: 400,
    windowHeight: 800,
    width: 368,
    height: 600,
    pixelWidth: 736,
    pixelHeight: 1200,
  },
  {
    platform: 'ios',
    density: 3,
    windowWidth: 400,
    windowHeight: 800,
    width: 368,
    height: 600,
    pixelWidth: 736,
    pixelHeight: 1200,
  },
  {
    platform: 'ios',
    density: 2,
    windowWidth: 1200,
    windowHeight: 1600,
    width: 540,
    height: 1000,
    pixelWidth: 1080,
    pixelHeight: 2000,
  },
  {
    platform: 'ios',
    density: 3,
    windowWidth: 1200,
    windowHeight: 1600,
    width: 540,
    height: 1000,
    pixelWidth: 1080,
    pixelHeight: 2000,
  },
  {
    platform: 'android',
    density: 2,
    windowWidth: 1200,
    windowHeight: 1600,
    width: 540,
    height: 1000,
    pixelWidth: 1080,
    pixelHeight: 2000,
  },
  {
    platform: 'android',
    density: 3,
    windowWidth: 1200,
    windowHeight: 1600,
    width: 540,
    height: 1000,
    pixelWidth: 1080,
    pixelHeight: 2000,
  },
] as const)('captures $platform at density $density within pixel limits on a $windowWidth-point screen', async ({
  platform,
  density,
  windowWidth,
  windowHeight,
  width,
  height,
  pixelWidth,
  pixelHeight,
}) => {
  Platform.OS = platform;
  Dimensions.set({
    window: {
      width: windowWidth,
      height: windowHeight,
      scale: density,
      fontScale: 1,
    },
    screen: {
      width: windowWidth,
      height: windowHeight,
      scale: density,
      fontScale: 1,
    },
  });
  jest
    .mocked(captureRef)
    .mockResolvedValueOnce('file:///first.png')
    .mockResolvedValueOnce('file:///second.png');
  const host = await render(<Host />);
  const resolved = jest.fn();
  const rejected = jest.fn();
  await act(async () => {
    void startCapture('<html></html>', context()).then(resolved, rejected);
  });
  await message({
    type: 'measured',
    height: height * 1.5,
    boundaries: [height],
  });
  expect(host.getByText('正在截取内容 1 / 2')).toBeTruthy();
  await layout(host, height, width);
  await waitFor(() => expect(mockInjectJavaScript).toHaveBeenCalled());
  await message({ type: 'positioned', index: 0 });
  expect(host.getByText('正在截取内容 2 / 2')).toBeTruthy();
  await layout(host, height / 2, width);
  await message({ type: 'positioned', index: 1 });
  expect(captureRef).toHaveBeenCalledTimes(2);
  // Match each native backend's interpretation of view-shot's width/height.
  const actualPixels = jest.mocked(captureRef).mock.calls.map(([, options]) => {
    const nativeScale = platform === 'ios' ? density : 1;
    return {
      width: Math.round((options?.width ?? 0) * nativeScale),
      height: Math.round((options?.height ?? 0) * nativeScale),
    };
  });
  expect(actualPixels).toEqual([
    { width: pixelWidth, height: pixelHeight },
    { width: pixelWidth, height: pixelHeight / 2 },
  ]);
  for (const pixels of actualPixels) {
    expect(pixels.width).toBeLessThanOrEqual(1080);
    expect(pixels.height).toBeLessThanOrEqual(2000);
  }
  expect(resolved).toHaveBeenCalledWith([
    'file:///first.png',
    'file:///second.png',
  ]);
  expect(rejected).not.toHaveBeenCalled();
});
