import { QueryClient } from '@tanstack/react-query';
import { AxiosHeaders, type AxiosResponse } from 'axios';
import apiClient from '../api/client';
import { getAnswer } from '../api/zhihu/answer';
import { getArticle } from '../api/zhihu/article';
import { getContentCollectionMetadata } from '../api/zhihu/contentCollection';
import type { FeedItem } from '../api/zhihu/feed';
import {
  getMemberRelations,
  getRecentMemberActivities,
  MEMBER_ANSWERS_INCLUDE,
} from '../api/zhihu/member';
import { getTopicFeed } from '../api/zhihu/topic';
import { createAnswerPreviewEntry } from '../utils/answerPreviewEntry';
import {
  seedRichContentFromFeedItem,
  updateContentInteractionCaches,
} from '../utils/contentCache';

jest.mock('../api/client', () => ({
  __esModule: true,
  default: { get: jest.fn() },
}));
jest.mock('../store/useAuthStore', () => ({ getAuthSessionVersion: () => 1 }));
jest.mock('../features/rich-content', () =>
  jest.requireActual('../features/rich-content/queryPolicy'),
);

const get = jest.mocked(apiClient.get);
function response(data: unknown): AxiosResponse<unknown> {
  return {
    data,
    status: 200,
    statusText: 'OK',
    headers: {},
    config: { headers: new AxiosHeaders() },
  };
}
beforeEach(() => get.mockReset());

test.each([
  [
    { relationship: { is_favorited: true }, favlists_count: 5 },
    { isCollected: true, favlistsCount: 5 },
  ],
  [
    { reaction: { relation: { faved: false }, statistics: { favorites: 0 } } },
    { isCollected: false, favlistsCount: 0 },
  ],
  [
    { virtuals: { is_favorited: true }, favorite_count: 9 },
    { isCollected: true, favlistsCount: 9 },
  ],
  [
    {
      isCollected: false,
      favlistsCount: 0,
      relationship: { is_favorited: true },
      favlists_count: 3,
    },
    { isCollected: false, favlistsCount: 0 },
  ],
  [
    {
      reaction: { relation: { faved: false } },
      relationship: { is_favorited: true },
    },
    { isCollected: false },
  ],
  [
    { favlists_count: 0, reaction: { statistics: { favorites: 8 } } },
    { favlistsCount: 0 },
  ],
  [
    { favlists_count: -1, reaction: { statistics: { favorites: 8 } } },
    { favlistsCount: 8 },
  ],
  [{ relationship: { is_favorited: 'false' }, favlists_count: '5' }, {}],
  [
    {
      isCollected: 1,
      favlistsCount: Number.NaN,
      favlists_count: Number.POSITIVE_INFINITY,
      favorite_count: 1.5,
    },
    {},
  ],
  [{}, {}],
  [null, {}],
])('normalizes collection metadata without guessing unknown values: %j', (input, expected) => {
  expect(getContentCollectionMetadata(input)).toEqual(expected);
});

test('clicked normalized feed entries retain known and unknown collection metadata', () => {
  expect(
    createAnswerPreviewEntry({
      id: 'known',
      content: '合成正文',
      isCollected: false,
      favlistsCount: 0,
    }),
  ).toMatchObject({
    relationship: { is_favorited: false },
    favlists_count: 0,
  });
  const unknown = createAnswerPreviewEntry({
    id: 'unknown',
    content: '合成正文',
  });
  expect(unknown?.relationship.is_favorited).toBeUndefined();
  expect(unknown?.favlists_count).toBeUndefined();
});

test('content requests include collection state and counts while retaining caller fields', async () => {
  get.mockResolvedValue(response({ data: [], paging: { is_end: true } }));
  await getAnswer('answer-a');
  let include = new URL(
    String(get.mock.calls[0][0]),
    'https://www.zhihu.com',
  ).searchParams.get('include');
  expect(include).toContain('favlists_count');
  expect(include).toContain('relationship.is_favorited');
  await getArticle('article-a');
  expect(get.mock.calls[1][1]?.params).toMatchObject({
    include: expect.stringContaining('favlists_count'),
  });
  expect(get.mock.calls[1][1]?.params).toMatchObject({
    include: expect.stringContaining('relationship.is_favorited'),
  });
  for (const type of ['answers', 'articles'] as const) {
    await getMemberRelations('member-a', type, {
      include: 'data[*].content',
      offset: 20,
    });
    const params = get.mock.lastCall?.[1]?.params;
    for (const field of [
      'data[*].content',
      'favlists_count',
      'relationship.is_favorited',
    ]) {
      expect(params).toMatchObject({
        include: expect.stringContaining(field),
        offset: 20,
      });
    }
  }
  expect(MEMBER_ANSWERS_INCLUDE).toContain('favlists_count');
  expect(MEMBER_ANSWERS_INCLUDE).toContain('is_favorited');
  await getTopicFeed('topic-a');
  include = new URL(
    String(get.mock.lastCall?.[0]),
    'https://www.zhihu.com',
  ).searchParams.get('include');
  expect(include).toContain('favlists_count');
  expect(include).toContain('relationship.is_favorited');
});

test('recent activities preserve collection status when no voting field is present', async () => {
  get.mockResolvedValue(
    response({
      data: [
        {
          target: {
            id: 'answer-a',
            type: 'answer',
            relationship: { is_favorited: true },
            favlists_count: 4,
          },
        },
      ],
      paging: { is_end: true },
    }),
  );
  const page = await getRecentMemberActivities('member-a', {
    offset: 0,
    pageNum: 1,
  });
  expect(getContentCollectionMetadata(page.data[0].target)).toEqual({
    isCollected: true,
    favlistsCount: 4,
  });
});

test('collection mutations update normalized feed aliases and raw caches without inventing counts', () => {
  const client = new QueryClient();
  const item: FeedItem = {
    id: 'answer-a',
    type: 'answers',
    questionId: 'question-a',
    title: '合成问题',
    content: '<p>合成正文</p>',
    excerpt: '',
    image: null,
    author: { id: 'author-a', name: '合成作者', avatar: '' },
    voteCount: 1,
    voted: 0,
    commentCount: 2,
    favlistsCount: 8,
    isCollected: true,
  };
  const unrelated = { ...item, id: 'answer-b' };
  const page = { pages: [{ data: [item, unrelated] }], pageParams: [0] };
  client.setQueryData(['feed'], page);
  seedRichContentFromFeedItem(client, item);
  expect(client.getQueryData(['answer-detail', item.id])).toMatchObject({
    relationship: { is_favorited: true },
    favlists_count: 8,
  });
  updateContentInteractionCaches(client, {
    type: 'answers',
    id: item.id,
    isCollected: false,
  });
  const updated = client.getQueryData<typeof page>(['feed']);
  expect(updated?.pages[0].data[0]).toMatchObject({
    isCollected: false,
    favlistsCount: 8,
  });
  expect(updated?.pages[0].data[1]).toBe(unrelated);
  expect(item.isCollected).toBe(true);
  expect(client.getQueryData(['answer-detail', item.id])).toMatchObject({
    relationship: { is_favorited: false },
    reaction: { relation: { faved: false } },
    favlists_count: 8,
  });
  client.clear();
});
