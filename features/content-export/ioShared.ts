import { ContentExportError } from './errors';
import type { ExportTaskContext } from './types';

const messages = {
  cancelled: '导出已取消',
  'resource-limit': '内容资源超出导出上限，请关闭图片后重试',
  storage: '无法写入导出文件，请检查可用存储空间',
  'pdf-unavailable': '当前安装包未包含 PDF 导出模块，请更新应用后重试',
  'share-unavailable': '当前设备不支持系统分享',
  'gallery-unavailable': '当前安装包无法保存相册，请使用保存文件或分享',
  permission: '未获得相册保存权限，请使用保存文件或分享',
  save: '保存未完成，请重试；已保存的文件可能仍在目标位置',
} as const;

/** Never expose a native/network exception which may contain a URL or headers. */
export class ExportIoError extends ContentExportError {
  constructor(readonly code: keyof typeof messages) {
    super(messages[code]);
    this.name = 'ExportIoError';
  }
}

export function assertExportActive(context: ExportTaskContext): void {
  if (context.signal.aborted) throw new ExportIoError('cancelled');
  context.assertActive();
}

/** Chunk at multiples of three to avoid huge intermediate argument/string sizes. */
export function bytesToBase64(bytes: Uint8Array): string {
  const encoded: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 24_576) {
    let chunk = '';
    for (const byte of bytes.subarray(offset, offset + 24_576)) {
      chunk += String.fromCharCode(byte);
    }
    encoded.push(btoa(chunk));
  }
  return encoded.join('');
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
