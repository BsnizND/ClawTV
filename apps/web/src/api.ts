const apiOrigin = import.meta.env.VITE_CLAWTV_API_ORIGIN;

export function resolveApiUrl(path: string): string {
  const normalizedPath = path.replace(/^\/+/u, "");

  if (apiOrigin) {
    return resolveRelativeUrl(apiOrigin, normalizedPath).toString();
  }

  const appBaseUrl = new URL(import.meta.env.BASE_URL, window.location.origin).toString();
  return resolveRelativeUrl(appBaseUrl, normalizedPath).toString();
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function resolveRelativeUrl(baseUrl: string, path: string): URL {
  const normalizedPath = path.replace(/^\/+/u, "");
  return new URL(normalizedPath, ensureTrailingSlash(baseUrl));
}
