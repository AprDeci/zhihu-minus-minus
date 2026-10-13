import type { FlashListProps } from '@shopify/flash-list';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render } from '@testing-library/react-native';
import {
  type FeedItem,
  getMemberWithFallback,
  searchContent,
} from '../api/zhihu';
import type { ZhihuMember } from '../api/zhihu/member';
import UserSearchScreen from '../app/user/[id]/search';
import {
  getProfileFeedBody,
  toProfileSearchFeedItem,
} from '../components/profile/profileSearchResults';
import type { ZhihuSearchResponse } from '../types/zhihu';
import type { AnswerReadingContext } from '../utils/answerReadingContext';

const member: ZhihuMember = {
  id: 'synthetic-member-hash',
  url_token: 'synthetic-member-token',
  name: '合成作者',
  type: 'people',
  avatar_url: '',
};
let mockRoute = { id: member.url_token };
let mockListProps: FlashListProps<FeedItem>;
const mockFeedContexts = new Map<string, AnswerReadingContext | undefined>();
const mockBack = jest.fn();
const mockReplace = jest.fn();
let mockCanGoBack = true;

jest.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  useLocalSearchParams: () => mockRoute,
  useRouter: () => ({
    back: mockBack,
    replace: mockReplace,
    canGoBack: () => mockCanGoBack,
  }),
}));
jest.mock('../api/zhihu', () => ({
  getMemberWithFallback: jest.fn(),
  searchContent: jest.fn(),
  getContentVoteCount: () => 0,
  getContentVoteState: () => 0,
  getContentCollectionMetadata: jest.requireActual<
    typeof import('../api/zhihu/contentCollection')
  >('../api/zhihu/contentCollection').getContentCollectionMetadata,
}));
jest.mock('@expo/vector-icons/Ionicons', () => () => null);
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 44, bottom: 24, left: 0, right: 0 }),
}));
jest.mock('../store/useSettingsStore', () => ({
  useSettingsStore: (selector: (state: { fontSizeScale: number }) => unknown) =>
    selector({ fontSizeScale: 1 }),
}));
jest.mock('../components/Themed', () => {
  const native = jest.requireActual('react-native');
  return {
    Text: native.Text,
    View: native.View,
    useThemeColor: () => '#1364cc',
    useRuntimeThemeColors: () => ({
      text: '#111111',
      textTertiary: '#777777',
      primary: '#1364cc',
      link: '#1364cc',
      backgroundTertiary: '#eeeeee',
      border: '#dddddd',
    }),
  };
});
jest.mock('../components/BouncyButton', () => ({
  BouncyButton: jest.requireActual('react-native').Pressable,
}));
jest.mock('../components/FeedCard', () => ({
  FeedCard: ({
    item,
    answerContext,
  }: {
    item: FeedItem;
    answerContext?: AnswerReadingContext;
  }) => {
    mockFeedContexts.set(item.id, answerContext);
    return jest
      .requireActual('react')
      .createElement(jest.requireActual('react-native').Text, null, item.title);
  },
}));
jest.mock('@shopify/flash-list', () => ({
  FlashList: (props: FlashListProps<FeedItem>) => {
    mockListProps = props;
    const react = jest.requireActual('react');
    return react.createElement(
      jest.requireActual('react-native').View,
      null,
      props.data?.length
        ? props.data.map((item, index) =>
            react.createElement(
              react.Fragment,
              { key: props.keyExtractor?.(item, index) },
              props.renderItem?.({ item, index, target: 'Cell' }),
            ),
          )
        : props.ListEmptyComponent,
      props.ListFooterComponent,
    );
  },
}));

function page(title?: string, offset?: number): ZhihuSearchResponse {
  return {
    data: title
      ? [
          {
            type: 'search_result',
            index: 0,
            highlight: {},
            object: {
              id: title,
              type: 'answer',
              question: { id: `question-${title}`, title },
            },
          },
        ]
      : [],
    paging: {
      is_end: offset === undefined,
      is_start: true,
      next:
        offset === undefined ? '' : `https://example.test/?offset=${offset}`,
      previous: '',
    },
  };
}

let client: QueryClient;
beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockFeedContexts.clear();
  mockCanGoBack = true;
  mockRoute = { id: member.url_token };
  client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity, staleTime: Infinity },
    },
  });
  client.setQueryData(['user-detail', mockRoute.id], member);
  jest.mocked(getMemberWithFallback).mockResolvedValue(member);
  jest.mocked(searchContent).mockReset().mockResolvedValue(page());
});
afterEach(async () => {
  await act(async () => {
    await jest.runOnlyPendingTimersAsync();
  });
  client.clear();
  jest.useRealTimers();
});

const screen = () => (
  <QueryClientProvider client={client}>
    <UserSearchScreen />
  </QueryClientProvider>
);

async function flush(duration = 1) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(duration);
  });
  await act(async () => {
    await jest.advanceTimersByTimeAsync(1);
  });
}

test('entry focuses search; only trimmed, nonempty terms search the member hash', async () => {
  const result = page('第一条创作');
  Object.assign(result.data[0].object, {
    content: '<p>合成完整正文</p>',
    author: { ...member, type: 'people' },
    favlists_count: 13,
    relationship: { is_favorited: true },
  });
  jest.mocked(searchContent).mockResolvedValue(result);
  const host = await render(screen());
  const input = host.getByLabelText('搜索此用户的创作');
  expect(input.props.autoFocus).toBe(true);
  expect(host.getByText('输入关键词，搜索这位用户的创作')).toBeTruthy();
  await fireEvent.changeText(input, '   ');
  await flush(350);
  expect(searchContent).not.toHaveBeenCalled();
  await fireEvent.changeText(input, '  创作  ');
  await flush(350);
  expect(searchContent).toHaveBeenCalledWith('创作', 0, 20, 'general', {
    restricted_scene: 'member',
    restricted_field: 'member_hash_id',
    restricted_value: member.id,
    signal: expect.objectContaining({ aborted: false }),
  });
  expect(host.getByText('第一条创作')).toBeTruthy();
  expect(mockListProps.data?.[0].content).toBe('<p>合成完整正文</p>');
  expect(mockListProps.data?.[0]).toMatchObject({
    isCollected: true,
    favlistsCount: 13,
  });
  expect(mockFeedContexts.get('第一条创作')).toEqual({
    scene: 'profile_answer',
    memberId: mockRoute.id,
    memberSort: 'created',
  });
  expect(
    getProfileFeedBody({ content: '<p>摘要正文</p>', paid_info: {} }),
  ).toMatchObject({ answerType: 'PAID' });
  expect(
    getProfileFeedBody({
      content: '<p>截断正文</p>',
      content_need_truncated: 'true',
    }),
  ).toMatchObject({ contentNeedTruncated: true });
  expect(
    getProfileFeedBody({
      content: [
        { type: 'text', content: '可复用' },
        { type: 'image', url: 7 },
      ],
    }).content,
  ).toBeUndefined();

  await fireEvent.changeText(input, '另一词');
  expect(host.queryByText('第一条创作')).toBeNull();
  await fireEvent.press(host.getByLabelText('清空搜索'));
  await flush(350);
  expect(searchContent).toHaveBeenCalledTimes(1);
  expect(host.getByText('输入关键词，搜索这位用户的创作')).toBeTruthy();
  await host.unmount();
});

test('pagination retries explicitly after failure and refresh resets to the initial page', async () => {
  jest
    .mocked(searchContent)
    .mockResolvedValueOnce(page('第一页', 20))
    .mockRejectedValueOnce(new Error('synthetic offline'))
    .mockResolvedValueOnce(page('第二页'))
    .mockResolvedValueOnce(page('刷新结果'));
  const host = await render(screen());
  await fireEvent.changeText(host.getByLabelText('搜索此用户的创作'), '分页');
  await flush(350);
  await act(() => {
    mockListProps.onEndReached?.();
    mockListProps.onEndReached?.();
  });
  await flush();
  expect(searchContent).toHaveBeenCalledTimes(2);
  expect(host.getByText('第一页')).toBeTruthy();
  expect(mockFeedContexts.get('第一页')).toEqual({ scene: 'unknown' });
  expect(host.getByText('更多结果加载失败')).toBeTruthy();
  await act(() => mockListProps.onEndReached?.());
  expect(searchContent).toHaveBeenCalledTimes(2);
  await fireEvent.press(host.getByText('重新加载'));
  await flush();
  expect(host.getByText('第二页')).toBeTruthy();
  expect(jest.mocked(searchContent).mock.calls.map((call) => call[1])).toEqual([
    0, 20, 20,
  ]);

  await act(() => mockListProps.onRefresh?.());
  await flush();
  expect(host.getByText('刷新结果')).toBeTruthy();
  expect(host.queryByText('第二页')).toBeNull();
  expect(jest.mocked(searchContent).mock.calls.map((call) => call[1])).toEqual([
    0, 20, 20, 0,
  ]);
  await host.unmount();
});

test('failed first search retries and a nonadvancing page cursor stops pagination', async () => {
  jest
    .mocked(searchContent)
    .mockRejectedValueOnce(new Error('synthetic offline'))
    .mockResolvedValueOnce(page('恢复的创作', 0));
  const host = await render(screen());
  await fireEvent.changeText(host.getByLabelText('搜索此用户的创作'), '重试');
  await fireEvent(host.getByLabelText('搜索此用户的创作'), 'submitEditing');
  await flush();
  expect(host.getByText('搜索失败，请重试')).toBeTruthy();
  await fireEvent.press(host.getByText('重新加载'));
  await flush();
  expect(host.getByText('恢复的创作')).toBeTruthy();
  await act(() => mockListProps.onEndReached?.());
  expect(searchContent).toHaveBeenCalledTimes(2);
  await host.unmount();
});

test('switching profiles clears the term and direct-entry back returns to that profile', async () => {
  const host = await render(screen());
  await fireEvent.changeText(host.getByLabelText('搜索此用户的创作'), '未发送');
  const otherMember = {
    ...member,
    id: 'second-hash',
    url_token: 'second-token',
  };
  mockRoute = { id: otherMember.url_token };
  client.setQueryData(['user-detail', mockRoute.id], otherMember);
  await host.rerender(screen());
  await flush(350);
  expect(host.getByLabelText('搜索此用户的创作').props.value).toBe('');
  expect(searchContent).not.toHaveBeenCalled();
  mockCanGoBack = false;
  await fireEvent.press(host.getByLabelText('返回个人主页'));
  expect(mockReplace).toHaveBeenCalledWith({
    pathname: '/user/[id]',
    params: { id: 'second-token' },
  });
  mockCanGoBack = true;
  await fireEvent.press(host.getByLabelText('返回个人主页'));
  expect(mockBack).toHaveBeenCalledTimes(1);
  await host.unmount();
});

test.each([
  ['video', 'lens'],
  ['videos', 'lens'],
  ['zvideo', 'zvideo'],
  ['zvideos', 'zvideo'],
] as const)('profile search preserves raw video type %s as source %s', (type, videoSource) => {
  expect(
    toProfileSearchFeedItem(
      {
        type: 'search_result',
        index: 0,
        highlight: {},
        object: { id: '2088306465639604943', type, title: '用户视频' },
      },
      member,
      '#00f',
    ),
  ).toMatchObject({ id: '2088306465639604943', type: 'videos', videoSource });
});

test('profile search preserves a known zero count and leaves unavailable collection data unknown', () => {
  const result = page('合成搜索结果').data[0];
  Object.assign(result.object, {
    favlists_count: 0,
    favorite_count: 8,
    relationship: { is_favorited: false },
  });
  expect(toProfileSearchFeedItem(result, member, '#00f')).toMatchObject({
    isCollected: false,
    favlistsCount: 0,
  });
  const unknown = toProfileSearchFeedItem(
    page('缺少收藏数据').data[0],
    member,
    '#00f',
  );
  expect(unknown?.isCollected).toBeUndefined();
  expect(unknown?.favlistsCount).toBeUndefined();
});
