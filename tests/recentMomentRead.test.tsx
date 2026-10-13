import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react-native';
import type { PropsWithChildren } from 'react';
import {
  markRecentMomentsRead,
  type RecentMomentItem,
  type RecentMomentsResponse,
} from '../api/zhihu';
import { useMarkRecentMomentRead } from '../hooks/useMarkRecentMomentRead';

jest.mock('../api/zhihu', () => ({ markRecentMomentsRead: jest.fn() }));

let mockSessionVersion = 1;
jest.mock('../store/useAuthStore', () => ({
  getAuthSessionVersion: () => mockSessionVersion,
}));

const queryKey = ['recent-moments'];
let queryClient: QueryClient;

function wrapper({ children }: PropsWithChildren) {
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function moment(overrides: Partial<RecentMomentItem> = {}): RecentMomentItem {
  return {
    id: 'synthetic-moment',
    brief: 'synthetic-read-token',
    actor: {
      id: 'synthetic-author',
      url_token: 'synthetic-author-token',
      name: '合成用户',
      avatar_url: 'https://example.invalid/avatar.png',
    },
    unread_count: 3,
    ...overrides,
  };
}

function seed(items: RecentMomentItem[]) {
  return queryClient.setQueryData<RecentMomentsResponse>(queryKey, {
    data: items,
    paging: { is_end: true, is_start: true, next: '', previous: '', totals: 0 },
  });
}

function cachedItems() {
  return queryClient.getQueryData<RecentMomentsResponse>(queryKey)?.data;
}

function deferredResponse() {
  let resolve!: (value: { success: boolean }) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<{ success: boolean }>((resolveFn, rejectFn) => {
    resolve = resolveFn;
    reject = rejectFn;
  });
  jest.mocked(markRecentMomentsRead).mockReturnValueOnce(promise);
  return { resolve, reject };
}

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  mockSessionVersion = 1;
  jest.mocked(markRecentMomentsRead).mockReset();
  jest.mocked(markRecentMomentsRead).mockResolvedValue({ success: true });
});

afterEach(() => queryClient.clear());

test('marks only the selected actor and restores the current cached unread count on failure', async () => {
  const item = moment();
  const other = moment({ actor: { ...item.actor, id: 'other-author' } });
  seed([item, other]);
  const response = deferredResponse();
  const hook = await renderHook(useMarkRecentMomentRead, { wrapper });

  await act(() => hook.result.current({ ...item, unread_count: 99 }));

  expect(cachedItems()).toEqual([{ ...item, unread_count: 0 }, other]);
  expect(markRecentMomentsRead).toHaveBeenCalledWith(item.brief);
  await act(() => response.resolve({ success: false }));
  expect(cachedItems()).toEqual([item, other]);
});

test('restores on rejected requests and allows a later retry', async () => {
  const item = moment();
  seed([item]);
  const response = deferredResponse();
  const hook = await renderHook(useMarkRecentMomentRead, { wrapper });

  await act(() => hook.result.current(item));
  await act(() => response.reject(new Error('synthetic failure')));
  expect(cachedItems()).toEqual([item]);

  await act(() => hook.result.current(item));
  expect(markRecentMomentsRead).toHaveBeenCalledTimes(2);
  expect(cachedItems()).toEqual([{ ...item, unread_count: 0 }]);
});

test('deduplicates repeated selection across hook instances and in-flight refreshes', async () => {
  const item = moment();
  seed([item]);
  const response = deferredResponse();
  const hook = await renderHook(
    () => [useMarkRecentMomentRead(), useMarkRecentMomentRead()] as const,
    { wrapper },
  );

  await act(() => {
    hook.result.current[0](item);
    hook.result.current[1](item);
    hook.result.current[0](item);
  });
  expect(markRecentMomentsRead).toHaveBeenCalledTimes(1);

  seed([item]);
  await act(() => hook.result.current[1](item));
  expect(markRecentMomentsRead).toHaveBeenCalledTimes(1);
  await act(() => response.resolve({ success: true }));
});

test('returning to a successfully read user does not request again', async () => {
  const item = moment();
  seed([item]);
  const hook = await renderHook(useMarkRecentMomentRead, { wrapper });

  await act(() => hook.result.current(item));
  await act(() => hook.result.current(item));

  expect(markRecentMomentsRead).toHaveBeenCalledTimes(1);
});

test('ignores missing users, read entries, missing tokens, and stale update tokens', async () => {
  const item = moment();
  const hook = await renderHook(useMarkRecentMomentRead, { wrapper });

  await act(() => hook.result.current(item));
  seed([moment({ unread_count: 0 })]);
  await act(() => hook.result.current(item));
  seed([moment({ brief: undefined, id: undefined })]);
  await act(() =>
    hook.result.current(moment({ brief: undefined, id: undefined })),
  );
  seed([moment({ brief: 'new-synthetic-token' })]);
  await act(() => hook.result.current(item));

  expect(markRecentMomentsRead).not.toHaveBeenCalled();
  expect(cachedItems()?.[0].unread_count).toBe(3);
});

test('uses the id fallback and reads only the matching cached version', async () => {
  const item = moment({ brief: undefined });
  seed([item]);
  const hook = await renderHook(useMarkRecentMomentRead, { wrapper });

  await act(() => hook.result.current({ ...item, unread_count: 0 }));

  expect(markRecentMomentsRead).toHaveBeenCalledWith(item.id);
  expect(cachedItems()?.[0].unread_count).toBe(0);
});

test.each([
  { brief: 'new-synthetic-token', unread_count: 5 },
  { brief: 'synthetic-read-token', unread_count: 5 },
])('an old failure preserves a newer cache item: %j', async (update) => {
  const item = moment();
  seed([item]);
  const response = deferredResponse();
  const hook = await renderHook(useMarkRecentMomentRead, { wrapper });

  await act(() => hook.result.current(item));
  const newer = moment(update);
  seed([newer]);
  await act(() => response.resolve({ success: false }));

  expect(cachedItems()).toEqual([newer]);
});

test('rolling back one user preserves updates to other users', async () => {
  const item = moment();
  const other = moment({ actor: { ...item.actor, id: 'other-author' } });
  seed([item, other]);
  const response = deferredResponse();
  const hook = await renderHook(useMarkRecentMomentRead, { wrapper });

  await act(() => hook.result.current(item));
  const newerOther = { ...other, unread_count: 8 };
  seed([{ ...item, unread_count: 0 }, newerOther]);
  await act(() => response.resolve({ success: false }));

  expect(cachedItems()).toEqual([item, newerOther]);
});

test('old-session failures cannot restore unread counts after switching accounts', async () => {
  const item = moment();
  seed([item]);
  const response = deferredResponse();
  const hook = await renderHook(useMarkRecentMomentRead, { wrapper });

  await act(() => hook.result.current(item));
  mockSessionVersion += 1;
  // Preserve the same structurally shared optimistic item to exercise the
  // session guard independently of the object identity guard.
  seed([{ ...item, unread_count: 0 }]);
  await act(() =>
    response.reject(new Error('synthetic previous-session error')),
  );

  expect(cachedItems()).toEqual([{ ...item, unread_count: 0 }]);
});

test('a pending old session does not block marking the new account read', async () => {
  const item = moment();
  seed([item]);
  const oldResponse = deferredResponse();
  const newResponse = deferredResponse();
  const hook = await renderHook(useMarkRecentMomentRead, { wrapper });

  await act(() => hook.result.current(item));
  mockSessionVersion += 1;
  seed([item]);
  await act(() => hook.result.current(item));
  expect(markRecentMomentsRead).toHaveBeenCalledTimes(2);

  await act(() => oldResponse.resolve({ success: false }));
  expect(cachedItems()?.[0].unread_count).toBe(0);
  await act(() => newResponse.resolve({ success: false }));
  expect(cachedItems()).toEqual([item]);
});

test('an old failure cannot recreate cleared cache or modify a replacement query', async () => {
  const item = moment();
  seed([item]);
  const response = deferredResponse();
  const hook = await renderHook(useMarkRecentMomentRead, { wrapper });

  await act(() => hook.result.current(item));
  const optimistic = cachedItems();
  queryClient.removeQueries({ queryKey, exact: true });
  if (!optimistic) throw new Error('Expected an optimistic cache entry');
  seed(optimistic);
  await act(() => response.resolve({ success: false }));

  expect(cachedItems()?.[0].unread_count).toBe(0);

  seed([item]);
  const nextResponse = deferredResponse();
  await act(() => hook.result.current(item));
  queryClient.removeQueries({ queryKey, exact: true });
  await act(() => nextResponse.resolve({ success: false }));
  expect(cachedItems()).toBeUndefined();
});
