import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useCallback, useMemo, useRef } from 'react';
import { Gesture } from 'react-native-gesture-handler';
import { getVoteSuccessMessage, voteContent } from '@/api/zhihu';
import { useDoubleTapSetupStore } from '@/store/useDoubleTapSetupStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import {
  type CachedContentType,
  updateContentInteractionCaches,
} from '@/utils/contentCache';
import { ImpactFeedbackStyle, impactAsync } from '@/utils/haptics';
import { showToast } from '@/utils/toast';
import { getZhihuErrorMessage } from '@/utils/zhihuError';

export type DoubleTapCommentType = 'answer' | 'article' | 'pin';

export interface DoubleTapActionOptions {
  id: string;
  type: CachedContentType;
  commentType: DoubleTapCommentType;
  voted?: number;
  count?: number;
  enabled?: boolean;
}

/**
 * Double-tap handler for answer / article / pin bodies. The action follows the
 * shared `doubleTapAction` setting:
 *
 * - unset: prompt the one-time setup sheet without doing anything else;
 * - `off`: nothing at all, not even haptics;
 * - `like`: upvote once (an already-upvoted body only gives feedback);
 * - `comments`: open the comment list.
 *
 * Upvotes go through `updateContentInteractionCaches`, the same path as
 * `LikeButton`, so the floating vote capsule follows the shared cache.
 */
export function useDoubleTapAction({
  id,
  type,
  commentType,
  voted = 0,
  count = 0,
  enabled = true,
}: DoubleTapActionOptions) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const action = useSettingsStore((state) => state.doubleTapAction);
  const showSetup = useDoubleTapSetupStore((state) => state.show);
  const pendingRef = useRef(false);
  const stateRef = useRef({ id, voted, count });
  stateRef.current = { id, voted, count };

  const trigger = useCallback(async () => {
    const current = stateRef.current;

    if (action === undefined) {
      void impactAsync(ImpactFeedbackStyle.Light);
      showSetup();
      return;
    }
    if (action === 'off') return;
    if (action === 'comments') {
      router.push(`/comments/${current.id}?type=${commentType}`);
      return;
    }

    if (pendingRef.current) return;
    pendingRef.current = true;
    try {
      await impactAsync(ImpactFeedbackStyle.Light);
      if (current.voted === 1) return; // 已点赞：只反馈，不取消。

      const result = await voteContent(current.id, type, 'up');
      const voteCount =
        result.voteCount ??
        Math.max(0, current.count + (result.voted === 1 ? 1 : 0));
      updateContentInteractionCaches(queryClient, {
        type,
        id: current.id,
        voted: result.voted,
        voteCount,
      });
      showToast(getVoteSuccessMessage(type, current.voted, result.voted));
    } catch (error: unknown) {
      showToast(getZhihuErrorMessage(error));
    } finally {
      pendingRef.current = false;
    }
  }, [action, commentType, queryClient, router, showSetup, type]);

  const gesture = useMemo(
    () =>
      Gesture.Tap()
        .numberOfTaps(2)
        .runOnJS(true)
        .enabled(enabled)
        .onEnd((_event, success) => {
          if (success) void trigger();
        }),
    [enabled, trigger],
  );

  return { gesture };
}
