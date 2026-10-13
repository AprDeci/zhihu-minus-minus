import { QueryClient } from '@tanstack/react-query';
import { AxiosError, AxiosHeaders, CanceledError } from 'axios';
import { shouldRetryQuery } from '../utils/query';

function httpError(status: number, data: unknown = {}): AxiosError {
  return new AxiosError(
    'Request failed',
    'ERR_BAD_RESPONSE',
    undefined,
    undefined,
    {
      config: { headers: new AxiosHeaders() },
      data,
      headers: {},
      status,
      statusText: 'Request failed',
    },
  );
}

test.each([
  ['network failure', new AxiosError('Network Error', 'ERR_NETWORK'), 2],
  ['request timeout', new AxiosError('Timed out', 'ECONNABORTED'), 2],
  ['connection timeout', new AxiosError('Timed out', 'ETIMEDOUT'), 2],
  ['HTTP 408', httpError(408), 3],
  ['HTTP 429', httpError(429), 3],
  ['HTTP 500', httpError(500), 3],
  ['HTTP 503', httpError(503), 3],
  ['HTTP 400', httpError(400), 1],
  ['HTTP 401', httpError(401), 1],
  ['HTTP 403', httpError(403), 1],
  ['HTTP 404', httpError(404), 1],
  ['verification', httpError(500, { error: { code: 40352 } }), 1],
  ['cancellation', new CanceledError('Canceled'), 1],
  ['non-transport failure', new Error('Invalid response'), 1],
] as const)('bounds query attempts after %s', async (_label, error, attempts) => {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: shouldRetryQuery, retryDelay: 0, gcTime: Infinity },
    },
  });
  const queryFn = jest.fn().mockRejectedValue(error);
  try {
    await expect(
      client.fetchQuery({ queryKey: ['retry-policy'], queryFn }),
    ).rejects.toBe(error);
    expect(queryFn).toHaveBeenCalledTimes(attempts);
  } finally {
    client.clear();
  }
});

test('recovers from a transport failure on its single automatic retry', async () => {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: shouldRetryQuery, retryDelay: 0, gcTime: Infinity },
    },
  });
  const queryFn = jest
    .fn()
    .mockRejectedValueOnce(new AxiosError('Network Error', 'ERR_NETWORK'))
    .mockResolvedValueOnce('recovered');
  try {
    await expect(
      client.fetchQuery({ queryKey: ['retry-recovery'], queryFn }),
    ).resolves.toBe('recovered');
    expect(queryFn).toHaveBeenCalledTimes(2);
  } finally {
    client.clear();
  }
});
