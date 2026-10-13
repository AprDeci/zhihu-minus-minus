import {
  AxiosError,
  AxiosHeaders,
  type AxiosResponse,
  CanceledError,
} from 'axios';
import apiClient from '../api/client';
import { FEED_URLS, getFeed } from '../api/zhihu/feed';

jest.mock('../api/client', () => ({
  __esModule: true,
  default: { get: jest.fn() },
}));
jest.mock('../store/useAuthStore', () => ({
  useAuthStore: { getState: () => ({ cookies: null }) },
}));
jest.mock('../store/useSettingsStore', () => ({
  useSettingsStore: {
    getState: () => ({ updateSettings: jest.fn() }),
  },
}));

function response(data: unknown, status = 200): AxiosResponse<unknown> {
  return {
    config: { headers: new AxiosHeaders() },
    data,
    headers: {},
    status,
    statusText: 'Test response',
  };
}

const get = jest.mocked(apiClient.get);

beforeEach(() => {
  get.mockReset();
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => jest.restoreAllMocks());

describe.each([
  ['guest recommendation', FEED_URLS.recommend],
  ['local section', FEED_URLS.local],
] as const)('%s fallback', (_label, url) => {
  test.each([
    ['network failure', new AxiosError('Network Error', 'ERR_NETWORK')],
    ['request timeout', new AxiosError('Timed out', 'ECONNABORTED')],
    ['connection timeout', new AxiosError('Timed out', 'ETIMEDOUT')],
    ['cancellation', new CanceledError('Canceled')],
  ] as const)('does not issue a second request after %s', async (_name, error) => {
    get.mockRejectedValueOnce(error);

    await expect(getFeed(url)).rejects.toBe(error);
    expect(get).toHaveBeenCalledTimes(1);
  });

  test('retains compatibility fallback when the endpoint responds with HTTP 403', async () => {
    const data = { data: [], paging: { is_end: true } };
    get
      .mockRejectedValueOnce(
        new AxiosError(
          'Request rejected',
          'ERR_BAD_REQUEST',
          undefined,
          undefined,
          response({}, 403),
        ),
      )
      .mockResolvedValueOnce(response(data));

    await expect(getFeed(url)).resolves.toEqual(data);
    expect(get).toHaveBeenCalledTimes(2);
    const fallbackUrl = new URL(get.mock.calls[1]?.[0] ?? '');
    fallbackUrl.searchParams.delete('t');
    expect(fallbackUrl.toString()).toBe(
      url === FEED_URLS.local
        ? FEED_URLS.recommend
        : 'https://www.zhihu.com/api/v3/explore/guest/feeds?limit=15&ws_qiangzhisafe=0',
    );
  });
});
