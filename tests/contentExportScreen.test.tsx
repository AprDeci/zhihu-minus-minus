import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { Platform } from 'react-native';
import type { WebViewProps } from 'react-native-webview';
import { ContentExportScreen } from '../features/content-export/ContentExportScreen';
import { ContentExportError } from '../features/content-export/errors';
import {
  saveExport,
  saveExportImages,
  shareExport,
} from '../features/content-export/files';
import type {
  ExportResult,
  ExportSource,
  ExportTarget,
  ExportTaskContext,
} from '../features/content-export/types';
import type { useContentExport } from '../features/content-export/useContentExport';

let mockJob: ReturnType<typeof useContentExport>;
const mockColors = {
  background: '#ffffff',
  backgroundSecondary: '#eeeeee',
  text: '#111111',
  textSecondary: '#555555',
  link: '#0055aa',
  border: '#cccccc',
  primary: '#0055aa',
  onPrimary: '#ffffff',
};
const mockCapture = jest.fn();
jest.mock('../features/content-export/useContentExport', () => ({
  useContentExport: () => mockJob,
  exportErrorMessage: (error: unknown, fallback: string) => {
    const { ContentExportError } = jest.requireActual(
      '../features/content-export/errors',
    );
    return error instanceof ContentExportError
      ? (error as Error).message
      : fallback;
  },
}));
jest.mock('../features/content-export/ImageExportRenderer', () => ({
  useImageExport: () => ({ capture: mockCapture, renderer: null }),
}));
jest.mock('../features/content-export/files', () => ({
  saveExport: jest.fn(),
  saveExportImages: jest.fn(),
  shareExport: jest.fn(),
}));
jest.mock('../features/content-export/serializers', () => ({
  serializeExportHtml: () => '<p>合成正文预览</p>',
  serializeExportMarkdown: () => '合成正文预览',
}));
jest.mock('../components/BouncyButton', () => ({
  BouncyButton: jest.requireActual('react-native').Pressable,
}));
jest.mock('../components/Themed', () => ({
  Text: jest.requireActual('react-native').Text,
  useRuntimeThemeColors: () => mockColors,
}));
jest.mock('../store/useSettingsStore', () => ({
  useSettingsStore: (
    selector: (state: {
      fontSizeScale: number;
      lineHeightScale: number;
    }) => unknown,
  ) => selector({ fontSizeScale: 1.2, lineHeightScale: 1.7 }),
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('react-native-webview', () => {
  const react = jest.requireActual<typeof import('react')>('react');
  const native =
    jest.requireActual<typeof import('react-native')>('react-native');
  return {
    WebView: (props: WebViewProps) =>
      react.createElement(native.View, {
        ...props,
        testID: 'export-preview-webview',
      }),
  };
});
jest.mock('@expo/vector-icons/Ionicons', () => () => null);

const target: ExportTarget = { type: 'answer', id: '123', sessionVersion: 7 };
const source: ExportSource = {
  target,
  title: '合成问题',
  author: '合成作者',
  sourceUrl: 'https://www.zhihu.com/answer/123',
  document: { id: 'doc', blocks: [] },
  completeness: 'complete',
  warnings: [],
};
const output: ExportResult = {
  directory: 'file:///test/export/',
  files: [
    {
      name: '合成问题.html',
      uri: 'file:///test/export/合成问题.html',
      mimeType: 'text/html',
    },
  ],
  warnings: [],
};
let context: ExportTaskContext;
async function setup() {
  return render(<ContentExportScreen target={target} active />);
}

beforeEach(() => {
  jest.clearAllMocks();
  context = { signal: new AbortController().signal, assertActive: jest.fn() };
  mockJob = {
    source,
    reading: false,
    progress: null,
    error: undefined,
    missing: [],
    result: null,
    generate: jest.fn(async () => {}),
    continueWithoutImages: jest.fn(),
    resetOutput: jest.fn(),
    resultContext: jest.fn(() => context),
    retrySource: jest.fn(),
  };
  jest.mocked(saveExport).mockResolvedValue(true);
  jest.mocked(shareExport).mockResolvedValue(undefined);
  jest.mocked(saveExportImages).mockResolvedValue(undefined);
});
afterEach(() => jest.restoreAllMocks());

test('requires partial-content consent before generating the selected format', async () => {
  mockJob.source = {
    ...source,
    completeness: 'partial',
    warnings: ['仅有已读取正文'],
  };
  const host = await setup();
  expect(host.getByText('当前仅有部分正文', { exact: false })).toBeTruthy();
  const generate = host.getByRole('button', { name: '生成 Markdown' });
  expect(generate).toBeDisabled();
  await fireEvent.press(generate);
  expect(mockJob.generate).not.toHaveBeenCalled();
  await fireEvent(host.getByLabelText('允许导出部分内容'), 'valueChange', true);
  await fireEvent.press(host.getByRole('radio', { name: 'HTML' }));
  expect(host.getByRole('button', { name: '生成 HTML' })).toBeEnabled();
  await fireEvent.press(host.getByRole('button', { name: '生成 HTML' }));
  expect(mockJob.generate).toHaveBeenCalledWith(
    'html',
    expect.objectContaining({ includeImages: true }),
  );
});

test('missing-image actions retry preparation or explicitly continue the pending export', async () => {
  mockJob.missing = ['1 个图片未能获取'];
  const host = await setup();
  expect(host.getByText('部分图片未能准备好')).toBeTruthy();
  expect(host.queryByRole('button', { name: '生成 Markdown' })).toBeNull();
  await fireEvent.press(host.getByRole('button', { name: '重新准备' }));
  expect(mockJob.generate).toHaveBeenCalledWith(
    'markdown',
    expect.objectContaining({ includeImages: true }),
  );
  await fireEvent.press(host.getByRole('button', { name: '继续缺图导出' }));
  expect(mockJob.continueWithoutImages).toHaveBeenCalledTimes(1);
});

test('changing format or image options invalidates the previous output', async () => {
  mockJob.result = output;
  const host = await setup();
  await fireEvent.press(host.getByRole('radio', { name: 'PDF' }));
  expect(mockJob.resetOutput).toHaveBeenCalledTimes(1);
  await fireEvent(host.getByLabelText('包含正文图片'), 'valueChange', false);
  expect(mockJob.resetOutput).toHaveBeenCalledTimes(2);
  await fireEvent(host.getByLabelText('跟随阅读设置'), 'valueChange', true);
  expect(mockJob.resetOutput).toHaveBeenCalledTimes(3);
});

test('completed files expose working save and share controls', async () => {
  jest.replaceProperty(Platform, 'OS', 'android');
  mockJob.result = output;
  const host = await setup();
  expect(host.getByText('文件已生成')).toBeTruthy();
  expect(host.getByText('合成问题.html')).toBeTruthy();
  await fireEvent.press(host.getByRole('button', { name: '保存到文件' }));
  await waitFor(() => expect(saveExport).toHaveBeenCalledWith(output, context));
  expect(host.getByText('文件已保存到所选目录')).toBeTruthy();
  await fireEvent.press(host.getByRole('button', { name: '分享文件' }));
  await waitFor(() =>
    expect(shareExport).toHaveBeenCalledWith(output, context),
  );
  expect(host.getByText('已打开系统分享')).toBeTruthy();
});

test('Android save cancellation is not reported as a successful save', async () => {
  jest.replaceProperty(Platform, 'OS', 'android');
  mockJob.result = output;
  jest.mocked(saveExport).mockResolvedValue(false);
  const host = await setup();
  await fireEvent.press(host.getByRole('button', { name: '保存到文件' }));
  await waitFor(() => expect(host.getByText('已取消保存')).toBeTruthy());
  expect(host.queryByText('文件已保存到所选目录')).toBeNull();
});

test('iOS save describes opening the system panel without claiming the file was saved', async () => {
  jest.replaceProperty(Platform, 'OS', 'ios');
  mockJob.result = output;
  const host = await setup();
  await fireEvent.press(host.getByRole('button', { name: '保存到文件' }));
  await waitFor(() =>
    expect(host.getByText('已打开系统保存/分享面板')).toBeTruthy(),
  );
  expect(host.queryByText('文件已保存到所选目录')).toBeNull();
});

test.each([
  '保存到文件',
  '分享文件',
])('a %s failure clears success notices and never displays native exception details', async (label) => {
  mockJob.result = output;
  const operation = label === '保存到文件' ? saveExport : shareExport;
  jest
    .mocked(operation)
    .mockRejectedValue(new Error('synthetic-private-native-config'));
  const host = await setup();
  await fireEvent.press(host.getByRole('button', { name: label }));
  await waitFor(() =>
    expect(host.getByText('保存或分享失败，请重试')).toBeTruthy(),
  );
  expect(host.queryByText('synthetic-private-native-config')).toBeNull();
  expect(host.queryByText('文件已保存到所选目录')).toBeNull();
  expect(host.queryByText('已打开系统分享')).toBeNull();
});

test('an expired result cannot reach the system save or share operation', async () => {
  mockJob.result = output;
  jest.mocked(context.assertActive).mockImplementation(() => {
    throw new ContentExportError('文件已失效，请重新生成');
  });
  const host = await setup();
  await fireEvent.press(host.getByRole('button', { name: '分享文件' }));
  await waitFor(() =>
    expect(host.getByText('文件已失效，请重新生成')).toBeTruthy(),
  );
  expect(shareExport).not.toHaveBeenCalled();
  expect(saveExport).not.toHaveBeenCalled();
});

test('delivery locks format controls and prevents a second operation until completion', async () => {
  mockJob.result = output;
  let done: () => void = () => {};
  jest.mocked(shareExport).mockReturnValue(
    new Promise<void>((resolve) => {
      done = resolve;
    }),
  );
  const host = await setup();
  await fireEvent.press(host.getByRole('button', { name: '分享文件' }));
  expect(host.getByRole('button', { name: '保存到文件' })).toBeDisabled();
  expect(host.getByRole('radio', { name: 'PDF' })).toBeDisabled();
  await fireEvent.press(host.getByRole('button', { name: '分享文件' }));
  await fireEvent.press(host.getByRole('button', { name: '保存到文件' }));
  expect(shareExport).toHaveBeenCalledTimes(1);
  expect(saveExport).not.toHaveBeenCalled();
  await act(async () => {
    done();
  });
  expect(host.getByRole('button', { name: '保存到文件' })).toBeEnabled();
});

test.each([
  1, 2,
])('merged long-image output can save all %i files to the photo library', async (count) => {
  const host = await setup();
  await fireEvent.press(host.getByRole('radio', { name: '长图' }));
  mockJob.result = {
    ...output,
    files: Array.from({ length: count }, (_, index) => ({
      name: `合成问题-${index + 1}.png`,
      uri: `file:///test/export/${index + 1}.png`,
      mimeType: 'image/png',
    })),
  };
  await host.rerender(<ContentExportScreen target={target} active />);
  expect(
    host.getByText(
      count === 1 ? '已自动合并为一张长图' : '内容较长，已自动合并为 2 张长图',
    ),
  ).toBeTruthy();
  await fireEvent.press(
    host.getByRole('button', {
      name: count === 1 ? '保存到相册' : '全部保存到相册',
    }),
  );
  await waitFor(() =>
    expect(saveExportImages).toHaveBeenCalledWith(mockJob.result, context),
  );
  expect(host.getByText('图片已保存到相册')).toBeTruthy();
});

test('revoking partial-content consent also prevents retrying or continuing a pending missing-image export', async () => {
  mockJob.source = { ...source, completeness: 'partial' };
  const host = await setup();
  await fireEvent(host.getByLabelText('允许导出部分内容'), 'valueChange', true);
  mockJob.missing = ['1 个图片未能获取'];
  await host.rerender(<ContentExportScreen target={target} active />);
  await fireEvent(
    host.getByLabelText('允许导出部分内容'),
    'valueChange',
    false,
  );
  expect(host.getByRole('button', { name: '重新准备' })).toBeDisabled();
  expect(host.getByRole('button', { name: '继续缺图导出' })).toBeDisabled();
  await fireEvent.press(host.getByRole('button', { name: '重新准备' }));
  await fireEvent.press(host.getByRole('button', { name: '继续缺图导出' }));
  expect(mockJob.generate).not.toHaveBeenCalled();
  expect(mockJob.continueWithoutImages).not.toHaveBeenCalled();
  await fireEvent(host.getByLabelText('允许导出部分内容'), 'valueChange', true);
  await fireEvent.press(host.getByRole('button', { name: '继续缺图导出' }));
  expect(mockJob.continueWithoutImages).toHaveBeenCalledTimes(1);
});

test('Android Markdown preview and its parent both allow nested scrolling without locking generation', async () => {
  jest.replaceProperty(Platform, 'OS', 'android');
  const host = await setup();
  await waitFor(() => expect(host.getByText('合成正文预览')).toBeTruthy());
  const scrollViews = host.container.queryAll((node) =>
    node.type.endsWith('ScrollView'),
  );
  expect(scrollViews).toHaveLength(2);
  for (const scroll of scrollViews) {
    expect(scroll.props.nestedScrollEnabled).toBe(true);
    expect(scroll.props.scrollEnabled).not.toBe(false);
  }
  await fireEvent.press(host.getByRole('button', { name: '生成 Markdown' }));
  expect(mockJob.generate).toHaveBeenCalledWith('markdown', expect.any(Object));
});

test.each([
  { label: 'HTML', format: 'html' },
  { label: 'PDF', format: 'pdf' },
  { label: '长图', format: 'image' },
])('Android $label preview retains the drag gesture inside its WebView', async ({
  label,
  format,
}) => {
  jest.replaceProperty(Platform, 'OS', 'android');
  const host = await setup();
  await fireEvent.press(host.getByRole('radio', { name: label }));
  await waitFor(() =>
    expect(host.getByTestId('export-preview-webview')).toBeTruthy(),
  );
  const webview = host.getByTestId('export-preview-webview');
  // RNCWebView.onTouchEvent uses this flag to prevent parent interception.
  expect(webview.props.nestedScrollEnabled).toBe(true);
  expect(webview.props.scrollEnabled).not.toBe(false);
  expect(
    host.container.queryAll((node) => node.type.endsWith('ScrollView'))[0].props
      .nestedScrollEnabled,
  ).toBe(true);
  await fireEvent.press(host.getByRole('button', { name: `生成 ${label}` }));
  expect(mockJob.generate).toHaveBeenCalledWith(format, expect.any(Object));
});
