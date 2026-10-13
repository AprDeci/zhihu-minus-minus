import { hashKey, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import {
  markRecentMomentsRead,
  type RecentMomentItem,
  type RecentMomentsResponse,
} from '@/api/zhihu';
import { getAuthSessionVersion } from '@/store/useAuthStore';

const queryKey = ['recent-moments'] as const;
const pendingReads = new WeakMap<object, Set<string>>();

/** Share read state between the avatar strip and the recent-user pager. */
export function useMarkRecentMomentRead(): (item: RecentMomentItem) => void {
  const queryClient = useQueryClient();

  return useCallback(
    (item: RecentMomentItem) => {
      const readToken = item.brief || item.id;
      if (!readToken) return;

      const sessionVersion = getAuthSessionVersion();
      const query = queryClient.getQueryCache().find({ queryKey, exact: true });
      const current = queryClient.getQueryData<RecentMomentsResponse>(queryKey);
      const previousItem = current?.data.find(
        (entry) =>
          entry.actor.id === item.actor.id &&
          (entry.brief || entry.id) === readToken,
      );
      if (!query || !current || !previousItem || previousItem.unread_count <= 0)
        return;

      let pending = pendingReads.get(query);
      if (!pending) {
        pending = new Set();
        pendingReads.set(query, pending);
      }
      const pendingKey = hashKey([sessionVersion, item.actor.id, readToken]);
      if (pending.has(pendingKey)) return;
      pending.add(pendingKey);

      const updated = queryClient.setQueryData<RecentMomentsResponse>(
        queryKey,
        {
          ...current,
          data: current.data.map((entry) =>
            entry === previousItem ? { ...entry, unread_count: 0 } : entry,
          ),
        },
      );
      // Query structural sharing can replace the object passed to setQueryData.
      // Roll back only the actual stored optimistic item, never a later update.
      const optimisticItem = updated?.data.find(
        (entry) =>
          entry.actor.id === item.actor.id &&
          (entry.brief || entry.id) === readToken,
      );
      const restoreUnreadCount = () => {
        if (
          sessionVersion !== getAuthSessionVersion() ||
          queryClient.getQueryCache().find({ queryKey, exact: true }) !== query
        )
          return;

        queryClient.setQueryData<RecentMomentsResponse>(queryKey, (latest) =>
          optimisticItem && latest?.data.includes(optimisticItem)
            ? {
                ...latest,
                data: latest.data.map((entry) =>
                  entry === optimisticItem ? previousItem : entry,
                ),
              }
            : latest,
        );
      };

      void (async () => {
        try {
          if (sessionVersion !== getAuthSessionVersion()) return;
          const result = await markRecentMomentsRead(readToken);
          if (!result.success) restoreUnreadCount();
        } catch {
          restoreUnreadCount();
        } finally {
          pending.delete(pendingKey);
        }
      })();
    },
    [queryClient],
  );
}
