import { Unzlib, Zlib } from 'fflate';
import { ContentExportError } from './errors';
import { assertExportActive } from './ioShared';
import type { ExportTaskContext } from './types';

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_WIDTH = 1080;
const MAX_SOURCE_HEIGHT = 2000;
const MAX_OUTPUT_HEIGHT = 16000;
const MAX_OUTPUT_PIXELS = 16_000_000;
const MAX_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const COLOR_CHUNKS = new Set(['iCCP', 'gAMA', 'cHRM', 'sRGB']);
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++)
    crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

const MESSAGES = {
  invalid: '截图数据损坏，长图未能合并，请重试',
  unsupported: '截图格式暂不支持合并，请改用 HTML 或 PDF',
  dimensions: '截图尺寸不一致，长图未能合并，请重新生成',
  limit: '截图超出安全尺寸或文件上限，请改用 HTML 或 PDF',
  profile: '截图色彩信息不一致，长图未能合并，请重新生成',
} as const;

export class PngStitchError extends ContentExportError {
  constructor(readonly code: keyof typeof MESSAGES) {
    super(MESSAGES[code]);
    this.name = 'PngStitchError';
  }
}

export interface StitchedPngImage {
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
}

interface ColorChunk {
  readonly type: string;
  readonly data: Uint8Array;
}

interface ParsedPng {
  readonly width: number;
  readonly height: number;
  readonly channels: 3 | 4;
  readonly idat: readonly Uint8Array[];
  readonly compressedLength: number;
  readonly colors: readonly ColorChunk[];
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  );
}

function writeU32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value >>> 24;
  bytes[offset + 1] = value >>> 16;
  bytes[offset + 2] = value >>> 8;
  bytes[offset + 3] = value;
}

function crcStep(crc: number, bytes: Uint8Array): number {
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
  return crc >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const result = new Uint8Array(data.length + 12);
  writeU32(result, 0, data.length);
  for (let index = 0; index < 4; index++)
    result[index + 4] = type.charCodeAt(index);
  result.set(data, 8);
  writeU32(
    result,
    data.length + 8,
    crcStep(0xffffffff, result.subarray(4, data.length + 8)) ^ 0xffffffff,
  );
  return result;
}

/** Periodic macrotasks make cancellation responsive without a timer per inflate push. */
class WorkSlice {
  private started = Date.now();
  private bytes = 0;
  constructor(private readonly context: ExportTaskContext) {}
  async checkpoint(bytes = 0, force = false): Promise<void> {
    assertExportActive(this.context);
    this.bytes += bytes;
    if (force || this.bytes >= 512 * 1024 || Date.now() - this.started >= 8) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      assertExportActive(this.context);
      this.bytes = 0;
      this.started = Date.now();
    }
  }
}

async function parsePng(
  bytes: Uint8Array,
  work: WorkSlice,
): Promise<ParsedPng> {
  if (bytes.length > MAX_SOURCE_BYTES) throw new PngStitchError('limit');
  if (
    bytes.length < 45 ||
    PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte)
  )
    throw new PngStitchError('invalid');
  let width = 0;
  let height = 0;
  let channels: 3 | 4 = 4;
  const idat: Uint8Array[] = [];
  const colors: ColorChunk[] = [];
  let compressedLength = 0;
  let offset = 8;
  let dataEnded = false;
  let ended = false;
  let paletteSeen = false;
  let chunkCount = 0;
  while (offset < bytes.length) {
    if (++chunkCount > 16384) throw new PngStitchError('limit');
    if (offset + 12 > bytes.length) throw new PngStitchError('invalid');
    const length = readU32(bytes, offset);
    const end = offset + 12 + length;
    if (end > bytes.length) throw new PngStitchError('invalid');
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (!/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(type))
      throw new PngStitchError('invalid');
    let crc = 0xffffffff;
    for (let cursor = offset + 4; cursor < end - 4; cursor += 65536) {
      const piece = bytes.subarray(cursor, Math.min(cursor + 65536, end - 4));
      crc = crcStep(crc, piece);
      await work.checkpoint(piece.length);
    }
    if ((crc ^ 0xffffffff) >>> 0 !== readU32(bytes, end - 4))
      throw new PngStitchError('invalid');
    const data = bytes.subarray(offset + 8, end - 4);
    if (offset === 8 && type !== 'IHDR') throw new PngStitchError('invalid');
    if (type === 'IHDR') {
      if (offset !== 8 || length !== 13) throw new PngStitchError('invalid');
      width = readU32(data, 0);
      height = readU32(data, 4);
      if (!width || !height || width > MAX_WIDTH || height > MAX_SOURCE_HEIGHT)
        throw new PngStitchError('limit');
      if (
        data[8] !== 8 ||
        (data[9] !== 2 && data[9] !== 6) ||
        data[10] !== 0 ||
        data[11] !== 0 ||
        data[12] !== 0
      )
        throw new PngStitchError('unsupported');
      channels = data[9] === 2 ? 3 : 4;
    } else if (type === 'IDAT') {
      if (dataEnded) throw new PngStitchError('invalid');
      idat.push(data);
      compressedLength += length;
    } else if (type === 'IEND') {
      if (
        length !== 0 ||
        !idat.length ||
        compressedLength < 6 ||
        end !== bytes.length
      )
        throw new PngStitchError('invalid');
      ended = true;
    } else {
      if (idat.length) dataEnded = true;
      if (COLOR_CHUNKS.has(type)) {
        if (length > 1024 * 1024) throw new PngStitchError('limit');
        if (idat.length || colors.some((value) => value.type === type))
          throw new PngStitchError('invalid');
        if (
          (type === 'gAMA' && (length !== 4 || readU32(data, 0) === 0)) ||
          (type === 'cHRM' && length !== 32) ||
          (type === 'sRGB' && (length !== 1 || data[0] > 3))
        )
          throw new PngStitchError('invalid');
        if (type === 'iCCP') {
          const nameEnd = data.indexOf(0);
          if (
            nameEnd < 1 ||
            nameEnd > 79 ||
            nameEnd + 2 >= length ||
            data[nameEnd + 1] !== 0
          )
            throw new PngStitchError('invalid');
        }
        colors.push({ type, data });
      } else if (type === 'PLTE') {
        if (
          paletteSeen ||
          idat.length ||
          length === 0 ||
          length > 768 ||
          length % 3 !== 0
        )
          throw new PngStitchError('invalid');
        paletteSeen = true;
      } else if (
        type === 'tRNS' ||
        ['acTL', 'fcTL', 'fdAT'].includes(type) ||
        (bytes[offset + 4] & 32) === 0
      ) {
        // PNG transparency keys and animated/vendor PNG require transformations
        // beyond the truecolor screenshots produced by our capture surface.
        throw new PngStitchError('unsupported');
      }
    }
    offset = end;
  }
  if (!ended) throw new PngStitchError('invalid');
  return { width, height, channels, idat, compressedLength, colors };
}

function sameColors(
  first: readonly ColorChunk[],
  next: readonly ColorChunk[],
): boolean {
  return (
    first.length === next.length &&
    first.every((chunk) => {
      const other = next.find((value) => value.type === chunk.type);
      return (
        other &&
        other.data.length === chunk.data.length &&
        chunk.data.every((byte, index) => byte === other.data[index])
      );
    })
  );
}

function paeth(left: number, up: number, upperLeft: number): number {
  const prediction = left + up - upperLeft;
  const a = Math.abs(prediction - left);
  const b = Math.abs(prediction - up);
  const c = Math.abs(prediction - upperLeft);
  return a <= b && a <= c ? left : b <= c ? up : upperLeft;
}

class PngGroup {
  height = 0;
  private readonly compressed: Uint8Array[] = [];
  private compressedBytes = 0;
  private readonly staging = new Uint8Array(65536);
  private staged = 0;
  private readonly zlib: Zlib;
  constructor(
    readonly width: number,
    private readonly colors: readonly ColorChunk[],
  ) {
    this.zlib = new Zlib({ level: 3 }, (data) => {
      if (!data.length) return;
      this.compressedBytes += data.length + 12;
      if (this.compressedBytes > MAX_OUTPUT_BYTES)
        throw new PngStitchError('limit');
      this.compressed.push(chunk('IDAT', data));
    });
  }
  row(rgba: Uint8Array): void {
    let offset = 0;
    while (offset < rgba.length) {
      const size = Math.min(
        this.staging.length - this.staged,
        rgba.length - offset,
      );
      this.staging.set(rgba.subarray(offset, offset + size), this.staged);
      this.staged += size;
      offset += size;
      if (this.staged === this.staging.length) {
        this.zlib.push(this.staging);
        this.staged = 0;
      }
    }
    this.height++;
  }
  finish(): StitchedPngImage {
    this.zlib.push(this.staging.subarray(0, this.staged), true);
    const header = new Uint8Array(13);
    writeU32(header, 0, this.width);
    writeU32(header, 4, this.height);
    header[8] = 8;
    header[9] = 6;
    const pieces = [
      PNG_SIGNATURE,
      chunk('IHDR', header),
      ...this.colors.map((value) => chunk(value.type, value.data)),
      ...this.compressed,
      chunk('IEND', new Uint8Array()),
    ];
    const size = pieces.reduce((total, value) => total + value.length, 0);
    if (size > MAX_OUTPUT_BYTES) throw new PngStitchError('limit');
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const piece of pieces) {
      bytes.set(piece, offset);
      offset += piece.length;
    }
    this.compressed.length = 0;
    return { bytes, width: this.width, height: this.height };
  }
}

async function appendPng(
  png: ParsedPng,
  output: PngGroup,
  work: WorkSlice,
  context: ExportTaskContext,
): Promise<void> {
  const stride = png.width * png.channels;
  const expected = (stride + 1) * png.height;
  let line = new Uint8Array(stride + 1);
  let previous = new Uint8Array(stride + 1);
  const rgba = new Uint8Array(png.width * 4 + 1);
  let lineOffset = 0;
  let received = 0;
  let decodedRows = 0;
  let finished = false;
  let adlerA = 1;
  let adlerB = 0;
  const footer = new Uint8Array(4);
  let footerOffset = 4;
  for (let index = png.idat.length - 1; index >= 0 && footerOffset; index--) {
    const part = png.idat[index];
    const count = Math.min(footerOffset, part.length);
    footerOffset -= count;
    footer.set(part.subarray(part.length - count), footerOffset);
  }
  const inflater = new Unzlib((data, final) => {
    assertExportActive(context);
    received += data.length;
    if (received > expected) throw new PngStitchError('invalid');
    // fflate intentionally omits the Zlib checksum; verify Adler-32 ourselves.
    for (let start = 0; start < data.length; start += 5552) {
      for (
        let index = start;
        index < Math.min(start + 5552, data.length);
        index++
      ) {
        adlerA += data[index];
        adlerB += adlerA;
      }
      adlerA %= 65521;
      adlerB %= 65521;
    }
    let position = 0;
    while (position < data.length) {
      const count = Math.min(line.length - lineOffset, data.length - position);
      line.set(data.subarray(position, position + count), lineOffset);
      lineOffset += count;
      position += count;
      if (lineOffset !== line.length) continue;
      const filter = line[0];
      if (filter > 4) throw new PngStitchError('unsupported');
      for (let index = 1; index <= stride; index++) {
        const left = index > png.channels ? line[index - png.channels] : 0;
        const up = previous[index];
        const upperLeft =
          index > png.channels ? previous[index - png.channels] : 0;
        const prediction =
          filter === 0
            ? 0
            : filter === 1
              ? left
              : filter === 2
                ? up
                : filter === 3
                  ? (left + up) >>> 1
                  : paeth(left, up, upperLeft);
        line[index] = (line[index] + prediction) & 255;
      }
      if (png.channels === 4) rgba.set(line.subarray(1), 1);
      else
        for (let pixel = 0; pixel < png.width; pixel++) {
          rgba[1 + pixel * 4] = line[1 + pixel * 3];
          rgba[2 + pixel * 4] = line[2 + pixel * 3];
          rgba[3 + pixel * 4] = line[3 + pixel * 3];
          rgba[4 + pixel * 4] = 255;
        }
      output.row(rgba);
      decodedRows++;
      [previous, line] = [line, previous];
      lineOffset = 0;
    }
    if (final) finished = true;
  });
  let pushed = 0;
  for (const data of png.idat) {
    // A DEFLATE chunk has a bounded expansion ratio. Small compressed pushes
    // prevent a malformed stream allocating a whole decompression bomb before
    // the callback can reject output that exceeds the exact scanline count.
    for (let offset = 0; offset < data.length; offset += 256) {
      assertExportActive(context);
      const before = received;
      const part = data.subarray(offset, offset + 256);
      pushed += part.length;
      try {
        inflater.push(part, pushed === png.compressedLength);
      } catch (error) {
        assertExportActive(context);
        if (error instanceof ContentExportError) throw error;
        throw new PngStitchError('invalid');
      }
      await work.checkpoint(received - before);
    }
  }
  if (
    !finished ||
    received !== expected ||
    lineOffset !== 0 ||
    decodedRows !== png.height ||
    ((adlerB << 16) | adlerA) >>> 0 !== readU32(footer, 0)
  )
    throw new PngStitchError('invalid');
  await work.checkpoint(0, true);
}

/**
 * Merge capture slices in order, emitting one bounded PNG at a time. Only two
 * source scanlines, one RGBA row and compression windows are held as pixels;
 * there is never a full-height decoded bitmap. The caller owns IO and the total
 * output-file budget. Each source image is read once and remains account-bound.
 */
export async function* stitchPngImages(
  images: AsyncIterable<Uint8Array>,
  context: ExportTaskContext,
): AsyncGenerator<StitchedPngImage> {
  assertExportActive(context);
  const work = new WorkSlice(context);
  let group: PngGroup | undefined;
  let colors: readonly ColorChunk[] | undefined;
  let width = 0;
  for await (const bytes of images) {
    assertExportActive(context);
    const png = await parsePng(bytes, work);
    if (width && png.width !== width) throw new PngStitchError('dimensions');
    if (colors && !sameColors(colors, png.colors))
      throw new PngStitchError('profile');
    width = png.width;
    // Keep only small copies of the first profile, not its entire input buffer.
    colors ??= png.colors.map((value) => ({
      type: value.type,
      data: value.data.slice(),
    }));
    const maximumHeight = Math.min(
      MAX_OUTPUT_HEIGHT,
      Math.floor(MAX_OUTPUT_PIXELS / width),
    );
    if (group && group.height + png.height > maximumHeight) {
      assertExportActive(context);
      yield group.finish();
      assertExportActive(context);
      group = undefined;
    }
    group ??= new PngGroup(width, colors);
    await appendPng(png, group, work, context);
  }
  assertExportActive(context);
  if (!group) throw new PngStitchError('invalid');
  yield group.finish();
}
