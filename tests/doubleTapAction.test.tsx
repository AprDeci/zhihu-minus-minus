import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react-native';
import type { PropsWithChildren } from 'react';
import { voteContent } from '../api/zhihu';
import { useDoubleTapAction } from '../hooks/useDoubleTapAction';
import { updateContentInteractionCaches } from '../utils/contentCache';
import { impactAsync } from '../utils/haptics';
import { showToast } from '../utils/toast';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
}));
jest.mock('../api/zhihu', () => ({
  voteContent: jest.fn(),
  getVoteSuccessMessage: jest.fn(() => '已赞同'),
}));
jest.mock('../utils/contentCache', () => ({
  updateContentInteractionCaches: jest.fn(),
}));
jest.mock('../utils/haptics', () => ({
  impactAsync: jest.fn(async () => {}),
  ImpactFeedbackStyle: { Light: 'light' },
}));
jest.mock('../utils/toast', () => ({ showToast: jest.fn() }));
jest.mock('../utils/zhihuError', () => ({
  getZhihuErrorMessage: (error: unknown) =>
    error instanceof Error ? error.message : '失败',
}));
let mockDoubleTapAction: string | undefined;
jest.mock('../store/useSettingsStore', () => ({
  useSettingsStore: (
    selector: (state: { doubleTapAction?: string }) => unknown,
  ) => selector({ doubleTapAction: mockDoubleTapAction }),
}));
jest.mock('../store/useDoubleTapSetupStore', () => ({
  useDoubleTapSetupStore: (
    selector: (state: { show: () => void }) => unknown,
  ) => selector({ show: mockShowSetup }),
}));

const mockShowSetup = jest.fn();

const voteContentMock = jest.mocked(voteContent);
const updateCachesMock = jest.mocked(updateContentInteractionCaches);

let queryClient: QueryClient;

function wrapper({ children }: PropsWithChildren) {
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDoubleTapAction = undefined;
  queryClient = new QueryClient();
});

function setup(
  options: Partial<Parameters<typeof useDoubleTapAction>[0]> = {},
) {
  return renderHook(
    (props: Parameters<typeof useDoubleTapAction>[0]) =>
      useDoubleTapAction(props),
    {
      initialProps: {
        id: 'answer-1',
        type: 'answers' as const,
        commentType: 'answer' as const,
        ...options,
      },
      wrapper,
    },
  );
}

const endEvent = { state: 5 } as never;

test('the first double tap opens the setup sheet without voting or navigating', async () => {
  const host = await setup({ voted: 0, count: 7 });

  await act(() => host.result.current.gesture.handlers.onEnd?.(endEvent, true));

  expect(mockShowSetup).toHaveBeenCalledTimes(1);
  expect(voteContentMock).not.toHaveBeenCalled();
  expect(mockPush).not.toHaveBeenCalled();
  expect(updateCachesMock).not.toHaveBeenCalled();
  await host.unmount();
});

test('the off action stays completely silent', async () => {
  mockDoubleTapAction = 'off';
  const host = await setup({ voted: 0, count: 7 });

  await act(() => host.result.current.gesture.handlers.onEnd?.(endEvent, true));

  expect(impactAsync).not.toHaveBeenCalled();
  expect(mockShowSetup).not.toHaveBeenCalled();
  expect(voteContentMock).not.toHaveBeenCalled();
  expect(mockPush).not.toHaveBeenCalled();
  await host.unmount();
});

test('the like action upvotes through the shared interaction cache', async () => {
  mockDoubleTapAction = 'like';
  voteContentMock.mockResolvedValue({ voted: 1, voteCount: 8 });
  const host = await setup({ voted: 0, count: 7 });

  await act(() => host.result.current.gesture.handlers.onEnd?.(endEvent, true));

  expect(impactAsync).toHaveBeenCalledTimes(1);
  expect(voteContentMock).toHaveBeenCalledWith('answer-1', 'answers', 'up');
  expect(updateCachesMock).toHaveBeenCalledWith(queryClient, {
    type: 'answers',
    id: 'answer-1',
    voted: 1,
    voteCount: 8,
  });
  expect(showToast).toHaveBeenCalledWith('已赞同');
  await host.unmount();
});

test('like falls back to the local count when the API omits one', async () => {
  mockDoubleTapAction = 'like';
  voteContentMock.mockResolvedValue({ voted: 1 });
  const host = await setup({ voted: 0, count: 7 });

  await act(() => host.result.current.gesture.handlers.onEnd?.(endEvent, true));

  expect(updateCachesMock).toHaveBeenCalledWith(
    queryClient,
    expect.objectContaining({ voteCount: 8 }),
  );
  await host.unmount();
});

test('liking already-liked content only gives feedback', async () => {
  mockDoubleTapAction = 'like';
  const host = await setup({ voted: 1, count: 8 });

  await act(() => host.result.current.gesture.handlers.onEnd?.(endEvent, true));

  expect(impactAsync).toHaveBeenCalledTimes(1);
  expect(voteContentMock).not.toHaveBeenCalled();
  expect(updateCachesMock).not.toHaveBeenCalled();
  expect(showToast).not.toHaveBeenCalled();
  await host.unmount();
});

test('the comments action routes to the owning content comment list', async () => {
  mockDoubleTapAction = 'comments';
  const host = await setup({ commentType: 'pin', id: 'pin-9' });

  await act(() => host.result.current.gesture.handlers.onEnd?.(endEvent, true));

  expect(mockPush).toHaveBeenCalledWith('/comments/pin-9?type=pin');
  expect(voteContentMock).not.toHaveBeenCalled();
  await host.unmount();
});

test('a failed or cancelled tap never runs the action', async () => {
  mockDoubleTapAction = 'like';
  const host = await setup({ voted: 0, count: 7 });

  await act(() =>
    host.result.current.gesture.handlers.onEnd?.(endEvent, false),
  );

  expect(voteContentMock).not.toHaveBeenCalled();
  expect(mockShowSetup).not.toHaveBeenCalled();
  await host.unmount();
});

test('a rejected vote reports the error and leaves the cache untouched', async () => {
  mockDoubleTapAction = 'like';
  voteContentMock.mockRejectedValue(new Error('需要登录'));
  const host = await setup({ voted: 0, count: 7 });

  await act(() => host.result.current.gesture.handlers.onEnd?.(endEvent, true));

  expect(updateCachesMock).not.toHaveBeenCalled();
  expect(showToast).toHaveBeenCalledWith('需要登录');
  await host.unmount();
});

test('rapid like double taps collapse into a single request', async () => {
  mockDoubleTapAction = 'like';
  let resolveVote: (value: { voted: 1; voteCount: number }) => void = () => {};
  voteContentMock.mockReturnValue(
    new Promise((resolve) => {
      resolveVote = resolve;
    }),
  );
  const host = await setup({ voted: 0, count: 7 });
  const trigger = host.result.current.gesture.handlers.onEnd;

  await act(async () => {
    void trigger?.(endEvent, true);
    void trigger?.(endEvent, true);
    resolveVote({ voted: 1, voteCount: 8 });
  });

  expect(voteContentMock).toHaveBeenCalledTimes(1);
  await host.unmount();
});

test('the disabled gesture keeps its double-tap config without acting', async () => {
  mockDoubleTapAction = 'like';
  const host = await setup({ voted: 0, count: 7, enabled: false });

  expect(host.result.current.gesture.config.numberOfTaps).toBe(2);
  expect(host.result.current.gesture.config.enabled).toBe(false);
  await host.unmount();
});

test('switching the setting changes the next action without a rebuild', async () => {
  const host = await setup({ voted: 0, count: 7 });

  await act(() => host.result.current.gesture.handlers.onEnd?.(endEvent, true));
  expect(mockShowSetup).toHaveBeenCalledTimes(1);

  mockDoubleTapAction = 'comments';
  await host.rerender({
    id: 'answer-1',
    type: 'answers',
    commentType: 'answer',
    voted: 0,
    count: 7,
  });
  await act(() => host.result.current.gesture.handlers.onEnd?.(endEvent, true));

  expect(mockPush).toHaveBeenCalledWith('/comments/answer-1?type=answer');
  await host.unmount();
});
