import {
  focusManager,
  onlineManager,
  QueryClient,
  QueryObserver,
} from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react-native';
import * as Network from 'expo-network';
import { AppState, type AppStateStatus, Platform } from 'react-native';
import { useQueryConnectivity } from '../hooks/useQueryConnectivity';
import { restartInterruptedQueries } from '../utils/queryRecovery';

jest.mock('expo-network', () => ({
  NetworkStateType: {
    NONE: 'NONE',
    UNKNOWN: 'UNKNOWN',
    WIFI: 'WIFI',
    CELLULAR: 'CELLULAR',
  },
  addNetworkStateListener: jest.fn(),
  getNetworkStateAsync: jest.fn(),
}));
jest.mock('../utils/queryRecovery', () => ({
  restartInterruptedQueries: jest.fn(),
}));

const wifi: Network.NetworkState = {
  type: Network.NetworkStateType.WIFI,
  isConnected: true,
  isInternetReachable: true,
};
const offline: Network.NetworkState = {
  type: Network.NetworkStateType.NONE,
  isConnected: false,
  isInternetReachable: false,
};
const initialPlatform = Platform.OS;
const initialAppState = AppState.currentState;
let onNetworkState: (state: Network.NetworkState) => void;
let onAppState: (state: AppStateStatus) => void;
let removeNetworkListener: jest.Mock;
let removeAppStateListener: jest.Mock;
let client: QueryClient;

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(restartInterruptedQueries).mockReset();
  Platform.OS = 'android';
  AppState.currentState = 'active';
  onlineManager.setOnline(true);
  focusManager.setFocused(true);
  client = new QueryClient();
  removeNetworkListener = jest.fn();
  removeAppStateListener = jest.fn();
  jest
    .mocked(Network.addNetworkStateListener)
    .mockImplementation((listener) => {
      onNetworkState = listener;
      return { remove: removeNetworkListener };
    });
  jest.mocked(Network.getNetworkStateAsync).mockResolvedValue(wifi);
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_event, listener) => {
      onAppState = listener;
      return { remove: removeAppStateListener };
    });
});

afterEach(() => {
  client.clear();
  onlineManager.setOnline(true);
  focusManager.setFocused(undefined);
  jest.restoreAllMocks();
  Platform.OS = initialPlatform;
  AppState.currentState = initialAppState;
});

test('restarts interrupted reads before bringing paused queries online, once per recovery', async () => {
  const host = await renderHook(() => useQueryConnectivity(client));
  expect(restartInterruptedQueries).not.toHaveBeenCalled();
  await act(() => onNetworkState(offline));
  expect(onlineManager.isOnline()).toBe(false);
  jest.mocked(restartInterruptedQueries).mockImplementation(() => {
    expect(onlineManager.isOnline()).toBe(false);
  });
  await act(() => onNetworkState(wifi));
  expect(onlineManager.isOnline()).toBe(true);
  await act(() => onNetworkState(wifi));
  expect(restartInterruptedQueries).toHaveBeenCalledTimes(1);
  expect(restartInterruptedQueries).toHaveBeenCalledWith(client);
  await host.unmount();
});

test('recognizes a Wi-Fi to cellular switch even without an offline event', async () => {
  const host = await renderHook(() => useQueryConnectivity(client));
  const cellular = { ...wifi, type: Network.NetworkStateType.CELLULAR };
  await act(() => onNetworkState(cellular));
  await act(() => onNetworkState(cellular));
  expect(restartInterruptedQueries).toHaveBeenCalledTimes(1);
  expect(onlineManager.isOnline()).toBe(true);
  await host.unmount();
});

test('a stale initial snapshot cannot overwrite a newer native event', async () => {
  let resolveSnapshot: (state: Network.NetworkState) => void = () => {};
  jest.mocked(Network.getNetworkStateAsync).mockReturnValue(
    new Promise((resolve) => {
      resolveSnapshot = resolve;
    }),
  );
  const host = await renderHook(() => useQueryConnectivity(client));
  await act(() => onNetworkState(offline));
  await act(() => resolveSnapshot(wifi));
  expect(onlineManager.isOnline()).toBe(false);
  expect(restartInterruptedQueries).not.toHaveBeenCalled();
  await host.unmount();
});

test('foreground resamples missed network changes and synchronizes focus', async () => {
  jest.mocked(Network.getNetworkStateAsync).mockResolvedValueOnce(offline);
  const host = await renderHook(() => useQueryConnectivity(client));
  expect(onlineManager.isOnline()).toBe(false);
  await act(() => onAppState('background'));
  expect(focusManager.isFocused()).toBe(false);
  await act(() => onAppState('active'));
  expect(focusManager.isFocused()).toBe(true);
  expect(onlineManager.isOnline()).toBe(true);
  expect(Network.getNetworkStateAsync).toHaveBeenCalledTimes(2);
  expect(restartInterruptedQueries).toHaveBeenCalledTimes(1);
  await host.unmount();
});

test('unknown or failed snapshots preserve the last known state', async () => {
  jest
    .mocked(Network.getNetworkStateAsync)
    .mockRejectedValue(new Error('synthetic'));
  const host = await renderHook(() => useQueryConnectivity(client));
  expect(onlineManager.isOnline()).toBe(true);
  await act(() => onNetworkState({ type: Network.NetworkStateType.UNKNOWN }));
  expect(onlineManager.isOnline()).toBe(true);
  await act(() => onNetworkState(offline));
  await act(() => onNetworkState({}));
  expect(onlineManager.isOnline()).toBe(false);
  expect(restartInterruptedQueries).not.toHaveBeenCalled();
  await host.unmount();
});

test('unmount removes both subscriptions and ignores a pending snapshot', async () => {
  let resolveSnapshot: (state: Network.NetworkState) => void = () => {};
  jest.mocked(Network.getNetworkStateAsync).mockReturnValue(
    new Promise((resolve) => {
      resolveSnapshot = resolve;
    }),
  );
  const host = await renderHook(() => useQueryConnectivity(client));
  await host.unmount();
  await act(() => resolveSnapshot(offline));
  expect(onlineManager.isOnline()).toBe(true);
  expect(removeNetworkListener).toHaveBeenCalledTimes(1);
  expect(removeAppStateListener).toHaveBeenCalledTimes(1);
});

test('leaves browser online and focus listeners in control on web', async () => {
  Platform.OS = 'web';
  const host = await renderHook(() => useQueryConnectivity(client));
  expect(Network.addNetworkStateListener).not.toHaveBeenCalled();
  expect(Network.getNetworkStateAsync).not.toHaveBeenCalled();
  expect(AppState.addEventListener).not.toHaveBeenCalled();
  await host.unmount();
});

test('foreground replaces a hung read even when missed network events return to the same Wi-Fi', async () => {
  jest
    .mocked(restartInterruptedQueries)
    .mockImplementation(
      jest.requireActual<typeof import('../utils/queryRecovery')>(
        '../utils/queryRecovery',
      ).restartInterruptedQueries,
    );
  const host = await renderHook(() => useQueryConnectivity(client));
  const signals: AbortSignal[] = [];
  const queryFn = jest.fn(({ signal }: { signal: AbortSignal }) => {
    signals.push(signal);
    return signals.length === 1
      ? new Promise<string>(() => {})
      : Promise.resolve('recovered');
  });
  const observer = new QueryObserver(client, {
    queryKey: ['foreground-read'],
    queryFn,
    retry: false,
    gcTime: Infinity,
  });
  const unsubscribe = observer.subscribe(() => {});
  await act(() => onAppState('background'));
  // Both the loss and recovery event were missed while suspended.
  await act(() => onAppState('active'));
  expect(queryFn).toHaveBeenCalledTimes(2);
  expect(signals[0].aborted).toBe(true);
  expect(client.getQueryData(['foreground-read'])).toBe('recovered');
  await act(() => onAppState('active'));
  expect(Network.getNetworkStateAsync).toHaveBeenCalledTimes(2);
  expect(queryFn).toHaveBeenCalledTimes(2);
  unsubscribe();
  await host.unmount();
});

test('foreground sampling does not cancel a new request started by focus', async () => {
  jest
    .mocked(restartInterruptedQueries)
    .mockImplementation(
      jest.requireActual<typeof import('../utils/queryRecovery')>(
        '../utils/queryRecovery',
      ).restartInterruptedQueries,
    );
  const host = await renderHook(() => useQueryConnectivity(client));
  client.mount();
  const queryFn = jest.fn(() => new Promise<string>(() => {}));
  const observer = new QueryObserver(client, {
    queryKey: ['fresh-focus-read'],
    initialData: 'cached',
    queryFn,
    refetchOnMount: false,
    gcTime: Infinity,
  });
  const unsubscribe = observer.subscribe(() => {});
  await act(() => onAppState('background'));
  await act(() => onAppState('active'));
  expect(queryFn).toHaveBeenCalledTimes(1);
  expect(restartInterruptedQueries).not.toHaveBeenCalled();
  unsubscribe();
  client.unmount();
  await host.unmount();
});
