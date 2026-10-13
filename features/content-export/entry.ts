import type { Href } from 'expo-router';
import type { ExportContentType, ExportTarget } from './types';

export const EXPORT_CONTENT_LABELS: Record<ExportContentType, string> = {
  answer: '回答',
  article: '文章',
  question: '问题描述',
  pin: '想法',
  daily: '日报文章',
};

export function parseExportTarget(
  type: unknown,
  id: unknown,
  sessionVersion: unknown,
): ExportTarget | null {
  if (
    typeof type !== 'string' ||
    !Object.hasOwn(EXPORT_CONTENT_LABELS, type) ||
    typeof id !== 'string' ||
    !/^[1-9]\d*$/.test(id) ||
    typeof sessionVersion !== 'number' ||
    !Number.isSafeInteger(sessionVersion) ||
    sessionVersion < 0
  )
    return null;
  return { type: type as ExportContentType, id, sessionVersion };
}

export function contentExportHref(target: ExportTarget): Href {
  // Expo regenerates its route union when Metro next starts.
  return {
    pathname: '/export-content',
    params: {
      type: target.type,
      id: target.id,
      session: String(target.sessionVersion),
    },
  } as Href;
}
