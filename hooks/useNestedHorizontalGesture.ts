import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Gesture, type NativeGesture } from 'react-native-gesture-handler';

/** Keep a parent pager locked for the whole native child touch sequence. */
export function useNestedHorizontalGesture(
  onInteractionChange?: (interacting: boolean) => void,
  enabled = true,
  parentGesture?: NativeGesture,
) {
  const interactingRef = useRef(false);
  const setInteracting = useCallback(
    (interacting: boolean) => {
      if (interactingRef.current === interacting) return;
      interactingRef.current = interacting;
      onInteractionChange?.(interacting);
    },
    [onInteractionChange],
  );

  useEffect(() => {
    if (!enabled) setInteracting(false);
    return () => setInteracting(false);
  }, [enabled, setInteracting]);

  return useMemo(() => {
    const gesture = Gesture.Native()
      .enabled(enabled)
      .runOnJS(true)
      .shouldCancelWhenOutside(false)
      .disallowInterruption(true)
      // RN onTouchCancel also fires when this ScrollView starts dragging.
      // Native touch callbacks keep the pager locked through that transition.
      .onTouchesDown(() => setInteracting(true))
      .onTouchesUp((event) => {
        if (event.numberOfTouches === 0) setInteracting(false);
      })
      .onTouchesCancelled(() => setInteracting(false))
      .onFinalize(() => setInteracting(false));

    // The native pager must wait for the touched child before claiming its pan.
    if (parentGesture) gesture.blocksExternalGesture(parentGesture);
    return gesture;
  }, [enabled, parentGesture, setInteracting]);
}
