import CookieManager from '@preeternal/react-native-cookie-manager';
import { onlineManager, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { getAuthSessionVersion, useAuthStore } from '@/store/useAuthStore';

export const GUEST_BOOTSTRAP_TIMEOUT_MS = 5000;

export interface GuestBootstrapAttempt {
  id: number;
  complete: (hasCookie: boolean) => void;
}

interface BootstrapSnapshot {
  sessionVersion: number;
  ready: boolean;
  attempt: GuestBootstrapAttempt | null;
}

/** Anonymous cookies improve compatibility, but must never block browsing forever. */
export function useGuestBootstrap(isGuest: boolean) {
  const queryClient = useQueryClient();
  const sessionVersion = getAuthSessionVersion();
  const nextAttemptId = useRef(0);
  const [snapshot, setSnapshot] = useState<BootstrapSnapshot | null>(null);

  useEffect(() => {
    if (!isGuest) return;
    let disposed = false;
    let released = false;
    let succeeded = false;
    let retried = false;
    let sawOffline = !onlineManager.isOnline();
    let activeAttempt: number | null = null;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const isCurrent = () =>
      !disposed &&
      sessionVersion === getAuthSessionVersion() &&
      !useAuthStore.getState().cookies;

    const start = () => {
      if (!isCurrent()) return;
      clearTimeout(timeout);
      const id = ++nextAttemptId.current;
      activeAttempt = id;
      setSnapshot({ sessionVersion, ready: released, attempt: null });
      const isCurrentAttempt = () => isCurrent() && activeAttempt === id;
      const complete = (hasCookie: boolean) => {
        if (!isCurrentAttempt()) return;
        activeAttempt = null;
        clearTimeout(timeout);
        const wasReleased = released;
        released = true;
        succeeded = hasCookie;
        setSnapshot({ sessionVersion, ready: true, attempt: null });

        if (hasCookie && wasReleased) {
          // Only failed/missing guest reads need the newly available cookie.
          // Preserve successful feeds and do not touch another account's cache.
          const queries = queryClient.getQueryCache().findAll({
            queryKey: ['zhihu-feed', 'guest'],
            type: 'active',
            predicate: (query) =>
              !query.isDisabled() &&
              (query.state.status === 'error' ||
                query.state.data === undefined),
          });
          for (const query of queries) {
            if (!isCurrent()) break;
            const meta = query.state.fetchMeta ?? undefined;
            void query.cancel({ revert: true });
            void query.fetch(undefined, { meta }).catch(() => undefined);
          }
        }
      };
      timeout = setTimeout(() => complete(false), GUEST_BOOTSTRAP_TIMEOUT_MS);
      const showWebView = () => {
        if (isCurrentAttempt()) {
          setSnapshot({
            sessionVersion,
            ready: released,
            attempt: { id, complete },
          });
        }
      };
      void Promise.resolve()
        .then(() => CookieManager.get('https://www.zhihu.com', true))
        .then((cookies) => {
          if (!isCurrentAttempt()) return;
          if (cookies.d_c0?.value) complete(true);
          else showWebView();
        })
        .catch(showWebView);
    };

    const unsubscribe = onlineManager.subscribe((online) => {
      if (!online) {
        sawOffline = true;
        return;
      }
      if (!sawOffline) return;
      sawOffline = false;
      if (succeeded || retried || !isCurrent()) return;
      // One retry per guest session; repeated native events cannot loop forever.
      retried = true;
      // Let API reads recover immediately while this background attempt gets
      // its own deadline, even when the original wait was almost exhausted.
      released = true;
      start();
    });
    start();
    return () => {
      disposed = true;
      activeAttempt = null;
      clearTimeout(timeout);
      unsubscribe();
    };
  }, [isGuest, queryClient, sessionVersion]);

  const current = isGuest && snapshot?.sessionVersion === sessionVersion;
  return {
    ready: !isGuest || (current && snapshot.ready),
    attempt: current ? snapshot.attempt : null,
  };
}
