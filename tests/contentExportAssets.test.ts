import { fetch as fetchResource } from 'expo/fetch';
import {
  collectExportResources,
  EXPORT_ASSET_LIMITS,
  prepareExportAssets,
} from '../features/content-export/assets';
import { ContentExportError } from '../features/content-export/errors';
import type {
  ExportSource,
  ExportTaskContext,
} from '../features/content-export/types';
import type { ZhihuBlock } from '../features/rich-content';

jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const image = (id: string): ZhihuBlock => ({
  type: 'image',
  id,
  resource: { mediaType: 'image', url: `https://pic.zhimg.com/${id}.png` },
});
const source = (blocks: readonly ZhihuBlock[]): ExportSource => ({
  target: { type: 'answer', id: '1', sessionVersion: 0 },
  title: '测试内容',
  sourceUrl: 'https://www.zhihu.com/answer/1',
  completeness: 'complete',
  warnings: [],
  document: { id: 'document', blocks },
});
const context = (controller = new AbortController()): ExportTaskContext => ({
  signal: controller.signal,
  assertActive: jest.fn(),
  onProgress: jest.fn(),
});

function response(chunks: readonly Uint8Array[] = [png], size?: number) {
  let index = 0;
  const reader = {
    read: jest.fn(async () =>
      index < chunks.length
        ? { done: false, value: chunks[index++] }
        : { done: true, value: undefined },
    ),
    cancel: jest.fn(async () => undefined),
  };
  return {
    ok: true,
    headers: { get: () => (size === undefined ? null : String(size)) },
    body: { getReader: () => reader, cancel: jest.fn(async () => undefined) },
  } as unknown as Awaited<ReturnType<typeof fetchResource>>;
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(fetchResource).mockImplementation(async () => response());
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

test('collects nested resources, footnotes, card and video posters, deduplicating public URLs', () => {
  const input = source([
    image('body'),
    {
      type: 'video',
      id: 'v',
      url: 'https://www.zhihu.com/zvideo/1',
      poster: { mediaType: 'image', url: 'https://pic.zhimg.com/video.png' },
    },
    {
      type: 'linkCard',
      id: 'c',
      url: 'https://www.zhihu.com/question/1',
      title: '卡片',
      image: { mediaType: 'image', url: 'https://pic.zhimg.com/card.png' },
    },
    {
      type: 'quote',
      id: 'q',
      blocks: [
        {
          type: 'list',
          id: 'l',
          ordered: true,
          items: [{ id: 'i', blocks: [image('nested')] }],
        },
      ],
    },
    {
      type: 'table',
      id: 'table',
      body: [
        {
          id: 'row',
          cells: [{ id: 'cell', isHeader: false, blocks: [image('cell')] }],
        },
      ],
    },
    {
      type: 'blockFormula',
      id: 'f',
      formula: {
        image: { mediaType: 'image', url: 'https://pic.zhimg.com/formula.png' },
      },
    },
    {
      type: 'blockFormula',
      id: 'lf',
      formula: {
        latex: 'x^2',
        image: {
          mediaType: 'image',
          url: 'https://pic.zhimg.com/unneeded.png',
        },
      },
    },
    {
      type: 'paragraph',
      id: 'p',
      children: [
        {
          type: 'inlineImage',
          id: 'ii',
          resource: {
            mediaType: 'image',
            url: 'https://pic.zhimg.com/body.png?token=synthetic',
          },
        },
      ],
    },
  ]);
  const resources = collectExportResources(
    {
      ...input,
      document: {
        ...input.document,
        footnotes: [{ id: 'fn', label: '1', blocks: [image('footnote')] }],
      },
    },
    true,
  );
  expect(resources.map((item) => item.url)).toEqual([
    'https://pic.zhimg.com/body.png',
    'https://pic.zhimg.com/video.png',
    'https://pic.zhimg.com/card.png',
    'https://pic.zhimg.com/nested.png',
    'https://pic.zhimg.com/cell.png',
    'https://pic.zhimg.com/formula.png',
    'https://pic.zhimg.com/footnote.png',
  ]);
  expect(resources[0].sourceUrls).toHaveLength(2);
  expect(collectExportResources(input, false).map((item) => item.url)).toEqual([
    'https://pic.zhimg.com/formula.png',
  ]);
});

test('downloads without authentication and maps raster resources to data and relative paths', async () => {
  const input = source([
    {
      type: 'image',
      id: 'i',
      resource: {
        mediaType: 'image',
        url: 'https://pic.zhimg.com/body.png?token=synthetic#fragment',
      },
    },
  ]);
  const task = context();
  const result = await prepareExportAssets(input, true, task);
  expect(fetchResource).toHaveBeenCalledWith(
    'https://pic.zhimg.com/body.png',
    expect.objectContaining({
      credentials: 'omit',
      redirect: 'error',
      headers: { Accept: 'image/png,image/jpeg,image/gif,image/webp' },
    }),
  );
  expect(
    result.htmlAssets.get(
      input.document.blocks[0].type === 'image'
        ? input.document.blocks[0].resource.url
        : '',
    ),
  ).toBe('data:image/png;base64,iVBORw0KGgoA');
  expect(result.markdownAssets.get('https://pic.zhimg.com/body.png')).toBe(
    'assets/asset-1.png',
  );
  expect(result.files).toEqual([{ path: 'assets/asset-1.png', bytes: png }]);
  expect(result.offline).toBe(true);
  expect(task.onProgress).toHaveBeenLastCalledWith({
    phase: 'assets',
    completed: 1,
    total: 1,
  });
});

test('warns for missing or unsafe resources without copying network errors', async () => {
  jest
    .mocked(fetchResource)
    .mockRejectedValueOnce(
      new Error('https://private.invalid/?cookie=synthetic'),
    );
  const result = await prepareExportAssets(
    source([
      image('fail'),
      {
        type: 'image',
        id: 'local',
        resource: { mediaType: 'image', url: 'file:///private/synthetic' },
      },
    ]),
    true,
    context(),
  );
  expect(fetchResource).toHaveBeenCalledTimes(1);
  expect(result.warnings).toEqual([
    '2 个图片资源未能获取，将使用占位说明；可重试或缺图导出。',
  ]);
  expect(result.offline).toBe(false);
  expect(result.files).toEqual([]);
});

test('validates and packages already embedded raster images without a network request', async () => {
  const url = 'data:image/png;base64,iVBORw0KGgoA';
  const input = source([
    { type: 'image', id: 'data', resource: { mediaType: 'image', url } },
  ]);
  const result = await prepareExportAssets(input, true, context());
  expect(fetchResource).not.toHaveBeenCalled();
  expect(result.offline).toBe(true);
  expect(result.htmlAssets.get(url)).toBe(url);
  expect(result.markdownAssets.get(url)).toBe('assets/asset-1.png');
  expect(result.files[0].bytes).toEqual(png);
  jest.replaceProperty(EXPORT_ASSET_LIMITS, 'perAssetBytes', 8);
  await expect(
    prepareExportAssets(input, true, context()),
  ).rejects.toMatchObject({ code: 'resource-limit' });
});

test('does not embed SVG or HTML even if its URL looks like a PNG', async () => {
  jest
    .mocked(fetchResource)
    .mockResolvedValueOnce(response([new Uint8Array([60, 115, 118, 103, 62])]));
  const result = await prepareExportAssets(
    source([image('fake')]),
    true,
    context(),
  );
  expect(result.files).toEqual([]);
  expect(result.warnings).toHaveLength(1);
});

test('refuses excess resources before starting network activity', async () => {
  await expect(
    prepareExportAssets(
      source(
        Array.from({ length: EXPORT_ASSET_LIMITS.count + 1 }, (_, index) =>
          image(String(index)),
        ),
      ),
      true,
      context(),
    ),
  ).rejects.toMatchObject({ code: 'resource-limit' });
  expect(fetchResource).not.toHaveBeenCalled();
});

test('enforces declared and streamed per-resource byte limits', async () => {
  jest
    .mocked(fetchResource)
    .mockResolvedValueOnce(
      response([png], EXPORT_ASSET_LIMITS.perAssetBytes + 1),
    );
  await expect(
    prepareExportAssets(source([image('huge')]), true, context()),
  ).rejects.toMatchObject({ code: 'resource-limit' });
  jest.replaceProperty(EXPORT_ASSET_LIMITS, 'perAssetBytes', 8);
  await expect(
    prepareExportAssets(source([image('stream')]), true, context()),
  ).rejects.toMatchObject({ code: 'resource-limit' });
});

test('enforces a shared streamed byte budget across workers', async () => {
  jest.replaceProperty(EXPORT_ASSET_LIMITS, 'totalBytes', 20);
  await expect(
    prepareExportAssets(
      source([image('a'), image('b'), image('c')]),
      true,
      context(),
    ),
  ).rejects.toMatchObject({ code: 'resource-limit' });
});

test('limits concurrent requests and aborts pending fetches without waiting for native completion', async () => {
  const signals: (AbortSignal | null | undefined)[] = [];
  jest.mocked(fetchResource).mockImplementation((_url, options) => {
    signals.push(options?.signal);
    return new Promise(() => {});
  });
  const controller = new AbortController();
  const pending = prepareExportAssets(
    source(Array.from({ length: 8 }, (_, index) => image(String(index)))),
    true,
    context(controller),
  );
  expect(fetchResource).toHaveBeenCalledTimes(3);
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  expect(signals.every((signal) => signal?.aborted)).toBe(true);
});

test('returns a resource warning after timeout even if native fetch ignores abort', async () => {
  jest.useFakeTimers();
  jest.mocked(fetchResource).mockImplementation(() => new Promise(() => {}));
  const pending = prepareExportAssets(source([image('slow')]), true, context());
  await jest.advanceTimersByTimeAsync(EXPORT_ASSET_LIMITS.timeoutMs);
  await expect(pending).resolves.toMatchObject({ offline: false, files: [] });
});

test('does not return downloaded data after the originating account changes', async () => {
  const task = context();
  jest.mocked(fetchResource).mockImplementationOnce(async () => {
    jest.mocked(task.assertActive).mockImplementation(() => {
      throw new ContentExportError('账号已切换');
    });
    return response();
  });
  await expect(
    prepareExportAssets(source([image('late')]), true, task),
  ).rejects.toThrow('账号已切换');
});
