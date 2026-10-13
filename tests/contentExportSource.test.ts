import { getAnswer } from '../api/zhihu/answer';
import { getArticle } from '../api/zhihu/article';
import { getDailyDetail } from '../api/zhihu/daily';
import { getNextContentRender, getNextRender } from '../api/zhihu/nextRender';
import { getPin } from '../api/zhihu/pin';
import { getQuestion } from '../api/zhihu/question';
import { ContentExportError } from '../features/content-export/errors';
import { resolveExportSource } from '../features/content-export/resolveSource';
import type {
  ExportTarget,
  ExportTaskContext,
} from '../features/content-export/types';
import { walkZhihuDocument } from '../features/rich-content/documentTraversal';
import type { ZhihuStructuredContent } from '../types/zhihu';

jest.mock('../api/zhihu/answer', () => ({ getAnswer: jest.fn() }));
jest.mock('../api/zhihu/article', () => ({ getArticle: jest.fn() }));
jest.mock('../api/zhihu/daily', () => ({ getDailyDetail: jest.fn() }));
jest.mock('../api/zhihu/pin', () => ({ getPin: jest.fn() }));
jest.mock('../api/zhihu/question', () => ({ getQuestion: jest.fn() }));
jest.mock('../api/client', () => ({
  __esModule: true,
  default: { get: jest.fn() },
}));
jest.mock('../api/zhihu/nextRender', () => ({
  ...jest.requireActual('../api/zhihu/nextRender'),
  getNextRender: jest.fn(),
  getNextContentRender: jest.fn(),
}));
jest.mock('../features/rich-content', () => ({
  ...jest.requireActual(
    '../features/rich-content/normalization/normalizeZhihuDocument',
  ),
  ...jest.requireActual('../features/rich-content/structuredContent'),
}));
let mockSessionVersion = 5;
jest.mock('../store/useAuthStore', () => ({
  getAuthSessionVersion: () => mockSessionVersion,
}));

const target: ExportTarget = { type: 'answer', id: '123', sessionVersion: 5 };
const detail = {
  id: '123',
  type: 'answer',
  question: { id: '456', title: '合成问题标题' },
  author: { name: '合成作者' },
  content: '<p>可访问的完整正文</p>',
  created_time: 1700000000,
  updated_time: 1700000060,
};
let controller: AbortController;
let context: ExportTaskContext;
function mockAnswer(value: unknown) {
  jest
    .mocked(getAnswer)
    .mockResolvedValue(value as Awaited<ReturnType<typeof getAnswer>>);
}
function body(text: string, next = '', id = 'first'): ZhihuStructuredContent {
  return {
    paging: JSON.stringify({
      is_end: !next,
      is_start: true,
      next,
      previous: '',
      totals: 0,
    }),
    segments: [
      { id, type: 'paragraph', paragraph: { pid: id, text, marks: [] } },
    ],
  };
}
function nextUrl(offset: number, id = '123', version = '1') {
  return `https://api.zhihu.com/next-content-render?url_token=${id}&content_type=answer&version_id=${version}&offset=${offset}`;
}
function sourceText(
  source: Awaited<ReturnType<typeof resolveExportSource>>,
): string {
  return [...walkZhihuDocument(source.document)]
    .flatMap((node) => (node.type === 'text' ? [node.text] : []))
    .join('\n');
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSessionVersion = 5;
  controller = new AbortController();
  context = {
    signal: controller.signal,
    assertActive: jest.fn(),
    onProgress: jest.fn(),
  };
  mockAnswer(detail);
});

test('loads a fresh detail with cancellation and exports source attribution', async () => {
  const source = await resolveExportSource(target, context);
  expect(getAnswer).toHaveBeenCalledWith('123', undefined, {
    signal: controller.signal,
  });
  expect(source).toMatchObject({
    title: '合成问题标题',
    author: '合成作者',
    completeness: 'complete',
    publishedAt: '2023-11-14T22:13:20.000Z',
    updatedAt: '2023-11-14T22:14:20.000Z',
    sourceUrl: 'https://www.zhihu.com/answer/123',
    warnings: [],
  });
  expect(sourceText(source)).toContain('可访问的完整正文');
  expect(getNextRender).not.toHaveBeenCalled();
});

test('continues a truncated structured answer and replaces repeated segment IDs', async () => {
  mockAnswer({
    ...detail,
    content_need_truncated: true,
    structured_content: body('旧第一段', nextUrl(20)),
  });
  jest.mocked(getNextContentRender).mockResolvedValue({
    ...body('末段', '', 'last'),
    segments: [
      ...body('更新第一段').segments,
      ...body('末段', '', 'last').segments,
    ],
  });
  const source = await resolveExportSource(target, context);
  expect(source.completeness).toBe('complete');
  expect(sourceText(source)).toBe('更新第一段\n末段');
  expect(getNextContentRender).toHaveBeenCalledWith(nextUrl(20), {
    signal: controller.signal,
    sessionVersion: 5,
  });
});

test('finds only the selected answer in the native response when detail is truncated', async () => {
  mockAnswer({ ...detail, content_need_truncated: true });
  jest.mocked(getNextRender).mockResolvedValue({
    data: [
      { id: '999', type: 'answer', structuredContent: body('其他回答') },
      {
        id: '123',
        type: 'answer',
        structuredContent: body('选定回答完整正文'),
      },
    ],
  } as Awaited<ReturnType<typeof getNextRender>>);
  const source = await resolveExportSource(target, context);
  expect(source.completeness).toBe('complete');
  expect(sourceText(source)).toBe('选定回答完整正文');
});

test('keeps accessible partial HTML when a native body cannot be loaded', async () => {
  mockAnswer({ ...detail, content_need_truncated: true });
  jest
    .mocked(getNextRender)
    .mockRejectedValue(new Error('synthetic-private-request-config'));
  const source = await resolveExportSource(target, context);
  expect(source.completeness).toBe('partial');
  expect(sourceText(source)).toContain('可访问的完整正文');
  expect(source.warnings.join('')).toContain('部分内容');
  expect(JSON.stringify(source)).not.toContain(
    'synthetic-private-request-config',
  );
});

test('retains downloaded segments and labels a failed continuation as partial', async () => {
  mockAnswer({
    ...detail,
    content_need_truncated: true,
    structured_content: body('已加载', nextUrl(20)),
  });
  jest
    .mocked(getNextContentRender)
    .mockRejectedValue(new Error('synthetic-private-request-config'));
  const source = await resolveExportSource(target, context);
  expect(source.completeness).toBe('partial');
  expect(sourceText(source)).toBe('已加载');
  expect(source.warnings.join('')).toContain('续页');
  expect(JSON.stringify(source)).not.toContain(
    'synthetic-private-request-config',
  );
});

test.each([
  'https://[invalid',
  '/next-content-render?url_token=123&content_type=answer&version_id=1&offset=20',
])('retains downloaded segments when continuation URL is invalid: %s', async (next) => {
  mockAnswer({
    ...detail,
    content_need_truncated: true,
    structured_content: body('已加载正文', next),
  });
  const source = await resolveExportSource(target, context);
  expect(source.completeness).toBe('partial');
  expect(sourceText(source)).toBe('已加载正文');
  expect(source.warnings.join('')).toContain('续页');
  expect(getNextContentRender).not.toHaveBeenCalled();
});

test('stops repeated pagination even when query parameters are reordered', async () => {
  const duplicate =
    'https://api.zhihu.com/next-content-render?offset=20&version_id=1&content_type=answer&url_token=123';
  mockAnswer({
    ...detail,
    content_need_truncated: true,
    structured_content: body('首段', nextUrl(20)),
  });
  jest
    .mocked(getNextContentRender)
    .mockResolvedValue(body('续段', duplicate, 'second'));
  const source = await resolveExportSource(target, context);
  expect(source.completeness).toBe('partial');
  expect(getNextContentRender).toHaveBeenCalledTimes(1);
});

test.each([
  nextUrl(20, '999'),
  'https://example.invalid/next-content-render?url_token=123&content_type=answer',
])('rejects a continuation belonging to another source or origin: %s', async (next) => {
  mockAnswer({
    ...detail,
    content_need_truncated: true,
    structured_content: body('首段', next),
  });
  const source = await resolveExportSource(target, context);
  expect(source.completeness).toBe('partial');
  expect(getNextContentRender).not.toHaveBeenCalled();
});

test('does not combine separate revisions while following body pages', async () => {
  mockAnswer({
    ...detail,
    content_need_truncated: true,
    structured_content: body('首段', nextUrl(20)),
  });
  jest
    .mocked(getNextContentRender)
    .mockResolvedValue(body('续段', nextUrl(40, '123', '2'), 'second'));
  const source = await resolveExportSource(target, context);
  expect(source.completeness).toBe('partial');
  expect(sourceText(source)).toBe('首段');
  expect(getNextContentRender).toHaveBeenCalledTimes(1);
});

test('rejects account changes before requesting or after receiving a detail', async () => {
  mockSessionVersion = 6;
  await expect(resolveExportSource(target, context)).rejects.toThrow(
    '登录状态已变化',
  );
  expect(getAnswer).not.toHaveBeenCalled();
  mockSessionVersion = 5;
  jest.mocked(getAnswer).mockImplementation(async () => {
    mockSessionVersion = 6;
    return detail as Awaited<ReturnType<typeof getAnswer>>;
  });
  await expect(resolveExportSource(target, context)).rejects.toThrow(
    '登录状态已变化',
  );
});

test('cancels when the account changes during continuation, without publishing partial content', async () => {
  mockAnswer({
    ...detail,
    content_need_truncated: true,
    structured_content: body('首段', nextUrl(20)),
  });
  jest.mocked(getNextContentRender).mockImplementation(async () => {
    mockSessionVersion = 6;
    return body('另一个账号的内容');
  });
  await expect(resolveExportSource(target, context)).rejects.toThrow(
    '登录状态已变化',
  );
});

test('cancels during continuation and hides network error objects', async () => {
  mockAnswer({
    ...detail,
    content_need_truncated: true,
    structured_content: body('首段', nextUrl(20)),
  });
  jest.mocked(getNextContentRender).mockImplementation(async () => {
    controller.abort();
    throw new Error('synthetic-private-request-config');
  });
  await expect(resolveExportSource(target, context)).rejects.toThrow(
    '导出已取消',
  );
});

test('returns only fixed export errors for malformed identity, copy restrictions, and network failures', async () => {
  mockAnswer({ ...detail, id: '999' });
  await expect(resolveExportSource(target, context)).rejects.toThrow(
    '返回内容与导出对象不一致',
  );
  mockAnswer({ ...detail, is_copyable: false });
  await expect(resolveExportSource(target, context)).rejects.toThrow(
    '作者已限制复制',
  );
  jest
    .mocked(getAnswer)
    .mockRejectedValue(new Error('synthetic-private-request-config'));
  await expect(resolveExportSource(target, context)).rejects.toEqual(
    new ContentExportError('正文获取失败，请稍后重试'),
  );
});

test('honors the native response copy restriction when replacing a truncated body', async () => {
  mockAnswer({ ...detail, content_need_truncated: true });
  jest.mocked(getNextRender).mockResolvedValue({
    data: [
      {
        id: '123',
        type: 'answer',
        canCopy: false,
        structuredContent: body('不可复制正文'),
      },
    ],
  } as Awaited<ReturnType<typeof getNextRender>>);
  await expect(resolveExportSource(target, context)).rejects.toThrow(
    '作者已限制复制',
  );
});

test('loads articles and empty question descriptions through the correct detail endpoint', async () => {
  jest.mocked(getArticle).mockResolvedValue({
    id: '123',
    type: 'article',
    title: '合成文章',
    content: '<p>文章正文</p>',
  } as Awaited<ReturnType<typeof getArticle>>);
  jest.mocked(getQuestion).mockResolvedValue({
    id: '123',
    type: 'question',
    title: '只有标题的问题',
    detail: '',
  });
  const article = await resolveExportSource(
    { ...target, type: 'article' },
    context,
  );
  const question = await resolveExportSource(
    { ...target, type: 'question' },
    context,
  );
  expect(sourceText(article)).toContain('文章正文');
  expect(article.sourceUrl).toBe('https://zhuanlan.zhihu.com/p/123');
  expect(question.completeness).toBe('complete');
  expect(question.document.blocks).toHaveLength(0);
  expect(getArticle).toHaveBeenCalledWith('123', { signal: controller.signal });
  expect(getQuestion).toHaveBeenCalledWith('123', undefined, {
    signal: controller.signal,
  });
});

test('preserves daily body, cover, and image credit rather than its excerpt', async () => {
  jest.mocked(getDailyDetail).mockResolvedValue({
    id: 123,
    title: '合成日报',
    body: '<p>日报完整正文</p>',
    image: 'https://example.invalid/cover.jpg',
    image_source: '合成图片来源',
  });
  const source = await resolveExportSource(
    { ...target, type: 'daily' },
    context,
  );
  expect(sourceText(source)).toContain('合成图片来源');
  expect(sourceText(source)).toContain('日报完整正文');
  expect(
    [...walkZhihuDocument(source.document)].filter(
      (node) => node.type === 'image',
    ),
  ).toEqual([
    expect.objectContaining({
      resource: expect.objectContaining({
        url: 'https://example.invalid/cover.jpg',
      }),
    }),
  ]);
  expect(source.sourceUrl).toBe('https://daily.zhihu.com/story/123');
  expect(getDailyDetail).toHaveBeenCalledWith('123', {
    signal: controller.signal,
  });
});

test('preserves pin segments and converts poll options into static content', async () => {
  jest.mocked(getPin).mockResolvedValue({
    id: '123',
    type: 'pin',
    created: 1700000000,
    comment_count: 0,
    author: {
      id: 'author',
      name: '合成想法作者',
      avatar_url: '',
      type: 'people',
    },
    content: [
      { type: 'text', content: '<p>想法正文</p>' },
      { type: 'image', url: 'https://example.invalid/pin.jpg' },
    ],
    bottom_poll: {
      voting: {
        id: 'poll',
        title: '<合成投票>',
        options: [
          { id: 'a', title: '<选项甲>' },
          { id: 'b', title: '选项乙' },
        ],
      },
    },
  });
  const source = await resolveExportSource({ ...target, type: 'pin' }, context);
  expect(sourceText(source)).toContain('想法正文');
  expect(sourceText(source)).toContain('<合成投票>');
  expect(sourceText(source)).toContain('<选项甲>');
  expect(sourceText(source)).toContain('选项乙');
  expect(source.warnings.join('')).toContain('静态选项');
  expect(getPin).toHaveBeenCalledWith('123', { signal: controller.signal });
});

test('clears an initial malformed alternative when native loading recovers the complete body', async () => {
  mockAnswer({
    ...detail,
    content_need_truncated: true,
    structured_content: { invalid: true },
  });
  jest.mocked(getNextRender).mockResolvedValue({
    data: [
      {
        id: '123',
        type: 'answer',
        structuredContent: body('恢复的完整正文'),
      },
    ],
  } as Awaited<ReturnType<typeof getNextRender>>);
  const source = await resolveExportSource(target, context);
  expect(source.completeness).toBe('complete');
  expect(source.warnings).toEqual([]);
  expect(sourceText(source)).toBe('恢复的完整正文');
});
