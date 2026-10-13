import { runInNewContext } from 'node:vm';
import CookieManager from '@preeternal/react-native-cookie-manager';
import {
  onlineManager,
  QueryClient,
  QueryObserver,
} from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
} from '@testing-library/react-native';
import {
  GUEST_BOOTSTRAP_READY_MESSAGE,
  GuestBootstrap,
} from '../components/GuestBootstrap';
import {
  GUEST_BOOTSTRAP_TIMEOUT_MS,
  useGuestBootstrap,
} from '../hooks/useGuestBootstrap';

let mockQueryClient: QueryClient;
let mockSessionVersion = 1;
let mockAuthCookie: string | null = null;

jest.mock('@tanstack/react-query', () => ({
  ...jest.requireActual<typeof import('@tanstack/react-query')>(
    '@tanstack/react-query',
  ),
  useQueryClient: () => mockQueryClient,
}));
jest.mock('@preeternal/react-native-cookie-manager', () => ({
  __esModule: true,
  default: { get: jest.fn() },
}));
jest.mock('../store/useAuthStore', () => ({
  getAuthSessionVersion: () => mockSessionVersion,
  useAuthStore: { getState: () => ({ cookies: mockAuthCookie }) },
}));
jest.mock('../components/Themed', () => ({
  View: jest.requireActual<typeof import('react-native')>('react-native').View,
}));
jest.mock('react-native-webview', () => ({
  WebView: (props: Record<string, unknown>) => {
    const react = jest.requireActual<typeof import('react')>('react');
    const { View } =
      jest.requireActual<typeof import('react-native')>('react-native');
    return react.createElement(View, { ...props, testID: 'guest-webview' });
  },
}));

const getCookies = jest.mocked(CookieManager.get);
const guestCookies = {
  d_c0: { name: 'd_c0', value: 'synthetic-anonymous-cookie' },
};

beforeEach(() => {
  jest.useFakeTimers();
  onlineManager.setOnline(true);
  mockSessionVersion = 1;
  mockAuthCookie = null;
  mockQueryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  getCookies.mockReset().mockResolvedValue({});
});

afterEach(async () => {
  await cleanup();
  mockQueryClient.clear();
  onlineManager.setOnline(true);
  jest.useRealTimers();
});

test('existing native anonymous cookies release the feed without mounting a WebView', async () => {
  getCookies.mockResolvedValue(guestCookies);
  const host = await renderHook(() => useGuestBootstrap(true));
  expect(host.result.current).toEqual({ ready: true, attempt: null });
  expect(getCookies).toHaveBeenCalledTimes(1);
});

test('a silent WebView cannot keep the feed disabled beyond the deadline', async () => {
  const host = await renderHook(() => useGuestBootstrap(true));
  const attempt = host.result.current.attempt;
  expect(attempt).not.toBeNull();
  expect(host.result.current.ready).toBe(false);
  await act(() => jest.advanceTimersByTime(GUEST_BOOTSTRAP_TIMEOUT_MS - 1));
  expect(host.result.current.ready).toBe(false);
  await act(() => jest.advanceTimersByTime(1));
  expect(host.result.current).toEqual({ ready: true, attempt: null });
  await act(() => attempt?.complete(true));
  expect(host.result.current).toEqual({ ready: true, attempt: null });
});

test('a stalled native cookie read is bounded and its late success is ignored', async () => {
  let finish: (cookies: typeof guestCookies) => void = () => {};
  getCookies.mockImplementationOnce(
    () => new Promise((resolve) => (finish = resolve)),
  );
  const host = await renderHook(() => useGuestBootstrap(true));
  expect(host.result.current.ready).toBe(false);
  await act(() => jest.advanceTimersByTime(GUEST_BOOTSTRAP_TIMEOUT_MS));
  expect(host.result.current).toEqual({ ready: true, attempt: null });
  await act(() => finish(guestCookies));
  expect(host.result.current).toEqual({ ready: true, attempt: null });
});

test('a failed native read still allows the WebView and its error releases the feed', async () => {
  getCookies.mockRejectedValueOnce(new Error('Unavailable'));
  const host = await renderHook(() => useGuestBootstrap(true));
  expect(host.result.current.attempt).not.toBeNull();
  await act(() => host.result.current.attempt?.complete(false));
  expect(host.result.current).toEqual({ ready: true, attempt: null });
});

test('a synchronous native bridge failure still allows bootstrap to settle', async () => {
  getCookies.mockImplementationOnce(() => {
    throw new Error('Native bridge unavailable');
  });
  const host = await renderHook(() => useGuestBootstrap(true));
  expect(host.result.current.attempt).not.toBeNull();
  await act(() => host.result.current.attempt?.complete(false));
  expect(host.result.current.ready).toBe(true);
});

test('a ready message releases the feed immediately without an extra cookie delay', async () => {
  const host = await renderHook(() => useGuestBootstrap(true));
  await act(() => host.result.current.attempt?.complete(true));
  expect(host.result.current).toEqual({ ready: true, attempt: null });
});

test('reconnect allows one new attempt without closing the feed gate or accepting old messages', async () => {
  const host = await renderHook(() => useGuestBootstrap(true));
  const oldAttempt = host.result.current.attempt;
  await act(() => oldAttempt?.complete(false));
  await act(() => {
    onlineManager.setOnline(false);
    onlineManager.setOnline(true);
  });
  const newAttempt = host.result.current.attempt;
  expect(newAttempt?.id).not.toBe(oldAttempt?.id);
  expect(host.result.current.ready).toBe(true);
  await act(() => oldAttempt?.complete(true));
  expect(host.result.current.attempt).toBe(newAttempt);
  await act(() => newAttempt?.complete(false));
  await act(() => {
    onlineManager.setOnline(true);
    onlineManager.setOnline(false);
    onlineManager.setOnline(true);
  });
  expect(getCookies).toHaveBeenCalledTimes(2);
  expect(host.result.current).toEqual({ ready: true, attempt: null });
});

test('successful initialization is not repeated on reconnection', async () => {
  getCookies.mockResolvedValue(guestCookies);
  await renderHook(() => useGuestBootstrap(true));
  await act(() => {
    onlineManager.setOnline(false);
    onlineManager.setOnline(true);
  });
  expect(getCookies).toHaveBeenCalledTimes(1);
});

test('reconnection releases the feed immediately and gives its single background attempt a full deadline', async () => {
  const host = await renderHook(() => useGuestBootstrap(true));
  await act(() => jest.advanceTimersByTime(GUEST_BOOTSTRAP_TIMEOUT_MS - 100));
  await act(() => {
    onlineManager.setOnline(false);
    onlineManager.setOnline(true);
  });
  const retryAttempt = host.result.current.attempt;
  expect(retryAttempt).not.toBeNull();
  expect(host.result.current.ready).toBe(true);
  await act(() => jest.advanceTimersByTime(1000));
  expect(host.result.current.attempt).toBe(retryAttempt);
  await act(() => {
    onlineManager.setOnline(false);
    onlineManager.setOnline(true);
  });
  expect(host.result.current.attempt).toBe(retryAttempt);
  await act(() => retryAttempt?.complete(true));
  expect(host.result.current).toEqual({ ready: true, attempt: null });
  expect(getCookies).toHaveBeenCalledTimes(2);
});

test('old native results and messages cannot release a later guest session', async () => {
  let finish: (cookies: typeof guestCookies) => void = () => {};
  const host = await renderHook(() => useGuestBootstrap(!mockAuthCookie));
  const oldAttempt = host.result.current.attempt;
  await act(() => {
    mockAuthCookie = 'synthetic-authenticated-cookie';
    mockSessionVersion += 1;
  });
  await host.rerender(undefined);
  expect(host.result.current).toEqual({ ready: true, attempt: null });
  getCookies.mockImplementationOnce(
    () => new Promise((resolve) => (finish = resolve)),
  );
  await act(() => {
    mockAuthCookie = null;
    mockSessionVersion += 1;
  });
  await host.rerender(undefined);
  expect(host.result.current.ready).toBe(false);
  await act(() => oldAttempt?.complete(true));
  expect(host.result.current.ready).toBe(false);
  await host.unmount();
  await act(() => finish(guestCookies));
  expect(getCookies).toHaveBeenCalledTimes(2);
});

test('a native result cannot change state after an account switch before rerender', async () => {
  let finish: (cookies: typeof guestCookies) => void = () => {};
  getCookies.mockImplementationOnce(
    () => new Promise((resolve) => (finish = resolve)),
  );
  const host = await renderHook(() => useGuestBootstrap(true));
  await act(() => {
    mockAuthCookie = 'synthetic-authenticated-cookie';
    mockSessionVersion += 1;
    finish(guestCookies);
  });
  expect(host.result.current.ready).toBe(false);
});

test('later cookie success retries only active failed guest feeds', async () => {
  const failedGuest = jest
    .fn()
    .mockRejectedValueOnce(new Error('Missing anonymous cookie'))
    .mockResolvedValue('guest-feed');
  const inactiveGuest = jest.fn().mockRejectedValue(new Error('Unavailable'));
  const accountFeed = jest.fn().mockRejectedValue(new Error('Unavailable'));
  const successfulGuest = jest.fn();
  const keys = {
    failed: ['zhihu-feed', 'guest', 'recommend'],
    inactive: ['zhihu-feed', 'guest', 'local'],
    account: ['zhihu-feed', 'id:synthetic-account', 'recommend'],
    successful: ['zhihu-feed', 'guest', 'hot'],
  };
  for (const [queryKey, queryFn] of [
    [keys.failed, failedGuest],
    [keys.inactive, inactiveGuest],
    [keys.account, accountFeed],
  ] as const) {
    await expect(
      mockQueryClient.fetchQuery({ queryKey, queryFn }),
    ).rejects.toBeInstanceOf(Error);
  }
  mockQueryClient.setQueryData(keys.successful, { pages: [{ items: [] }] });
  const unsubscribers = (
    [
      [keys.failed, failedGuest],
      [keys.account, accountFeed],
      [keys.successful, successfulGuest],
    ] as const
  ).map(([queryKey, queryFn]) =>
    new QueryObserver(mockQueryClient, {
      queryKey,
      queryFn,
      retryOnMount: false,
      staleTime: Infinity,
    }).subscribe(() => {}),
  );
  try {
    const host = await renderHook(() => useGuestBootstrap(true));
    await act(() => host.result.current.attempt?.complete(false));
    await act(() => {
      onlineManager.setOnline(false);
      onlineManager.setOnline(true);
    });
    await act(() => host.result.current.attempt?.complete(true));
    expect(failedGuest).toHaveBeenCalledTimes(2);
    expect(mockQueryClient.getQueryData(keys.failed)).toBe('guest-feed');
    expect(successfulGuest).not.toHaveBeenCalled();
    expect(accountFeed).toHaveBeenCalledTimes(1);
    expect(inactiveGuest).toHaveBeenCalledTimes(1);
  } finally {
    for (const unsubscribe of unsubscribers) unsubscribe();
  }
});

test('later native cookie success replaces a hanging guest read with no data', async () => {
  let firstSignal: AbortSignal | undefined;
  const queryFn = jest.fn(({ signal }: { signal: AbortSignal }) => {
    if (!firstSignal) {
      firstSignal = signal;
      return new Promise<string>(() => {});
    }
    return Promise.resolve('recovered-feed');
  });
  const queryKey = ['zhihu-feed', 'guest', 'recommend'];
  const observer = new QueryObserver(mockQueryClient, { queryKey, queryFn });
  const unsubscribe = observer.subscribe(() => {});
  try {
    const host = await renderHook(() => useGuestBootstrap(true));
    await act(() => host.result.current.attempt?.complete(false));
    getCookies.mockResolvedValueOnce(guestCookies);
    await act(() => {
      onlineManager.setOnline(false);
      onlineManager.setOnline(true);
    });
    expect(firstSignal?.aborted).toBe(true);
    expect(queryFn).toHaveBeenCalledTimes(2);
    expect(mockQueryClient.getQueryData(queryKey)).toBe('recovered-feed');
  } finally {
    unsubscribe();
  }
});

test('the WebView accepts only its fixed readiness marker and releases on native errors', async () => {
  const complete = jest.fn();
  const host = await render(<GuestBootstrap attempt={{ id: 1, complete }} />);
  const webview = host.getByTestId('guest-webview');
  await fireEvent(webview, 'message', { nativeEvent: { data: 'unrelated' } });
  expect(complete).not.toHaveBeenCalled();
  await fireEvent(webview, 'message', {
    nativeEvent: { data: GUEST_BOOTSTRAP_READY_MESSAGE },
  });
  expect(complete).toHaveBeenLastCalledWith(true);
  await fireEvent(webview, 'error', { nativeEvent: {} });
  expect(complete).toHaveBeenLastCalledWith(false);
  await fireEvent(webview, 'httpError', { nativeEvent: { statusCode: 503 } });
  expect(complete).toHaveBeenLastCalledWith(false);
});

test.each([
  ['d_c0=synthetic', true],
  ['other=value; d_c0=synthetic', true],
  ['evil_d_c0=synthetic', false],
  ['d_c0=', false],
  ['other=value; d_c0=', false],
] as const)('the generated WebView script recognizes %s correctly', async (cookie, ready) => {
  const host = await render(
    <GuestBootstrap attempt={{ id: 1, complete: jest.fn() }} />,
  );
  const script: unknown =
    host.getByTestId('guest-webview').props.injectedJavaScript;
  if (typeof script !== 'string') throw new Error('Missing bootstrap script');
  const document = { cookie };
  const postMessage = jest.fn();
  const setInterval = jest.fn((_callback: () => void, _delay: number) => 1);
  const clearInterval = jest.fn();
  runInNewContext(script, {
    document,
    window: { ReactNativeWebView: { postMessage } },
    setInterval,
    clearInterval,
  });
  if (ready) {
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith(GUEST_BOOTSTRAP_READY_MESSAGE);
    expect(setInterval).not.toHaveBeenCalled();
  } else {
    expect(postMessage).not.toHaveBeenCalled();
    expect(setInterval).toHaveBeenCalledTimes(1);
    document.cookie = 'other=value; d_c0=synthetic';
    setInterval.mock.calls[0]?.[0]();
    expect(postMessage).toHaveBeenCalledWith(GUEST_BOOTSTRAP_READY_MESSAGE);
    expect(clearInterval).toHaveBeenCalledWith(1);
  }
});
