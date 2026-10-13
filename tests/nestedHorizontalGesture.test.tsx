import { act, renderHook } from '@testing-library/react-native';
import {
  Gesture,
  type GestureTouchEvent,
  PointerType,
  State,
} from 'react-native-gesture-handler';
import { useNestedHorizontalGesture } from '../hooks/useNestedHorizontalGesture';

test('makes the native parent wait for the child without claiming touches before scrolling', async () => {
  const parentGesture = Gesture.Native();
  const host = await renderHook(() =>
    useNestedHorizontalGesture(undefined, true, parentGesture),
  );

  expect(host.result.current.config.blocksHandlers).toEqual([parentGesture]);
  expect(host.result.current.config.shouldActivateOnStart).not.toBe(true);
  await host.unmount();
});

const stateManager = {
  handlerTag: 1,
  begin: jest.fn(),
  activate: jest.fn(),
  fail: jest.fn(),
  end: jest.fn(),
};

function touchEvent(
  numberOfTouches: number,
  eventType: GestureTouchEvent['eventType'] = 1,
): GestureTouchEvent {
  return {
    handlerTag: 1,
    numberOfTouches,
    state: State.BEGAN,
    eventType,
    allTouches: [],
    changedTouches: [],
    pointerType: PointerType.TOUCH,
  };
}

test('locks on touch-down and keeps the parent locked until the final finger lifts', async () => {
  const onInteractionChange = jest.fn();
  const host = await renderHook(() =>
    useNestedHorizontalGesture(onInteractionChange),
  );
  const { handlers } = host.result.current;

  await act(() => handlers.onTouchesDown?.(touchEvent(1), stateManager));
  expect(onInteractionChange.mock.calls).toEqual([[true]]);

  await act(() => handlers.onTouchesDown?.(touchEvent(2), stateManager));
  await act(() => handlers.onTouchesUp?.(touchEvent(1, 3), stateManager));
  expect(onInteractionChange.mock.calls).toEqual([[true]]);

  await act(() => handlers.onTouchesUp?.(touchEvent(0, 3), stateManager));
  expect(onInteractionChange.mock.calls).toEqual([[true], [false]]);
  await host.unmount();
  expect(onInteractionChange).toHaveBeenCalledTimes(2);
});

test('native cancellation restores parent swiping and permits another interaction', async () => {
  const onInteractionChange = jest.fn();
  const host = await renderHook(() =>
    useNestedHorizontalGesture(onInteractionChange),
  );
  const { handlers } = host.result.current;

  await act(() => handlers.onTouchesDown?.(touchEvent(1), stateManager));
  await act(() =>
    handlers.onTouchesCancelled?.(touchEvent(0, 4), stateManager),
  );
  await act(() => handlers.onTouchesDown?.(touchEvent(1), stateManager));
  expect(onInteractionChange.mock.calls).toEqual([[true], [false], [true]]);

  await host.unmount();
  expect(onInteractionChange.mock.calls).toEqual([
    [true],
    [false],
    [true],
    [false],
  ]);
});

test('leaving the active page or removing its content releases an unfinished gesture', async () => {
  const onInteractionChange = jest.fn();
  const host = await renderHook(
    ({ enabled }: { enabled: boolean }) =>
      useNestedHorizontalGesture(onInteractionChange, enabled),
    { initialProps: { enabled: true } },
  );

  await act(() =>
    host.result.current.handlers.onTouchesDown?.(touchEvent(1), stateManager),
  );
  await host.rerender({ enabled: false });
  expect(onInteractionChange.mock.calls).toEqual([[true], [false]]);

  await host.rerender({ enabled: true });
  await act(() =>
    host.result.current.handlers.onTouchesDown?.(touchEvent(1), stateManager),
  );
  await host.unmount();
  expect(onInteractionChange.mock.calls).toEqual([
    [true],
    [false],
    [true],
    [false],
  ]);
});

test('failed or completed native gestures release the parent even without a touch-up event', async () => {
  const onInteractionChange = jest.fn();
  const host = await renderHook(() =>
    useNestedHorizontalGesture(onInteractionChange),
  );
  const { handlers } = host.result.current;
  await act(() => handlers.onTouchesDown?.(touchEvent(1), stateManager));
  await act(() =>
    handlers.onFinalize?.(
      {
        handlerTag: 1,
        state: State.CANCELLED,
        oldState: State.BEGAN,
        numberOfPointers: 0,
        pointerType: PointerType.TOUCH,
        pointerInside: false,
      },
      false,
    ),
  );
  expect(onInteractionChange.mock.calls).toEqual([[true], [false]]);
  await host.unmount();
});
