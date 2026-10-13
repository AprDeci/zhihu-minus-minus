import { fetch as fetchResource } from 'expo/fetch';
import type {
  ZhihuBlock,
  ZhihuFormula,
  ZhihuInlineRun,
} from '@/features/rich-content';
import {
  assertExportActive,
  base64ToBytes,
  bytesToBase64,
  ExportIoError,
} from './ioShared';
import { getSafeExportImageUrl } from './safeUrl';
import type { ExportSource, ExportTaskContext } from './types';

export const EXPORT_ASSET_LIMITS = {
  count: 120,
  perAssetBytes: 8 * 1024 * 1024,
  totalBytes: 32 * 1024 * 1024,
  concurrency: 3,
  timeoutMs: 15_000,
} as const;

export interface ExportResource {
  readonly url: string;
  readonly sourceUrls: readonly string[];
}

export interface ExportAssetFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface PreparedExportAssets {
  readonly htmlAssets: ReadonlyMap<string, string>;
  readonly markdownAssets: ReadonlyMap<string, string>;
  readonly files: readonly ExportAssetFile[];
  readonly warnings: readonly string[];
  readonly offline: boolean;
}

/** Walk all semantic resources, including footnotes, cards and formula fallbacks. */
export function collectExportResources(
  source: ExportSource,
  includeImages: boolean,
): ExportResource[] {
  const resources = new Map<string, Set<string>>();
  const add = (raw: string) => {
    const url = getSafeExportImageUrl(raw) ?? raw;
    const aliases = resources.get(url) ?? new Set<string>();
    aliases.add(raw);
    resources.set(url, aliases);
  };
  const formula = (value: ZhihuFormula) => {
    if (!value.latex?.trim() && value.image) add(value.image.url);
  };
  const inline = (runs: readonly ZhihuInlineRun[]) => {
    for (const run of runs) {
      if (run.type === 'inlineImage' && includeImages) add(run.resource.url);
      else if (run.type === 'inlineFormula') formula(run.formula);
      else if ('children' in run) inline(run.children);
    }
  };
  const blocks = (items: readonly ZhihuBlock[]) => {
    for (const block of items) {
      switch (block.type) {
        case 'paragraph':
        case 'heading':
          inline(block.children);
          break;
        case 'image':
          if (includeImages) add(block.resource.url);
          if (block.caption) inline(block.caption);
          break;
        case 'blockFormula':
          formula(block.formula);
          break;
        case 'video':
          if (includeImages && block.poster) add(block.poster.url);
          break;
        case 'linkCard':
          if (includeImages && block.image) add(block.image.url);
          break;
        case 'quote':
          blocks(block.blocks);
          break;
        case 'list':
          for (const item of block.items) blocks(item.blocks);
          break;
        case 'table':
          if (block.caption) inline(block.caption);
          for (const row of [
            ...(block.head ?? []),
            ...block.body,
            ...(block.foot ?? []),
          ]) {
            for (const cell of row.cells) blocks(cell.blocks);
          }
          break;
        default:
          break;
      }
    }
  };
  blocks(source.document.blocks);
  for (const footnote of source.document.footnotes ?? [])
    blocks(footnote.blocks);
  return [...resources].map(([url, aliases]) => ({
    url,
    sourceUrls: [...aliases],
  }));
}

function imageType(
  bytes: Uint8Array,
): { mime: string; extension: string } | null {
  const start = [...bytes.subarray(0, 12)];
  if (
    start[0] === 137 &&
    start.slice(1, 8).join(',') === '80,78,71,13,10,26,10'
  ) {
    return { mime: 'image/png', extension: 'png' };
  }
  if (start[0] === 255 && start[1] === 216 && start[2] === 255) {
    return { mime: 'image/jpeg', extension: 'jpg' };
  }
  const signature = String.fromCharCode(...start);
  if (signature.startsWith('GIF87a') || signature.startsWith('GIF89a')) {
    return { mime: 'image/gif', extension: 'gif' };
  }
  if (signature.startsWith('RIFF') && signature.slice(8, 12) === 'WEBP') {
    return { mime: 'image/webp', extension: 'webp' };
  }
  return null;
}

async function withSignal<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  let abort: (() => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error('resource-interrupted'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race([operation, interrupted]);
  } finally {
    if (abort) signal.removeEventListener('abort', abort);
  }
}

async function downloadResource(
  url: string,
  context: ExportTaskContext,
  batchSignal: AbortSignal,
  consumeBytes: (count: number) => void,
): Promise<Uint8Array> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  context.signal.addEventListener('abort', abort, { once: true });
  batchSignal.addEventListener('abort', abort, { once: true });
  if (context.signal.aborted || batchSignal.aborted) abort();
  const timeout = setTimeout(abort, EXPORT_ASSET_LIMITS.timeoutMs);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    assertExportActive(context);
    // A dedicated Expo fetch request never uses Axios auth, shared cookies or redirects.
    const pendingResponse = fetchResource(url, {
      method: 'GET',
      credentials: 'omit',
      redirect: 'error',
      signal: controller.signal,
      headers: { Accept: 'image/png,image/jpeg,image/gif,image/webp' },
    });
    void pendingResponse.then(
      (late) => {
        if (controller.signal.aborted) void late.body?.cancel().catch(() => {});
      },
      () => {},
    );
    const response = await withSignal(pendingResponse, controller.signal);
    assertExportActive(context);
    if (!response.ok || !response.body) throw new Error('resource-unavailable');
    const declaredBytes = Number(response.headers.get('content-length'));
    if (declaredBytes > EXPORT_ASSET_LIMITS.perAssetBytes) {
      throw new ExportIoError('resource-limit');
    }
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const { done, value } = await withSignal(
        reader.read(),
        controller.signal,
      );
      assertExportActive(context);
      if (done) break;
      length += value.byteLength;
      if (length > EXPORT_ASSET_LIMITS.perAssetBytes) {
        throw new ExportIoError('resource-limit');
      }
      consumeBytes(value.byteLength);
      chunks.push(value);
    }
    const output = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.length;
    }
    return output;
  } finally {
    clearTimeout(timeout);
    context.signal.removeEventListener('abort', abort);
    batchSignal.removeEventListener('abort', abort);
    controller.abort();
    void reader?.cancel().catch(() => {});
  }
}

export async function prepareExportAssets(
  source: ExportSource,
  includeImages: boolean,
  context: ExportTaskContext,
): Promise<PreparedExportAssets> {
  assertExportActive(context);
  const resources = collectExportResources(source, includeImages);
  if (resources.length > EXPORT_ASSET_LIMITS.count) {
    throw new ExportIoError('resource-limit');
  }
  const htmlAssets = new Map<string, string>();
  const markdownAssets = new Map<string, string>();
  const files: ExportAssetFile[] = [];
  let index = 0;
  let completed = 0;
  let failed = 0;
  let totalBytes = 0;
  const batch = new AbortController();
  const consumeBytes = (count: number) => {
    totalBytes += count;
    if (totalBytes > EXPORT_ASSET_LIMITS.totalBytes) {
      throw new ExportIoError('resource-limit');
    }
  };
  context.onProgress?.({ phase: 'assets', completed, total: resources.length });
  const worker = async () => {
    while (index < resources.length && !batch.signal.aborted) {
      const number = index++;
      const resource = resources[number];
      try {
        assertExportActive(context);
        let bytes: Uint8Array;
        const url = getSafeExportImageUrl(resource.url);
        if (resource.url.startsWith('data:')) {
          const comma = resource.url.indexOf(',');
          const header = resource.url.slice(0, comma);
          if (!/^data:image\/(?:png|jpeg|gif|webp);base64$/.test(header)) {
            throw new Error('resource-unavailable');
          }
          const base64 = resource.url.slice(comma + 1);
          const padding = base64.endsWith('==')
            ? 2
            : base64.endsWith('=')
              ? 1
              : 0;
          const size = Math.floor((base64.length * 3) / 4) - padding;
          if (size > EXPORT_ASSET_LIMITS.perAssetBytes) {
            throw new ExportIoError('resource-limit');
          }
          if (
            !/^[A-Za-z0-9+/]+={0,2}$/.test(base64) ||
            base64.length % 4 !== 0
          ) {
            throw new Error('resource-unavailable');
          }
          consumeBytes(size);
          bytes = base64ToBytes(base64);
        } else {
          if (!url) throw new Error('resource-unavailable');
          bytes = await downloadResource(
            url,
            context,
            batch.signal,
            consumeBytes,
          );
        }
        assertExportActive(context);
        const type = imageType(bytes);
        if (!type) throw new Error('resource-unavailable');
        const path = `assets/asset-${number + 1}.${type.extension}`;
        const data = `data:${type.mime};base64,${bytesToBase64(bytes)}`;
        for (const alias of [url ?? resource.url, ...resource.sourceUrls]) {
          htmlAssets.set(alias, data);
          markdownAssets.set(alias, path);
        }
        files.push({ path, bytes });
      } catch (error) {
        try {
          assertExportActive(context);
        } catch (inactive) {
          batch.abort();
          throw inactive;
        }
        if (error instanceof ExportIoError) {
          batch.abort();
          throw error;
        }
        failed++;
      } finally {
        completed++;
        context.onProgress?.({
          phase: 'assets',
          completed,
          total: resources.length,
        });
      }
    }
  };
  try {
    const results = await Promise.allSettled(
      Array.from(
        { length: Math.min(EXPORT_ASSET_LIMITS.concurrency, resources.length) },
        worker,
      ),
    );
    assertExportActive(context);
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    return {
      htmlAssets,
      markdownAssets,
      files: files.sort((left, right) => left.path.localeCompare(right.path)),
      warnings: failed
        ? [`${failed} 个图片资源未能获取，将使用占位说明；可重试或缺图导出。`]
        : [],
      offline: failed === 0,
    };
  } finally {
    batch.abort();
  }
}
