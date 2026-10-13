import type { Query, QueryClient } from '@tanstack/react-query';

/** Restart reads using a lost connection without discarding their cached pages. */
export function restartInterruptedQueries(
  queryClient: QueryClient,
  shouldRestart: (query: Query) => boolean = () => true,
): void {
  const interruptedQueries = queryClient.getQueryCache().findAll({
    type: 'active',
    fetchStatus: 'fetching',
    predicate: (query) =>
      !query.isDisabled() &&
      query.options.networkMode !== 'always' &&
      shouldRestart(query),
  });

  for (const query of interruptedQueries) {
    // Preserve fetchNextPage/fetchPreviousPage rather than refetching every page.
    const meta = query.state.fetchMeta ?? undefined;
    // Query cancellation synchronously reverts state and aborts the old signal.
    // Do not await: a reconnect event must see the replacement task, including
    // its paused state when the online manager still reports the old network.
    void query.cancel({ revert: true });
    void query.fetch(undefined, { meta }).catch(() => undefined);
  }
}
