import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import type { PropsWithChildren, ReactNode } from 'react';
import { Gesture } from 'react-native-gesture-handler';
import {
  fetchRecentMoments,
  markRecentMomentsRead,
  type RecentMomentItem,
  type RecentMomentsResponse,
} from '../api/zhihu';
import { RecentMoments } from '../components/RecentMoments';
import { useNestedHorizontalGesture } from '../hooks/useNestedHorizontalGesture';

const mockPush = jest.fn();

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
}));
jest.mock('../api/zhihu', () => ({
  fetchRecentMoments: jest.fn(),
  markRecentMomentsRead: jest.fn(),
}));
jest.mock('react-native-gesture-handler', () => ({
  ...jest.requireActual('react-native-gesture-handler'),
  GestureDetector: ({ children }: { children: ReactNode }) => children,
}));
jest.mock('../hooks/useNestedHorizontalGesture', () => ({
  useNestedHorizontalGesture: jest.fn(
    jest.requireActual('../hooks/useNestedHorizontalGesture')
      .useNestedHorizontalGesture,
  ),
}));
jest.mock('../components/StableAvatar', () => ({ StableAvatar: () => null }));
jest.mock('../components/Themed', () => {
  const native = jest.requireActual('react-native');
  return { Text: native.Text, View: native.View, useThemeColor: () => '#00f' };
});

let queryClient: QueryClient;

function wrapper({ children }: PropsWithChildren) {
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function moment(urlToken = 'synthetic-token'): RecentMomentItem {
  return {
    id: 'synthetic-moment',
    brief: 'synthetic-read-token',
    actor: {
      id: 'synthetic-actor-id',
      url_token: urlToken,
      name: '合成用户',
      avatar_url: '',
    },
    unread_count: 137,
  };
}

function seed(items: RecentMomentItem[]) {
  return queryClient.setQueryData<RecentMomentsResponse>(['recent-moments'], {
    data: items,
    paging: {
      is_end: true,
      is_start: true,
      next: '',
      previous: '',
      totals: items.length,
    },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, gcTime: Infinity },
    },
  });
  jest
    .mocked(fetchRecentMoments)
    .mockImplementation(() => new Promise<RecentMomentsResponse>(() => {}));
});

afterEach(() => queryClient.clear());

test.each([
  ['synthetic-token', 'synthetic-token'],
  ['', 'synthetic-actor-id'],
])('opens the selected actor using token %j without marking unseen content read', async (urlToken, expectedId) => {
  const item = moment(urlToken);
  const before = seed([item]);
  const host = await render(<RecentMoments />, { wrapper });

  await fireEvent.press(host.getByText(item.actor.name));

  expect(mockPush).toHaveBeenCalledWith({
    pathname: '/user/[id]/stream',
    params: {
      id: expectedId,
      unreadCount: '137',
      source: 'recent-moments',
    },
  });
  expect(markRecentMomentsRead).not.toHaveBeenCalled();
  expect(queryClient.getQueryData(['recent-moments'])).toEqual(before);
  await host.unmount();
});

test('keeps hooks mounted across loading, empty results, restoration and focus changes', async () => {
  const onInteractionChange = jest.fn();
  const parentGesture = Gesture.Native();
  const host = await render(
    <RecentMoments
      onInteractionChange={onInteractionChange}
      parentGesture={parentGesture}
    />,
    { wrapper },
  );
  const gestureHook = jest.mocked(useNestedHorizontalGesture);
  const item = moment();
  expect(host.toJSON()).toBeNull();
  expect(gestureHook).toHaveBeenLastCalledWith(
    onInteractionChange,
    false,
    parentGesture,
  );

  await act(() => seed([item]));
  await waitFor(() => expect(host.getByText(item.actor.name)).toBeTruthy());
  expect(gestureHook).toHaveBeenLastCalledWith(
    onInteractionChange,
    true,
    parentGesture,
  );

  await act(() => seed([]));
  await waitFor(() => expect(host.toJSON()).toBeNull());
  expect(gestureHook).toHaveBeenLastCalledWith(
    onInteractionChange,
    false,
    parentGesture,
  );

  await act(() => seed([item]));
  await waitFor(() => expect(host.getByText(item.actor.name)).toBeTruthy());
  expect(gestureHook).toHaveBeenLastCalledWith(
    onInteractionChange,
    true,
    parentGesture,
  );

  await host.rerender(
    <RecentMoments
      isActive={false}
      onInteractionChange={onInteractionChange}
      parentGesture={parentGesture}
    />,
  );
  expect(gestureHook).toHaveBeenLastCalledWith(
    onInteractionChange,
    false,
    parentGesture,
  );
  await host.rerender(
    <RecentMoments
      isActive
      onInteractionChange={onInteractionChange}
      parentGesture={parentGesture}
    />,
  );
  expect(gestureHook).toHaveBeenLastCalledWith(
    onInteractionChange,
    true,
    parentGesture,
  );
  await host.unmount();
});
