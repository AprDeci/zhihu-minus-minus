import { act, renderHook, waitFor } from '@testing-library/react-native';
import {
  type PreparedExportAssets,
  prepareExportAssets,
} from '../features/content-export/assets';
import {
  cleanupExpiredExports,
  createExportDirectory,
  discardExportDirectory,
  writeTextExport,
} from '../features/content-export/files';
import { resolveExportSource } from '../features/content-export/resolveSource';
import {
  serializeExportHtml,
  serializeExportMarkdown,
} from '../features/content-export/serializers';
import type {
  ExportResult,
  ExportSource,
  ExportTarget,
} from '../features/content-export/types';
import { useContentExport } from '../features/content-export/useContentExport';

jest.mock('../features/content-export/assets', () => ({
  prepareExportAssets: jest.fn(),
}));
jest.mock('../features/content-export/files', () => ({
  cleanupExpiredExports: jest.fn(),
  createExportDirectory: jest.fn(),
  discardExportDirectory: jest.fn(),
  writeTextExport: jest.fn(),
  writePdfExport: jest.fn(),
  writeImageExport: jest.fn(),
}));
jest.mock('../features/content-export/resolveSource', () => ({
  resolveExportSource: jest.fn(),
}));
jest.mock('../features/content-export/serializers', () => ({
  serializeExportHtml: jest.fn(),
  serializeExportMarkdown: jest.fn(),
}));
jest.mock('../features/content-export/ImageExportRenderer', () => ({
  releaseImageCaptures: jest.fn(),
}));
let mockSessionVersion = 8;
jest.mock('../store/useAuthStore', () => ({
  getAuthSessionVersion: () => mockSessionVersion,
}));

const target: ExportTarget = { type: 'article', id: '123', sessionVersion: 8 };
const assets: PreparedExportAssets = {
  htmlAssets: new Map(),
  markdownAssets: new Map(),
  files: [],
  warnings: [],
  offline: true,
};
const options = { includeImages: true };
const capture = jest.fn(async () => ['file:///test/capture.png']);
function source(value: ExportTarget = target): ExportSource {
  return {
    target: value,
    title: `合成文章${value.id}`,
    sourceUrl: `https://zhuanlan.zhihu.com/p/${value.id}`,
    document: { id: 'doc', blocks: [] },
    completeness: 'complete',
    warnings: [],
  };
}
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function setup() {
  const host = await renderHook(
    ({ selected, active }: { selected: ExportTarget; active: boolean }) =>
      useContentExport(selected, active, capture),
    { initialProps: { selected: target, active: true } },
  );
  await waitFor(() =>
    expect(host.result.current.source?.target.id).toBe('123'),
  );
  return host;
}

beforeEach(() => {
  jest.resetAllMocks();
  mockSessionVersion = 8;
  jest.mocked(cleanupExpiredExports).mockResolvedValue(undefined);
  jest.mocked(discardExportDirectory).mockResolvedValue(undefined);
  jest
    .mocked(resolveExportSource)
    .mockImplementation(async (value) => source(value));
  let directoryIndex = 0;
  jest
    .mocked(createExportDirectory)
    .mockImplementation(
      async () => `file:///test/exports/job-${++directoryIndex}/`,
    );
  jest.mocked(prepareExportAssets).mockResolvedValue(assets);
  jest.mocked(serializeExportHtml).mockImplementation((value) =>
    JSON.stringify({
      title: value.title,
      completeness: value.completeness,
      warnings: value.warnings,
    }),
  );
  jest.mocked(serializeExportMarkdown).mockImplementation((value) =>
    JSON.stringify({
      title: value.title,
      completeness: value.completeness,
      warnings: value.warnings,
    }),
  );
  jest.mocked(writeTextExport).mockImplementation(async (value) => ({
    directory: value.directory,
    files: [
      {
        name: 'export.html',
        uri: `${value.directory}export.html`,
        mimeType: 'text/html',
      },
    ],
    warnings: value.warnings ?? [],
  }));
});

test('late prepared assets cannot overwrite a newer export after cancellation', async () => {
  const firstAssets = deferred<PreparedExportAssets>();
  jest.mocked(prepareExportAssets).mockReturnValueOnce(firstAssets.promise);
  const host = await setup();
  let first: Promise<void> = Promise.resolve();
  await act(async () => {
    first = host.result.current.generate('html', options);
  });
  expect(prepareExportAssets).toHaveBeenCalledTimes(1);
  const oldContext = jest.mocked(prepareExportAssets).mock.calls[0][2];
  await act(async () => {
    host.result.current.resetOutput();
  });
  expect(oldContext.signal.aborted).toBe(true);
  await act(async () => {
    await host.result.current.generate('html', options);
  });
  const newResult = host.result.current.result;
  expect(newResult?.directory).toBe('file:///test/exports/job-2/');
  await act(async () => {
    firstAssets.resolve(assets);
    await first;
  });
  expect(host.result.current.result).toBe(newResult);
  expect(writeTextExport).toHaveBeenCalledTimes(1);
  expect(discardExportDirectory).toHaveBeenCalledWith(
    'file:///test/exports/job-1/',
  );
  expect(discardExportDirectory).not.toHaveBeenCalledWith(
    'file:///test/exports/job-2/',
  );
  expect(host.result.current.error).toBeUndefined();
});

test('late source details cannot replace the selected content after reopening', async () => {
  const firstSource = deferred<ExportSource>();
  jest.mocked(resolveExportSource).mockReturnValueOnce(firstSource.promise);
  const host = await renderHook(
    ({ selected }: { selected: ExportTarget }) =>
      useContentExport(selected, true, capture),
    { initialProps: { selected: target } },
  );
  const nextTarget = { ...target, id: '456' };
  await host.rerender({ selected: nextTarget });
  await waitFor(() =>
    expect(host.result.current.source?.target.id).toBe('456'),
  );
  await act(async () => {
    firstSource.resolve(source());
  });
  expect(host.result.current.source?.target.id).toBe('456');
});

test.each([
  'html',
  'markdown',
] as const)('embeds partial-body and missing-image warnings after explicit %s continuation', async (format) => {
  jest.mocked(resolveExportSource).mockResolvedValue({
    ...source(),
    completeness: 'partial',
    warnings: ['正文尚未完整获取'],
  });
  jest.mocked(prepareExportAssets).mockResolvedValue({
    ...assets,
    offline: false,
    warnings: ['1 个图片资源未能获取'],
  });
  const host = await setup();
  await act(async () => {
    await host.result.current.generate(format, options);
  });
  expect(host.result.current.missing).toEqual(['1 个图片资源未能获取']);
  expect(writeTextExport).not.toHaveBeenCalled();
  await act(async () => {
    host.result.current.continueWithoutImages();
  });
  await waitFor(() => expect(host.result.current.result).not.toBeNull());
  const request = jest.mocked(writeTextExport).mock.calls[0][0];
  expect(JSON.parse(request.content)).toMatchObject({
    completeness: 'partial',
    warnings: ['正文尚未完整获取', '1 个图片资源未能获取'],
  });
  expect(request.warnings).toEqual([
    '正文尚未完整获取',
    '1 个图片资源未能获取',
  ]);
});

test('a finished result context becomes unusable on account change and after closing and reopening', async () => {
  const host = await setup();
  await act(async () => {
    await host.result.current.generate('html', options);
  });
  const context = host.result.current.resultContext();
  expect(() => context.assertActive()).not.toThrow();
  mockSessionVersion = 9;
  expect(() => context.assertActive()).toThrow('账号已切换');
  mockSessionVersion = 8;
  await host.rerender({ selected: target, active: false });
  expect(() => context.assertActive()).toThrow('文件已失效');
  await host.rerender({ selected: target, active: true });
  await waitFor(() => expect(host.result.current.source).not.toBeNull());
  expect(host.result.current.result).toBeNull();
  expect(() => context.assertActive()).toThrow('文件已失效');
  expect(discardExportDirectory).toHaveBeenCalledWith(
    'file:///test/exports/job-1/',
  );
});

test('rapid repeated generation starts only one task', async () => {
  const preparing = deferred<PreparedExportAssets>();
  jest.mocked(prepareExportAssets).mockReturnValueOnce(preparing.promise);
  const host = await setup();
  let first: Promise<void> = Promise.resolve();
  let second: Promise<void> = Promise.resolve();
  await act(async () => {
    first = host.result.current.generate('html', options);
    second = host.result.current.generate('html', options);
  });
  expect(createExportDirectory).toHaveBeenCalledTimes(1);
  expect(prepareExportAssets).toHaveBeenCalledTimes(1);
  await act(async () => {
    preparing.resolve(assets);
    await Promise.all([first, second]);
  });
  expect(writeTextExport).toHaveBeenCalledTimes(1);
});

test('changing export options invalidates the old file and cleans its directory', async () => {
  const host = await setup();
  await act(async () => {
    await host.result.current.generate('html', options);
  });
  const oldContext = host.result.current.resultContext();
  await act(async () => {
    host.result.current.resetOutput();
  });
  expect(host.result.current.result).toBeNull();
  expect(() => oldContext.assertActive()).toThrow('文件已失效');
  expect(discardExportDirectory).toHaveBeenCalledWith(
    'file:///test/exports/job-1/',
  );
  await act(async () => {
    await host.result.current.generate('html', { includeImages: false });
  });
  expect(prepareExportAssets).toHaveBeenLastCalledWith(
    expect.any(Object),
    false,
    expect.any(Object),
  );
  expect(host.result.current.result?.directory).toBe(
    'file:///test/exports/job-2/',
  );
});

test('late file writes cannot publish results after unmounting', async () => {
  const writing = deferred<ExportResult>();
  jest.mocked(writeTextExport).mockReturnValueOnce(writing.promise);
  const host = await setup();
  let generation: Promise<void> = Promise.resolve();
  await act(async () => {
    generation = host.result.current.generate('html', options);
  });
  const resultContext = host.result.current.resultContext();
  await host.unmount();
  writing.resolve({
    directory: 'file:///test/exports/job-1/',
    files: [],
    warnings: [],
  });
  await generation;
  expect(() => resultContext.assertActive()).toThrow('文件已失效');
  expect(discardExportDirectory).toHaveBeenCalledWith(
    'file:///test/exports/job-1/',
  );
});
