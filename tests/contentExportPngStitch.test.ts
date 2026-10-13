import { unzlibSync, zlibSync } from 'fflate';
import {
  PngStitchError,
  type StitchedPngImage,
  stitchPngImages,
} from '../features/content-export/pngStitch';
import type { ExportTaskContext } from '../features/content-export/types';

const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
function u32(value: number): Uint8Array {
  return new Uint8Array([value >>> 24, value >>> 16, value >>> 8, value]);
}
function readU32(bytes: Uint8Array, offset: number): number {
  return new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint32(offset);
}
function join(parts: readonly Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(
    parts.reduce((sum, part) => sum + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}
/** Independent bitwise implementation checks the production CRC lookup table. */
function crc32(data: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of data) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++)
      value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  }
  return (value ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const content = join([
    Uint8Array.from(type, (character) => character.charCodeAt(0)),
    data,
  ]);
  return join([u32(data.length), content, u32(crc32(content))]);
}
interface TestChunk {
  readonly type: string;
  readonly data: Uint8Array;
}
function chunks(png: Uint8Array): TestChunk[] {
  const result: TestChunk[] = [];
  for (let offset = 8; offset < png.length; ) {
    const length = readU32(png, offset);
    const end = offset + 8 + length;
    expect(crc32(png.subarray(offset + 4, end))).toBe(readU32(png, end));
    result.push({
      type: String.fromCharCode(...png.subarray(offset + 4, offset + 8)),
      data: png.slice(offset + 8, end),
    });
    offset = end + 4;
  }
  return result;
}
function rewrite(
  png: Uint8Array,
  change: (value: TestChunk) => readonly TestChunk[],
): Uint8Array {
  return join([
    signature,
    ...chunks(png)
      .flatMap(change)
      .map((value) => chunk(value.type, value.data)),
  ]);
}
function predictor(filter: number, a: number, b: number, c: number): number {
  if (filter === 0) return 0;
  if (filter === 1) return a;
  if (filter === 2) return b;
  if (filter === 3) return Math.floor((a + b) / 2);
  const p = a + b - c;
  const distances = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
  return [a, b, c][distances.indexOf(Math.min(...distances))];
}
function makePng({
  width = 3,
  height = 5,
  channels = 4,
  filter = 0,
  seed = 0,
  parts = false,
  colors = [],
}: {
  width?: number;
  height?: number;
  channels?: 3 | 4;
  filter?: number | readonly number[];
  seed?: number;
  parts?: boolean;
  colors?: readonly TestChunk[];
} = {}): { png: Uint8Array; rgba: Uint8Array } {
  const stride = width * channels;
  const filtered = new Uint8Array((stride + 1) * height);
  const rgba = new Uint8Array(width * height * 4);
  let previous = new Uint8Array(stride);
  for (let row = 0; row < height; row++) {
    const current = new Uint8Array(stride);
    for (let column = 0; column < width; column++) {
      const pixel = [
        ((row * 11 + column * 13) ^ seed) & 255,
        (row * 7 + seed) & 255,
        (column + seed * 3) & 255,
        channels === 4 ? (row * 3 + column * 19 + seed) & 255 : 255,
      ];
      rgba.set(pixel, (row * width + column) * 4);
      current.set(pixel.slice(0, channels), column * channels);
    }
    const method =
      typeof filter === 'number' ? filter : filter[row % filter.length];
    filtered[row * (stride + 1)] = method;
    for (let index = 0; index < stride; index++) {
      const a = index >= channels ? current[index - channels] : 0;
      const b = previous[index];
      const c = index >= channels ? previous[index - channels] : 0;
      filtered[row * (stride + 1) + index + 1] =
        (current[index] - predictor(method, a, b, c)) & 255;
    }
    previous = current;
  }
  const header = join([
    u32(width),
    u32(height),
    new Uint8Array([8, channels === 4 ? 6 : 2, 0, 0, 0]),
  ]);
  const compressed = zlibSync(filtered, { level: 1 });
  const idat: Uint8Array[] = [];
  for (
    let offset = 0;
    offset < compressed.length;
    offset += parts ? 7 : compressed.length
  )
    idat.push(
      chunk(
        'IDAT',
        compressed.subarray(offset, offset + (parts ? 7 : compressed.length)),
      ),
    );
  return {
    png: join([
      signature,
      chunk('IHDR', header),
      ...colors.map((value) => chunk(value.type, value.data)),
      ...idat,
      chunk('IEND', new Uint8Array()),
    ]),
    rgba,
  };
}
function pixels(png: Uint8Array): Uint8Array {
  const parts = chunks(png);
  const header = parts[0].data;
  expect([...header.subarray(8)]).toEqual([8, 6, 0, 0, 0]);
  const width = readU32(header, 0);
  const height = readU32(header, 4);
  const raw = unzlibSync(
    join(parts.filter((part) => part.type === 'IDAT').map((part) => part.data)),
  );
  expect(raw.length).toBe((width * 4 + 1) * height);
  const output = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row++) {
    expect(raw[row * (width * 4 + 1)]).toBe(0);
    output.set(
      raw.subarray(row * (width * 4 + 1) + 1, (row + 1) * (width * 4 + 1)),
      row * width * 4,
    );
  }
  return output;
}
function context(controller = new AbortController()): ExportTaskContext {
  return { signal: controller.signal, assertActive: jest.fn() };
}
async function* images(values: readonly Uint8Array[]) {
  for (const value of values) yield value;
}
async function collect(
  values: readonly Uint8Array[],
  task = context(),
): Promise<StitchedPngImage[]> {
  const output: StitchedPngImage[] = [];
  for await (const value of stitchPngImages(images(values), task))
    output.push(value);
  return output;
}

test.each([
  0, 1, 2, 3, 4,
])('decodes PNG filter %i and joins scanlines without duplicated or missing rows', async (filter) => {
  const first = makePng({ filter, seed: 11, parts: true });
  const second = makePng({ filter, seed: 29, parts: true });
  const output = await collect([first.png, second.png]);
  expect(output).toHaveLength(1);
  expect(output[0].width).toBe(3);
  expect(output[0].height).toBe(10);
  expect(pixels(output[0].bytes)).toEqual(join([first.rgba, second.rgba]));
});

test('supports mixed RGB/RGBA slices, mixed row filters, alpha and short last slices', async () => {
  const first = makePng({ channels: 3, filter: [4, 0, 2, 1, 3], seed: 15 });
  const second = makePng({
    channels: 4,
    filter: [2, 3, 4],
    seed: 98,
    height: 2,
  });
  const [output] = await collect([first.png, second.png]);
  expect(output.height).toBe(7);
  expect(pixels(output.bytes)).toEqual(join([first.rgba, second.rgba]));
});

test('preserves consistent color profiles and drops text/EXIF metadata', async () => {
  const colors = [
    { type: 'gAMA', data: u32(45455) },
    { type: 'cHRM', data: new Uint8Array(32).fill(1) },
    {
      type: 'iCCP',
      data: join([
        new Uint8Array([115, 82, 71, 66, 0, 0]),
        zlibSync(new Uint8Array([1, 2, 3])),
      ]),
    },
  ];
  const first = makePng({
    colors: [...colors, { type: 'tEXt', data: new Uint8Array([1, 2, 3]) }],
  });
  const second = makePng({ colors: [...colors].reverse(), channels: 3 });
  const [output] = await collect([first.png, second.png]);
  const outputChunks = chunks(output.bytes);
  expect(
    outputChunks.filter((part) =>
      colors.some((color) => color.type === part.type),
    ),
  ).toEqual(colors);
  expect(outputChunks.some((part) => part.type === 'tEXt')).toBe(false);
  const changed = makePng({ colors: [{ type: 'gAMA', data: u32(50000) }] });
  await expect(collect([first.png, changed.png])).rejects.toMatchObject({
    code: 'profile',
  });
});

test('preserves an sRGB rendering intent', async () => {
  const png = makePng({
    colors: [{ type: 'sRGB', data: new Uint8Array([1]) }],
  }).png;
  const [output] = await collect([png]);
  expect(
    chunks(output.bytes).find((value) => value.type === 'sRGB')?.data,
  ).toEqual(new Uint8Array([1]));
});

test('starts a new output before the 16000-pixel height limit without repeating a slice', async () => {
  const first = makePng({ width: 1, height: 2000, seed: 2 });
  const last = makePng({ width: 1, height: 7, seed: 127 });
  const output = await collect([
    ...Array.from({ length: 8 }, () => first.png),
    last.png,
  ]);
  expect(output.map((value) => value.height)).toEqual([16000, 7]);
  expect(pixels(output[0].bytes)).toEqual(
    join(Array.from({ length: 8 }, () => first.rgba)),
  );
  expect(pixels(output[1].bytes)).toEqual(last.rgba);
});

test('splits before 16 million pixels even when the height limit has room', async () => {
  const source = makePng({ width: 1080, height: 2000, filter: 2, channels: 3 });
  const output = await collect(Array.from({ length: 8 }, () => source.png));
  expect(output.map((value) => value.height)).toEqual([14000, 2000]);
  for (const value of output)
    expect(value.width * value.height).toBeLessThanOrEqual(16_000_000);
}, 20000);

test('rejects CRC corruption, truncated chunks, missing end and trailing bytes', async () => {
  const { png } = makePng();
  const badCrc = png.slice();
  badCrc[badCrc.length - 1] ^= 1;
  for (const corrupt of [
    badCrc,
    png.slice(0, -2),
    png.slice(0, -12),
    join([png, new Uint8Array([0])]),
  ])
    await expect(collect([corrupt])).rejects.toMatchObject({ code: 'invalid' });
});

test('rejects unsupported formats and transparency keys instead of changing pixel meaning', async () => {
  const { png } = makePng();
  for (const [index, value] of [
    [8, 16],
    [9, 3],
    [12, 1],
  ]) {
    const changed = rewrite(png, (part) => {
      if (part.type === 'IHDR') part.data[index] = value;
      return [part];
    });
    await expect(collect([changed])).rejects.toMatchObject({
      code: 'unsupported',
    });
  }
  const transparency = rewrite(png, (part) =>
    part.type === 'IHDR'
      ? [part, { type: 'tRNS', data: new Uint8Array(6) }]
      : [part],
  );
  await expect(collect([transparency])).rejects.toMatchObject({
    code: 'unsupported',
  });
});

test('rejects inconsistent widths and bounds each input before decoding', async () => {
  await expect(
    collect([makePng().png, makePng({ width: 4 }).png]),
  ).rejects.toMatchObject({ code: 'dimensions' });
  for (const [offset, value] of [
    [0, 1081],
    [4, 2001],
    [0, 0],
  ]) {
    const changed = rewrite(makePng().png, (part) => {
      if (part.type === 'IHDR') part.data.set(u32(value), offset);
      return [part];
    });
    await expect(collect([changed])).rejects.toMatchObject({ code: 'limit' });
  }
  await expect(
    collect([new Uint8Array(16 * 1024 * 1024 + 1)]),
  ).rejects.toMatchObject({ code: 'limit' });
});

test('rejects bad Adler checksums, truncated Zlib and wrong decoded row counts', async () => {
  const { png } = makePng();
  const badAdler = rewrite(png, (part) => {
    if (part.type === 'IDAT') part.data[part.data.length - 1] ^= 1;
    return [part];
  });
  await expect(collect([badAdler])).rejects.toMatchObject({ code: 'invalid' });
  const truncated = rewrite(png, (part) => [
    {
      ...part,
      data: part.type === 'IDAT' ? part.data.subarray(0, -5) : part.data,
    },
  ]);
  await expect(collect([truncated])).rejects.toMatchObject({ code: 'invalid' });
  for (const height of [4, 6]) {
    const changed = rewrite(png, (part) => {
      if (part.type === 'IHDR') part.data.set(u32(height), 4);
      return [part];
    });
    await expect(collect([changed])).rejects.toMatchObject({ code: 'invalid' });
  }
  const bomb = rewrite(png, (part) => [
    {
      ...part,
      data:
        part.type === 'IDAT' ? zlibSync(new Uint8Array(2_000_000)) : part.data,
    },
  ]);
  await expect(collect([bomb])).rejects.toMatchObject({ code: 'invalid' });
});

test('rejects invalid row filters and noncontiguous IDAT data', async () => {
  await expect(collect([makePng({ filter: 5 }).png])).rejects.toMatchObject({
    code: 'unsupported',
  });
  const changed = rewrite(makePng({ parts: true }).png, (part) =>
    part.type === 'IDAT'
      ? [part, { type: 'tEXt', data: new Uint8Array() }]
      : [part],
  );
  await expect(collect([changed])).rejects.toMatchObject({ code: 'invalid' });
});

test('yields to the event loop for each slice and checks cancellation before requesting input', async () => {
  const controller = new AbortController();
  controller.abort();
  const read = jest.fn();
  async function* unread() {
    read();
    yield makePng().png;
  }
  await expect(
    stitchPngImages(unread(), context(controller)).next(),
  ).rejects.toThrow('导出已取消');
  expect(read).not.toHaveBeenCalled();
  let timerRan = false;
  let observedYield = false;
  async function* provider() {
    setTimeout(() => {
      timerRan = true;
    }, 0);
    yield makePng().png;
    observedYield = timerRan;
    yield makePng().png;
  }
  for await (const _image of stitchPngImages(provider(), context())) {
    /* consume */
  }
  expect(observedYield).toBe(true);
});

test('cancellation during processing emits no partial output and closes the source iterator', async () => {
  const controller = new AbortController();
  const closed = jest.fn();
  async function* provider() {
    try {
      setTimeout(() => controller.abort(), 0);
      yield makePng().png;
      throw new Error('must not request another screenshot');
    } finally {
      closed();
    }
  }
  const iterator = stitchPngImages(provider(), context(controller));
  await expect(iterator.next()).rejects.toThrow('导出已取消');
  expect(closed).toHaveBeenCalledTimes(1);
});

test('empty input fails with a safe content error', async () => {
  await expect(collect([])).rejects.toBeInstanceOf(PngStitchError);
});
