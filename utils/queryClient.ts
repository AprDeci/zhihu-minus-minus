import { type Query, QueryClient } from '@tanstack/react-query';
import { shouldRetryQuery } from './query';

function shouldRefetchOnResume(query: Query): boolean {
  const data = query.state.data;
  // Refetching a cached infinite query requests every loaded page in sequence,
  // blocking pagination while a weak connection is recovering. Paused and
  // interrupted fetches resume separately; empty queries retain normal recovery.
  return !(
    typeof data === 'object' &&
    data !== null &&
    'pages' in data &&
    Array.isArray(data.pages) &&
    data.pages.length > 0 &&
    'pageParams' in data &&
    Array.isArray(data.pageParams)
  );
}

export function createAppQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: shouldRetryQuery,
        retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),
        refetchOnWindowFocus: shouldRefetchOnResume,
        refetchOnReconnect: shouldRefetchOnResume,
      },
      // A vote, comment or publication must fail normally while offline, not
      // queue itself and get submitted later (possibly after switching accounts).
      mutations: { networkMode: 'always', retry: false },
    },
  });
}
