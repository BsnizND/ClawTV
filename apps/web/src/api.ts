import { resolveRelativeUrl } from "@clawtv/core";

const apiOrigin = import.meta.env.VITE_CLAWTV_API_ORIGIN;

export function resolveApiUrl(path: string): string {
  const normalizedPath = path.replace(/^\/+/u, "");

  if (apiOrigin) {
    return resolveRelativeUrl(apiOrigin, normalizedPath).toString();
  }

  const appBaseUrl = new URL(import.meta.env.BASE_URL, window.location.origin).toString();
  return resolveRelativeUrl(appBaseUrl, normalizedPath).toString();
}
