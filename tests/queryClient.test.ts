import {
  focusManager,
  InfiniteQueryObserver,
  onlineManager,
  type QueryClient,
  QueryObserver,
} from '@tanstack/react-query';
import { AxiosError } from 'axios';
import { createAppQueryClient } from '../utils/queryClient';

describe('automatic read recovery', () => {
  let client: QueryClient;
  let cleanups: Array<() => void>;

  beforeEach(() => {
    jest.useFakeTimers();
    onlineManager.setOnline(true);
    focusManager.setFocused(true);
    client = createAppQueryClient();
    client.mount();
    cleanups = [];
  });

  afterEach(() => {
    for (const cleanup of cleanups) cleanup();
    client.unmount();
    client.clear();
    onlineManager.setOnline(true);
    focusManager.setFocused(undefined);
    jest.useRealTimers();
  });

  function resume(event: 'focus' | 'reconnect') {
    if (event === 'focus') {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    } else {
      onlineManager.setOnline(false);
      onlineManager.setOnline(true);
    }
  }

  test.each([
    'focus',
    'reconnect',
  ] as const)('%s retains a cached infinite list without refetching its five pages', async (event) => {
    const queryFn = jest.fn(
      async ({ pageParam }: { pageParam: number }) => pageParam,
    );
    const cached = { pages: [0, 1, 2, 3, 4], pageParams: [0, 1, 2, 3, 4] };
    const observer = new InfiniteQueryObserver(client, {
      queryKey: ['cached-pages'],
      initialPageParam: 0,
      initialData: cached,
      queryFn,
      getNextPageParam: (lastPage) => lastPage + 1,
      staleTime: 0,
      refetchOnMount: false,
    });
    cleanups.push(observer.subscribe(() => undefined));

    resume(event);
    await jest.advanceTimersByTimeAsync(0);

    expect(queryFn).not.toHaveBeenCalled();
    expect(observer.getCurrentResult().data).toEqual(cached);
    expect(observer.getCurrentResult().isFetching).toBe(false);
    await observer.fetchNextPage();
    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(observer.getCurrentResult().data?.pages).toEqual([0, 1, 2, 3, 4, 5]);
  });

  test.each([
    'focus',
    'reconnect',
  ] as const)('%s retries an infinite list whose first page failed', async (event) => {
    const queryFn = jest
      .fn()
      .mockRejectedValueOnce(new Error('synthetic first-page failure'))
      .mockResolvedValue(0);
    const observer = new InfiniteQueryObserver(client, {
      queryKey: ['failed-first-page'],
      initialPageParam: 0,
      queryFn,
      getNextPageParam: (lastPage: number) => lastPage + 1,
      retry: false,
    });
    cleanups.push(observer.subscribe(() => undefined));
    await jest.advanceTimersByTimeAsync(0);
    expect(observer.getCurrentResult().isError).toBe(true);
    expect(observer.getCurrentResult().data).toBeUndefined();

    resume(event);
    await jest.advanceTimersByTimeAsync(0);

    expect(queryFn).toHaveBeenCalledTimes(2);
    expect(observer.getCurrentResult().data).toEqual({
      pages: [0],
      pageParams: [0],
    });
  });

  test('reconnect starts an infinite list opened offline with no cached data', async () => {
    onlineManager.setOnline(false);
    const queryFn = jest.fn(async () => 0);
    const observer = new InfiniteQueryObserver(client, {
      queryKey: ['offline-first-page'],
      initialPageParam: 0,
      queryFn,
      getNextPageParam: (lastPage) => lastPage + 1,
    });
    cleanups.push(observer.subscribe(() => undefined));
    expect(observer.getCurrentResult().isPaused).toBe(true);
    expect(queryFn).not.toHaveBeenCalled();

    onlineManager.setOnline(true);
    await jest.advanceTimersByTimeAsync(0);

    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(observer.getCurrentResult().data?.pages).toEqual([0]);
  });

  test('reconnect fetches the first page when the initialized cache has no pages', async () => {
    const queryFn = jest.fn(async () => 0);
    const observer = new InfiniteQueryObserver(client, {
      queryKey: ['empty-pages'],
      initialPageParam: 0,
      initialData: { pages: [], pageParams: [] },
      queryFn,
      getNextPageParam: (lastPage) => lastPage + 1,
      staleTime: 0,
      refetchOnMount: false,
    });
    cleanups.push(observer.subscribe(() => undefined));

    resume('reconnect');
    await jest.advanceTimersByTimeAsync(0);

    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(observer.getCurrentResult().data).toEqual({
      pages: [0],
      pageParams: [0],
    });
  });

  test('reconnect resumes a paused next page without refetching cached pages', async () => {
    const queryFn = jest.fn(
      async ({ pageParam }: { pageParam: number }) => pageParam,
    );
    const observer = new InfiniteQueryObserver(client, {
      queryKey: ['paused-next-page'],
      initialPageParam: 0,
      initialData: { pages: [0, 1], pageParams: [0, 1] },
      queryFn,
      getNextPageParam: (lastPage) => lastPage + 1,
      refetchOnMount: false,
    });
    cleanups.push(observer.subscribe(() => undefined));
    onlineManager.setOnline(false);
    const pagination = observer.fetchNextPage();
    expect(observer.getCurrentResult().isPaused).toBe(true);
    expect(queryFn).not.toHaveBeenCalled();

    onlineManager.setOnline(true);
    await jest.advanceTimersByTimeAsync(0);
    await pagination;

    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(queryFn.mock.calls[0][0].pageParam).toBe(2);
    expect(observer.getCurrentResult().data?.pages).toEqual([0, 1, 2]);
  });

  test('a failed next page retains cached pages until an explicit pagination retry', async () => {
    const queryFn = jest
      .fn()
      .mockRejectedValueOnce(new Error('synthetic next-page failure'))
      .mockResolvedValue(2);
    const observer = new InfiniteQueryObserver(client, {
      queryKey: ['failed-next-page'],
      initialPageParam: 0,
      initialData: { pages: [0, 1], pageParams: [0, 1] },
      queryFn,
      getNextPageParam: (lastPage: number) => lastPage + 1,
      retry: false,
      refetchOnMount: false,
    });
    cleanups.push(observer.subscribe(() => undefined));
    await observer.fetchNextPage();
    expect(observer.getCurrentResult().isFetchNextPageError).toBe(true);

    resume('focus');
    resume('reconnect');
    await jest.advanceTimersByTimeAsync(0);

    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(observer.getCurrentResult().data?.pages).toEqual([0, 1]);
    await observer.fetchNextPage();
    expect(queryFn).toHaveBeenCalledTimes(2);
    expect(queryFn.mock.calls.map(([context]) => context.pageParam)).toEqual([
      2, 2,
    ]);
    expect(observer.getCurrentResult().data?.pages).toEqual([0, 1, 2]);
  });

  test.each([
    'focus',
    'reconnect',
  ] as const)('%s preserves ordinary stale-query refresh', async (event) => {
    const queryFn = jest.fn(async () => 'fresh content');
    const observer = new QueryObserver(client, {
      queryKey: ['ordinary-query'],
      initialData: 'cached content',
      queryFn,
      staleTime: 0,
      refetchOnMount: false,
    });
    cleanups.push(observer.subscribe(() => undefined));

    resume(event);
    await jest.advanceTimersByTimeAsync(0);

    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(observer.getCurrentResult().data).toBe('fresh content');
  });
});

test('an offline write fails without being queued or sent again on reconnect', async () => {
  const client = createAppQueryClient();
  client.mount();
  onlineManager.setOnline(false);
  const mutationFn = jest
    .fn()
    .mockRejectedValue(new AxiosError('synthetic', 'ERR_NETWORK'));
  const mutation = client.getMutationCache().build(client, {
    mutationFn,
    gcTime: Infinity,
  });
  try {
    await expect(mutation.execute(undefined)).rejects.toMatchObject({
      code: 'ERR_NETWORK',
    });
    expect(mutation.state.isPaused).toBe(false);
    expect(mutation.state.status).toBe('error');
    onlineManager.setOnline(true);
    await client.resumePausedMutations();
    expect(mutationFn).toHaveBeenCalledTimes(1);
  } finally {
    client.unmount();
    client.clear();
    onlineManager.setOnline(true);
  }
});
