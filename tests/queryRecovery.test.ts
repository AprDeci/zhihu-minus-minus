import {
  focusManager,
  InfiniteQueryObserver,
  MutationObserver,
  onlineManager,
  QueryClient,
  QueryObserver,
} from '@tanstack/react-query';
import { restartInterruptedQueries } from '../utils/queryRecovery';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function controlledQuery<T>() {
  const requests: Array<{
    signal: AbortSignal;
    result: ReturnType<typeof deferred<T>>;
  }> = [];
  const queryFn = jest.fn(({ signal }: { signal: AbortSignal }) => {
    const result = deferred<T>();
    requests.push({ signal, result });
    // Deliberately ignore abort to model a transport completing after cancellation.
    return result.promise;
  });
  return { queryFn, requests };
}

let client: QueryClient;
let cleanups: Array<() => void>;

beforeEach(() => {
  jest.useFakeTimers();
  onlineManager.setOnline(true);
  focusManager.setFocused(true);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
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

test('replaces a hanging first load immediately and accepts only its replacement', async () => {
  const { queryFn, requests } = controlledQuery<string>();
  const observer = new QueryObserver(client, {
    queryKey: ['first-load'],
    queryFn,
  });
  cleanups.push(observer.subscribe(() => undefined));

  restartInterruptedQueries(client);

  expect(queryFn).toHaveBeenCalledTimes(2);
  expect(requests[0].signal.aborted).toBe(true);
  expect(requests[1].signal.aborted).toBe(false);
  expect(observer.getCurrentResult().isLoading).toBe(true);
  requests[1].result.resolve('recovered');
  await jest.advanceTimersByTimeAsync(0);
  requests[0].result.resolve('obsolete');
  await jest.advanceTimersByTimeAsync(0);
  expect(observer.getCurrentResult().data).toBe('recovered');
  expect(observer.getCurrentResult().fetchStatus).toBe('idle');
});

test('retains cached data while restarting and ignores a late failure from the old request', async () => {
  const { queryFn, requests } = controlledQuery<string>();
  const observer = new QueryObserver(client, {
    queryKey: ['cached'],
    initialData: 'cached content',
    queryFn,
  });
  cleanups.push(observer.subscribe(() => undefined));

  restartInterruptedQueries(client);
  expect(observer.getCurrentResult().data).toBe('cached content');
  requests[0].result.reject(new Error('obsolete network failure'));
  await jest.advanceTimersByTimeAsync(0);
  expect(observer.getCurrentResult().data).toBe('cached content');
  expect(observer.getCurrentResult().isError).toBe(false);
  expect(observer.getCurrentResult().fetchStatus).toBe('fetching');

  requests[1].result.resolve('fresh content');
  await jest.advanceTimersByTimeAsync(0);
  expect(observer.getCurrentResult().data).toBe('fresh content');
});

test.each([
  'forward',
  'backward',
] as const)('restarts %s pagination without fetching the previously loaded pages', async (direction) => {
  const requests: Array<{
    pageParam: number;
    signal: AbortSignal;
    result: ReturnType<typeof deferred<number>>;
  }> = [];
  const observer = new InfiniteQueryObserver(client, {
    queryKey: ['pages', direction],
    initialPageParam: 1,
    initialData: { pages: [1, 2], pageParams: [1, 2] },
    staleTime: Infinity,
    queryFn: ({ pageParam, signal }) => {
      const result = deferred<number>();
      requests.push({ pageParam, signal, result });
      return result.promise;
    },
    getNextPageParam: (lastPage) => lastPage + 1,
    getPreviousPageParam: (firstPage) => firstPage - 1,
  });
  cleanups.push(observer.subscribe(() => undefined));
  const interrupted =
    direction === 'forward'
      ? observer.fetchNextPage()
      : observer.fetchPreviousPage();

  restartInterruptedQueries(client);

  const requestedPage = direction === 'forward' ? 3 : 0;
  expect(requests.map((request) => request.pageParam)).toEqual([
    requestedPage,
    requestedPage,
  ]);
  expect(requests[0].signal.aborted).toBe(true);
  expect(observer.getCurrentResult().data?.pages).toEqual([1, 2]);
  requests[0].result.resolve(999);
  requests[1].result.resolve(requestedPage);
  await interrupted;
  await jest.advanceTimersByTimeAsync(0);
  const expectedPages = direction === 'forward' ? [1, 2, 3] : [0, 1, 2];
  expect(observer.getCurrentResult().data).toEqual({
    pages: expectedPages,
    pageParams: expectedPages,
  });
});

test('starts one paused replacement before reconnect and resumes it once', async () => {
  const { queryFn, requests } = controlledQuery<string>();
  const observer = new QueryObserver(client, {
    queryKey: ['reconnect'],
    queryFn,
  });
  cleanups.push(observer.subscribe(() => undefined));
  onlineManager.setOnline(false);

  restartInterruptedQueries(client);
  expect(requests[0].signal.aborted).toBe(true);
  expect(observer.getCurrentResult().fetchStatus).toBe('paused');
  restartInterruptedQueries(client);
  expect(queryFn).toHaveBeenCalledTimes(1);

  onlineManager.setOnline(true);
  await jest.advanceTimersByTimeAsync(0);
  expect(queryFn).toHaveBeenCalledTimes(2);
  requests[1].result.resolve('reconnected');
  await jest.advanceTimersByTimeAsync(0);
  expect(observer.getCurrentResult().data).toBe('reconnected');
});

test('leaves an already paused query on its original task', async () => {
  onlineManager.setOnline(false);
  const queryFn = jest.fn(async () => 'available');
  const observer = new QueryObserver(client, {
    queryKey: ['already-paused'],
    queryFn,
  });
  cleanups.push(observer.subscribe(() => undefined));
  const query = client.getQueryCache().find({ queryKey: ['already-paused'] });
  const originalTask = query?.promise;
  expect(originalTask).toBeDefined();
  expect(observer.getCurrentResult().fetchStatus).toBe('paused');

  restartInterruptedQueries(client);
  expect(query?.promise).toBe(originalTask);
  onlineManager.setOnline(true);
  await jest.advanceTimersByTimeAsync(0);
  expect(queryFn).toHaveBeenCalledTimes(1);
  expect(observer.getCurrentResult().data).toBe('available');
});

test('replaces a query in retry backoff without waiting for its old retry timer', async () => {
  const { queryFn, requests } = controlledQuery<string>();
  const observer = new QueryObserver(client, {
    queryKey: ['backoff'],
    queryFn,
    retry: 2,
    retryDelay: 10_000,
  });
  cleanups.push(observer.subscribe(() => undefined));
  requests[0].result.reject(new Error('temporary failure'));
  await jest.advanceTimersByTimeAsync(0);
  expect(observer.getCurrentResult().failureCount).toBe(1);

  restartInterruptedQueries(client);
  expect(queryFn).toHaveBeenCalledTimes(2);
  requests[1].result.resolve('recovered');
  await jest.advanceTimersByTimeAsync(10_000);
  expect(queryFn).toHaveBeenCalledTimes(2);
  expect(observer.getCurrentResult().data).toBe('recovered');
});

test('leaves disabled, inactive, local reads and mutations untouched', async () => {
  const disabled = controlledQuery<string>();
  const disabledObserver = new QueryObserver(client, {
    queryKey: ['disabled'],
    queryFn: disabled.queryFn,
    enabled: false,
  });
  cleanups.push(disabledObserver.subscribe(() => undefined));
  const disabledTask = disabledObserver.refetch();

  const inactive = controlledQuery<string>();
  const inactiveTask = client.fetchQuery({
    queryKey: ['inactive'],
    queryFn: inactive.queryFn,
  });
  const local = controlledQuery<string>();
  const localObserver = new QueryObserver(client, {
    queryKey: ['local'],
    queryFn: local.queryFn,
    networkMode: 'always',
  });
  cleanups.push(localObserver.subscribe(() => undefined));
  const mutationResult = deferred<string>();
  const mutationFn = jest.fn(() => mutationResult.promise);
  const mutation = new MutationObserver(client, { mutationFn });
  const mutationTask = mutation.mutate();
  await jest.advanceTimersByTimeAsync(0);

  restartInterruptedQueries(client);

  for (const controlled of [disabled, inactive, local]) {
    expect(controlled.queryFn).toHaveBeenCalledTimes(1);
    expect(controlled.requests[0].signal.aborted).toBe(false);
    controlled.requests[0].result.resolve('original result');
  }
  expect(mutationFn).toHaveBeenCalledTimes(1);
  mutationResult.resolve('mutation result');
  await Promise.all([disabledTask, inactiveTask, mutationTask]);
  await jest.advanceTimersByTimeAsync(0);
  expect(localObserver.getCurrentResult().data).toBe('original result');
  expect(mutation.getCurrentResult().data).toBe('mutation result');
});

test('handles consecutive network changes without obsolete requests overwriting the latest result', async () => {
  const { queryFn, requests } = controlledQuery<string>();
  const observer = new QueryObserver(client, {
    queryKey: ['multiple-changes'],
    initialData: 'cached',
    queryFn,
  });
  cleanups.push(observer.subscribe(() => undefined));

  restartInterruptedQueries(client);
  restartInterruptedQueries(client);
  expect(queryFn).toHaveBeenCalledTimes(3);
  expect(requests.map((request) => request.signal.aborted)).toEqual([
    true,
    true,
    false,
  ]);
  requests[2].result.resolve('latest network');
  await jest.advanceTimersByTimeAsync(0);
  requests[1].result.resolve('intermediate network');
  requests[0].result.resolve('oldest network');
  await jest.advanceTimersByTimeAsync(0);
  expect(observer.getCurrentResult().data).toBe('latest network');
  expect(observer.getCurrentResult().fetchStatus).toBe('idle');
});
