const PRIVATE_HOST =
  /(?:^|\.)(?:localhost|local|internal|lan|home|localdomain)$/i;
const PRIVATE_PATH =
  /(?:^|\/)(?:login|signin|sign-in|signup|oauth\d*|authorize|auth|session|logout)(?:\/|$)/i;
const API_PATH = /(?:^|\/)(?:api(?:[-_]v?\d+)?|v\d+)(?:\/|$)/i;
const TRACKING_QUERY =
  /^(?:utm_.+|spm|from|source|ref|referrer|fbclid|gclid)$/i;

function publicQuery(url: URL, images: boolean): string | undefined {
  const host = url.hostname.toLowerCase();
  if (images) {
    // Zhihu's image CDN identifies images in the path; its query only changes
    // delivery/appearance. Unknown image endpoints may identify the image via
    // ?id=, so dropping that query would silently download a different picture.
    if (/(?:^|\.)zhimg\.com$/.test(host)) return '';
    return [...url.searchParams.keys()].every((key) => TRACKING_QUERY.test(key))
      ? ''
      : undefined;
  }
  const retained = new URLSearchParams();
  if (/(?:^|\.)youtube\.com$/.test(host) && url.pathname === '/watch') {
    const video = url.searchParams.get('v');
    if (!video || !/^[\w-]{11}$/.test(video)) return undefined;
    retained.set('v', video);
    return retained.toString();
  } else if (
    /(?:^|\.)wikipedia\.org$/.test(host) &&
    url.pathname === '/w/index.php'
  ) {
    const title = url.searchParams.get('title');
    const revision = url.searchParams.get('oldid');
    if (title && title.length <= 300 && !hasInvalidCharacters(title))
      retained.set('title', title);
    if (revision && /^\d{1,20}$/.test(revision))
      retained.set('oldid', revision);
    if (!retained.toString()) return undefined;
    return retained.toString();
  }
  // Unknown query parameters may identify a different page. Preserve the label
  // without a link instead of silently changing its destination.
  return [...url.searchParams.keys()].every((key) => TRACKING_QUERY.test(key))
    ? ''
    : undefined;
}

/** Exported files may outlive a session: never retain credentials or URL tokens. */
function hasInvalidCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 || character === '\\';
  });
}

function publicUrl(value: string, images: boolean): string | undefined {
  let candidate = value.trim();
  const visited = new Set<string>();
  for (let depth = 0; depth < 5; depth += 1) {
    if (
      !/^(?:https?:\/\/|\/)/i.test(candidate) ||
      hasInvalidCharacters(candidate)
    )
      return undefined;
    try {
      const url = new URL(candidate, 'https://www.zhihu.com');
      const host = url.hostname.toLowerCase().replace(/\.$/, '');
      if (
        (images
          ? url.protocol !== 'https:'
          : !/^https?:$/.test(url.protocol)) ||
        url.username ||
        url.password ||
        url.port ||
        !host.includes('.') ||
        host.includes(':') ||
        /^[\d.]+$/.test(host) ||
        PRIVATE_HOST.test(host) ||
        /(?:^|\.)api(?:\d*)\./i.test(host) ||
        visited.has(url.href)
      )
        return undefined;
      visited.add(url.href);
      if (!images && host === 'link.zhihu.com') {
        const target = url.searchParams.get('target');
        if (!target) return undefined;
        candidate = target;
        continue;
      }
      let decodedPath = url.pathname;
      // Reject encoded API/login routes too, including double-encoded segments.
      for (let pass = 0; pass < 3; pass += 1) {
        const next = decodeURIComponent(decodedPath);
        if (next === decodedPath) break;
        decodedPath = next;
      }
      // MDN's public documentation contains an API path segment. Limit this
      // exception to article links; API endpoints and image fetches stay blocked.
      const publicApiDocumentation =
        !images &&
        host === 'developer.mozilla.org' &&
        /^\/[a-z]{2,3}(?:-[a-z0-9]+)*\/docs\//i.test(decodedPath);
      if (
        PRIVATE_PATH.test(decodedPath) ||
        (API_PATH.test(decodedPath) && !publicApiDocumentation) ||
        hasInvalidCharacters(decodedPath)
      )
        return undefined;
      const query = publicQuery(url, images);
      if (query === undefined) return undefined;
      url.search = query;
      url.hash = '';
      return url.href;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Only public HTTP(S) content links; application routes and auth/API URLs are excluded. */
export function getSafeExportUrl(value: string): string | undefined {
  return publicUrl(value, false);
}

/** Public HTTPS image URLs; ambiguous query-based identities are rejected. */
export function getSafeExportImageUrl(value: string): string | undefined {
  return publicUrl(value, true);
}

/** The exporter only emits prepared raster data or its own relative assets folder. */
export function getSafePreparedAsset(value: string): string | undefined {
  if (
    /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(
      value,
    )
  )
    return value;
  if (/^assets\/[A-Za-z0-9_-]+\.(?:png|jpe?g|gif|webp)$/.test(value))
    return value;
  return undefined;
}
