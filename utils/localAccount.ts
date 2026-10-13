export interface LocalAccountIdentitySource {
  id?: string | number | null;
  url_token?: string | null;
}

/**
 * Returns a stable, namespaced account key for local per-account data.
 * Authentication takes precedence over a profile retained after session expiry.
 * Authenticated sessions without loaded profile data return null so records
 * are never written into a shared temporary account bucket.
 */
export function resolveLocalAccountKey(
  account: LocalAccountIdentitySource | null | undefined,
  hasAuthenticatedSession: boolean,
): string | null {
  if (!hasAuthenticatedSession) return 'guest';

  const id = account?.id?.toString().trim();
  if (id) return `id:${id}`;

  const urlToken = account?.url_token?.toString().trim();
  if (urlToken) return `url-token:${urlToken}`;

  return null;
}
