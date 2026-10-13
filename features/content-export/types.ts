import type { ZhihuDocument } from '@/features/rich-content';

export type ExportContentType =
  | 'answer'
  | 'article'
  | 'question'
  | 'pin'
  | 'daily';
export type ExportFormat = 'markdown' | 'html' | 'pdf' | 'image';

/** A task stays bound to the content and authentication session at menu click. */
export interface ExportTarget {
  readonly type: ExportContentType;
  readonly id: string;
  readonly sessionVersion: number;
}

export interface ExportSource {
  readonly target: ExportTarget;
  readonly title: string;
  readonly author?: string;
  readonly publishedAt?: string;
  readonly updatedAt?: string;
  readonly sourceUrl: string;
  readonly document: ZhihuDocument;
  readonly completeness: 'complete' | 'partial';
  readonly warnings: readonly string[];
}

export interface ExportPalette {
  readonly background: string;
  readonly text: string;
  readonly secondary: string;
  readonly link: string;
  readonly border: string;
  readonly surface: string;
}

export interface ExportRenderOptions {
  readonly includeImages: boolean;
  /** Prepared URLs map to data URIs for HTML, relative asset names for Markdown. */
  readonly assets?: ReadonlyMap<string, string>;
  /** When false, missing prepared resources become visible placeholders. */
  readonly allowRemoteImages?: boolean;
  readonly fontSizeScale?: number;
  readonly lineHeightScale?: number;
  readonly palette?: ExportPalette;
}

export interface ExportProgress {
  readonly phase: 'source' | 'assets' | 'render' | 'merge' | 'write';
  readonly completed?: number;
  readonly total?: number;
}

export interface ExportTaskContext {
  readonly signal: AbortSignal;
  readonly assertActive: () => void;
  readonly onProgress?: (progress: ExportProgress) => void;
}

export interface ExportFile {
  readonly uri: string;
  readonly name: string;
  readonly mimeType: string;
}

export interface ExportResult {
  readonly files: readonly ExportFile[];
  readonly directory: string;
  readonly warnings: readonly string[];
}
