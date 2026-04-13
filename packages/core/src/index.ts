import type { ClientPlaybackState, ServerStatus } from "@clawtv/contracts";

export const APP_NAME = "ClawTV";
export const DEFAULT_BASE_PATH = "/ClawTV";

export function createBootstrapStatus(): ServerStatus {
  return {
    service: "clawtv-server",
    environment: "development",
    basePath: DEFAULT_BASE_PATH,
    activeSessionId: null,
    sessionCount: 0,
    playbackState: "idle",
    lastCommandName: null,
    lastCommandAt: null,
    catalog: {
      librariesIndexed: 0,
      mediaItemsIndexed: 0,
      lastSyncAt: null,
      lastSyncStatus: null
    }
  };
}

export function playbackLabel(state: ClientPlaybackState): string {
  if (state === "playing") {
    return "On air";
  }

  if (state === "paused") {
    return "Paused";
  }

  if (state === "loading") {
    return "Buffering";
  }

  if (state === "error") {
    return "Needs attention";
  }

  return "Idle";
}

export function normalizeBasePath(value: string | undefined | null): string {
  if (!value || value === "/") {
    return "";
  }

  const trimmed = value.trim().replace(/\/+$/u, "");
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export function withBasePath(basePath: string, path: string): string {
  const normalizedBasePath = normalizeBasePath(basePath);
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return normalizedBasePath ? `${normalizedBasePath}${normalizedPath}` : normalizedPath;
}

export function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

export function resolveRelativeUrl(baseUrl: string, path: string): URL {
  const normalizedPath = path.replace(/^\/+/u, "");
  return new URL(normalizedPath, ensureTrailingSlash(baseUrl));
}
