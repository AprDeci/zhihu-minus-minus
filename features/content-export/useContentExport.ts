import { useCallback, useEffect, useRef, useState } from 'react';
import { getAuthSessionVersion } from '@/store/useAuthStore';
import { type PreparedExportAssets, prepareExportAssets } from './assets';
import { ContentExportError } from './errors';
import {
  cleanupExpiredExports,
  createExportDirectory,
  discardExportDirectory,
  writeImageExport,
  writePdfExport,
  writeTextExport,
} from './files';
import { releaseImageCaptures } from './ImageExportRenderer';
import { resolveExportSource } from './resolveSource';
import { serializeExportHtml, serializeExportMarkdown } from './serializers';
import type {
  ExportFormat,
  ExportProgress,
  ExportRenderOptions,
  ExportResult,
  ExportSource,
  ExportTarget,
  ExportTaskContext,
} from './types';

interface PreparedJob {
  readonly source: ExportSource;
  readonly format: ExportFormat;
  readonly options: ExportRenderOptions;
  readonly assets?: PreparedExportAssets;
  readonly directory: string;
  readonly context: ExportTaskContext;
}

export function exportErrorMessage(error: unknown, fallback: string): string {
  return error instanceof ContentExportError ? error.message : fallback;
}

export function useContentExport(
  target: ExportTarget | null,
  active: boolean,
  capture: (
    html: string,
    context: ExportTaskContext,
  ) => Promise<readonly string[]>,
) {
  const [source, setSource] = useState<ExportSource | null>(null);
  const [reading, setReading] = useState(false);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [error, setError] = useState<string>();
  const [missing, setMissing] = useState<readonly string[]>([]);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [attempt, setAttempt] = useState(0);
  const sourceAttempt = useRef(attempt);
  sourceAttempt.current = attempt;
  const generation = useRef<AbortController | null>(null);
  const directory = useRef<string | undefined>(undefined);
  const pending = useRef<PreparedJob | null>(null);
  const mounted = useRef(true);
  const running = useRef(false);

  const clearJob = useCallback(() => {
    generation.current?.abort();
    generation.current = null;
    running.current = false;
    pending.current = null;
    const previous = directory.current;
    directory.current = undefined;
    if (previous) void discardExportDirectory(previous);
  }, []);
  const resetOutput = useCallback(() => {
    clearJob();
    setProgress(null);
    setMissing([]);
    setResult(null);
    setError(undefined);
  }, [clearJob]);
  useEffect(() => {
    mounted.current = true;
    void cleanupExpiredExports().catch(() => {});
    return () => {
      mounted.current = false;
      clearJob();
    };
  }, [clearJob]);

  useEffect(() => {
    resetOutput();
    setSource(null);
    if (!target || !active) {
      setReading(false);
      return;
    }
    const controller = new AbortController();
    const context: ExportTaskContext = {
      signal: controller.signal,
      assertActive: () => {
        if (controller.signal.aborted || sourceAttempt.current !== attempt)
          throw new ContentExportError('导出已取消');
        if (getAuthSessionVersion() !== target.sessionVersion)
          throw new ContentExportError('账号已切换，请返回内容页重新导出');
      },
    };
    setReading(true);
    void resolveExportSource(target, context)
      .then((data) => {
        context.assertActive();
        setSource(data);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted)
          setError(exportErrorMessage(reason, '正文读取失败，请重试'));
      })
      .finally(() => {
        if (!controller.signal.aborted) setReading(false);
      });
    return () => controller.abort();
  }, [target, active, attempt, resetOutput]);

  const finish = useCallback(
    async (job: PreparedJob) => {
      const { source: input, format, options, assets, context } = job;
      let captures: readonly string[] = [];
      try {
        context.assertActive();
        running.current = true;
        setMissing([]);
        setProgress({ phase: 'render' });
        const warnings = [...input.warnings, ...(assets?.warnings ?? [])];
        const exportSource = { ...input, warnings };
        const renderOptions: ExportRenderOptions = {
          ...options,
          assets:
            format === 'markdown' ? assets?.markdownAssets : assets?.htmlAssets,
          allowRemoteImages: format === 'markdown' && !assets,
        };
        let output: ExportResult;
        const base = { directory: job.directory, title: input.title, warnings };
        if (format === 'markdown') {
          output = await writeTextExport(
            {
              ...base,
              format,
              content: serializeExportMarkdown(exportSource, renderOptions),
              assets: assets?.files,
            },
            context,
          );
        } else {
          const html = serializeExportHtml(exportSource, renderOptions);
          context.assertActive();
          if (format === 'html')
            output = await writeTextExport(
              { ...base, format, content: html },
              context,
            );
          else if (format === 'pdf')
            output = await writePdfExport({ ...base, html }, context);
          else {
            captures = await capture(html, context);
            context.assertActive();
            output = await writeImageExport(
              { ...base, uris: captures },
              context,
            );
          }
        }
        context.assertActive();
        setResult(output);
        setProgress(null);
        pending.current = null;
        running.current = false;
      } catch (reason) {
        await discardExportDirectory(job.directory);
        if (!context.signal.aborted && mounted.current) {
          setProgress(null);
          setError(exportErrorMessage(reason, '导出失败，请重试'));
          running.current = false;
          pending.current = null;
        }
      } finally {
        releaseImageCaptures(captures);
      }
    },
    [capture],
  );

  const generate = useCallback(
    async (format: ExportFormat, options: ExportRenderOptions) => {
      if (!source || !target || !active || running.current) return;
      resetOutput();
      const controller = new AbortController();
      generation.current = controller;
      running.current = true;
      const context: ExportTaskContext = {
        signal: controller.signal,
        assertActive: () => {
          if (
            controller.signal.aborted ||
            generation.current !== controller ||
            !mounted.current
          )
            throw new ContentExportError('导出已取消');
          if (getAuthSessionVersion() !== target.sessionVersion)
            throw new ContentExportError('账号已切换，请返回内容页重新导出');
        },
        onProgress: (next) => {
          context.assertActive();
          setProgress(next);
        },
      };
      let taskDirectory: string | undefined;
      try {
        setProgress({ phase: 'assets' });
        taskDirectory = await createExportDirectory(context);
        context.assertActive();
        directory.current = taskDirectory;
        // Markdown's unchecked option keeps remote image references, without download.
        const assets =
          format === 'markdown' && !options.includeImages
            ? undefined
            : await prepareExportAssets(source, options.includeImages, context);
        context.assertActive();
        const job: PreparedJob = {
          source,
          format,
          options: {
            ...options,
            includeImages: format === 'markdown' || options.includeImages,
          },
          assets,
          directory: taskDirectory,
          context,
        };
        if (assets?.warnings.length) {
          pending.current = job;
          running.current = false;
          setProgress(null);
          setMissing(assets.warnings);
        } else {
          await finish(job);
        }
      } catch (reason) {
        if (taskDirectory) await discardExportDirectory(taskDirectory);
        if (!controller.signal.aborted && mounted.current) {
          running.current = false;
          setProgress(null);
          setError(exportErrorMessage(reason, '导出准备失败，请重试'));
        }
      }
    },
    [source, target, active, resetOutput, finish],
  );

  const continueWithoutImages = () => {
    const job = pending.current;
    if (job && !running.current) void finish(job);
  };
  const resultContext = (): ExportTaskContext => {
    const controller = generation.current;
    return {
      signal: controller?.signal ?? new AbortController().signal,
      assertActive: () => {
        if (
          !controller ||
          controller.signal.aborted ||
          !active ||
          !mounted.current ||
          generation.current !== controller
        )
          throw new ContentExportError('文件已失效，请重新生成');
        if (getAuthSessionVersion() !== target?.sessionVersion)
          throw new ContentExportError('账号已切换，请重新导出');
      },
    };
  };
  return {
    source,
    reading,
    progress,
    error,
    missing,
    result,
    generate,
    continueWithoutImages,
    resetOutput,
    resultContext,
    retrySource: () => setAttempt((value) => value + 1),
  };
}
