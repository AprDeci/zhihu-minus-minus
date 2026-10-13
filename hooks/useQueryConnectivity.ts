import {
  focusManager,
  onlineManager,
  type QueryClient,
} from '@tanstack/react-query';
import * as Network from 'expo-network';
import { useEffect } from 'react';
import { AppState, Platform } from 'react-native';
import { restartInterruptedQueries } from '@/utils/queryRecovery';

function getOnlineState(state: Network.NetworkState): boolean | undefined {
  if (state.isConnected === false || state.isInternetReachable === false) {
    return false;
  }
  if (state.isConnected === true || state.isInternetReachable === true) {
    return true;
  }
  // Missing native information must not leave all requests paused indefinitely.
  return undefined;
}

function getConnectionType(state: Network.NetworkState) {
  return state.type === Network.NetworkStateType.NONE ||
    state.type === Network.NetworkStateType.UNKNOWN
    ? undefined
    : state.type;
}

/** Bridge native connectivity/focus to Query; browser events already work on web. */
export function useQueryConnectivity(queryClient: QueryClient): void {
  useEffect(() => {
    if (Platform.OS === 'web') return;

    let disposed = false;
    let revision = 0;
    let lastOnline = onlineManager.isOnline();
    let lastType: Network.NetworkStateType | undefined;
    let appState = AppState.currentState;
    let foregroundRequests: Set<Promise<unknown>> | undefined;

    const applyNetworkState = (state: Network.NetworkState) => {
      if (disposed) return;
      const online = getOnlineState(state);
      if (online === undefined) return;
      const type = getConnectionType(state);
      const connectionChanged =
        online && lastOnline && type && lastType && type !== lastType;

      if (online && (!lastOnline || connectionChanged)) {
        // onOnline alone reuses a hanging request, including an empty first page.
        // Restart it before resuming the paused queries, preserving fetch metadata.
        restartInterruptedQueries(queryClient);
      } else if (online && foregroundRequests?.size) {
        // A disconnect and reconnect to the same Wi-Fi can both be missed in
        // the background. Only replace reads that predate this foreground check,
        // not new requests started by onFocus or by a newly mounted screen.
        const interrupted = foregroundRequests;
        restartInterruptedQueries(
          queryClient,
          (query) => !!query.promise && interrupted.has(query.promise),
        );
      }
      foregroundRequests = undefined;
      lastOnline = online;
      lastType = online ? (type ?? lastType) : undefined;
      onlineManager.setOnline(online);
    };

    const readNetworkState = () => {
      const readRevision = ++revision;
      void Network.getNetworkStateAsync()
        .then((state) => {
          if (!disposed && revision === readRevision) applyNetworkState(state);
        })
        .catch(() => {
          // Keep the last known state; do not log native connection details.
        });
    };

    const networkSubscription = Network.addNetworkStateListener((state) => {
      revision += 1;
      applyNetworkState(state);
    });
    readNetworkState();
    if (AppState.currentState) {
      focusManager.setFocused(AppState.currentState === 'active');
    }
    const appStateSubscription = AppState.addEventListener(
      'change',
      (state) => {
        if (disposed) return;
        const becomingActive = state === 'active' && appState !== 'active';
        appState = state;
        if (becomingActive) {
          foregroundRequests = new Set(
            queryClient
              .getQueryCache()
              .findAll({ type: 'active', fetchStatus: 'fetching' })
              .flatMap((query) => (query.promise ? [query.promise] : [])),
          );
          // Capture old promises before onFocus can start new queries.
          readNetworkState();
        }
        focusManager.setFocused(state === 'active');
      },
    );

    return () => {
      disposed = true;
      networkSubscription.remove();
      appStateSubscription.remove();
    };
  }, [queryClient]);
}
