import { resolveLocalAccountKey } from '../utils/localAccount';

test.each([
  null,
  undefined,
  { id: 'expired-account', url_token: 'expired-token' },
  { url_token: 'expired-token' },
])('uses the guest scope without authentication despite retained profile %j', (profile) => {
  expect(resolveLocalAccountKey(profile, false)).toBe('guest');
});

test.each([
  [{ id: ' account ', url_token: 'token' }, 'id:account'],
  [{ id: 123 }, 'id:123'],
  [{ id: ' ', url_token: ' token ' }, 'url-token:token'],
  [{ url_token: 'token' }, 'url-token:token'],
  [{ id: ' ', url_token: ' ' }, null],
  [null, null],
  [undefined, null],
] as const)('preserves authenticated identity resolution for %j', (profile, expected) => {
  expect(resolveLocalAccountKey(profile, true)).toBe(expected);
});
