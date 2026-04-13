import { readFileSync, existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  CatalogMediaTypeFilter,
  ClientPlaybackState,
  CommandName,
  PlaybackDiagnostics,
  PlaybackDiagnosticsUpdateRequest,
  PlaybackStateUpdateRequest,
  SyncMode
} from "@clawtv/contracts";
import { DEFAULT_BASE_PATH, normalizeBasePath, withBasePath } from "@clawtv/core";
import { openClawTvDatabase } from "@clawtv/db";
import { syncPlexCatalog } from "@clawtv/plex-sync";

const rootDir = fileURLToPath(new URL("../../..", import.meta.url));
const port = Number(process.env.PORT ?? 8787);
const basePath = normalizeBasePath(process.env.CLAWTV_BASE_PATH ?? DEFAULT_BASE_PATH) || DEFAULT_BASE_PATH;
const webDistDir = join(rootDir, "apps", "web", "dist");
const db = openClawTvDatabase({
  rootDir,
  dataDir: process.env.CLAWTV_DATA_DIR,
  basePath
});
let latestPlaybackDiagnostics: PlaybackDiagnostics | null = null;
let activeHlsSession: {
  mediaItemId: string;
  plexRatingKey: string;
  mediaPlaylistUrl: string;
} | null = null;

process.on("SIGINT", () => {
  db.close();
  process.exit(0);
});

process.on("SIGTERM", () => {
  db.close();
  process.exit(0);
});

const server = createServer(async (request, response) => {
  const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const routePath = toRoutePath(requestUrl.pathname);
  const requestPath = requestUrl.pathname;
  const plexBaseUrl = process.env.PLEX_BASE_URL ?? "http://127.0.0.1:32400";
  const plexToken = process.env.PLEX_TOKEN;

  if (request.method === "OPTIONS") {
    sendJson(response, 204, {});
    return;
  }

  if (request.method === "GET" && routePath === "/health") {
    sendJson(response, 200, {
      ok: true,
      service: "clawtv-server",
      basePath
    });
    return;
  }

  if (request.method === "GET" && routePath === "/api/status") {
    sendJson(response, 200, db.getStatus());
    return;
  }

  if (request.method === "GET" && routePath === "/api/playback/current") {
    sendJson(response, 200, buildPlaybackSnapshot());
    return;
  }

  if (request.method === "GET" && routePath === "/api/playback/diagnostics") {
    sendJson(response, 200, {
      diagnostics: latestPlaybackDiagnostics
    });
    return;
  }

  if (request.method === "POST" && routePath === "/api/playback/diagnostics") {
    const body = (await readJsonBody(request)) as unknown as PlaybackDiagnosticsUpdateRequest;

    latestPlaybackDiagnostics = {
      playbackMode: parsePlaybackClientMode(body.playbackMode),
      nativeHlsSupported: Boolean(body.nativeHlsSupported),
      hlsJsSupported: Boolean(body.hlsJsSupported),
      autoplayStatus: parsePlaybackAutoplayStatus(body.autoplayStatus),
      lastEvent: typeof body.lastEvent === "string" && body.lastEvent.length > 0 ? body.lastEvent : "unknown",
      errorMessage: typeof body.errorMessage === "string" && body.errorMessage.length > 0 ? body.errorMessage : null,
      updatedAt: new Date().toISOString()
    };

    sendJson(response, 200, {
      diagnostics: latestPlaybackDiagnostics
    });
    return;
  }

  if ((request.method === "GET" || request.method === "HEAD") && routePath === "/api/playback/hls/current.m3u8") {
    const snapshot = buildPlaybackSnapshot();

    if (!snapshot.currentItem) {
      sendJson(response, 404, {
        ok: false,
        error: "No queued media item is active."
      });
      return;
    }

    if (!plexToken) {
      sendJson(response, 500, {
        ok: false,
        error: "PLEX_TOKEN is not configured on the server."
      });
      return;
    }

    try {
      await proxyCurrentPlexHlsPlaylist({
        request,
        response,
        plexBaseUrl,
        plexToken,
        mediaItemId: snapshot.currentItem.id,
        plexRatingKey: snapshot.currentItem.plexRatingKey
      });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to open Plex HLS playback.";
      sendJson(response, 502, {
        ok: false,
        error: message
      });
      return;
    }
  }

  if ((request.method === "GET" || request.method === "HEAD") && routePath === "/api/playback/hls/proxy") {
    const encodedUpstream = requestUrl.searchParams.get("upstream");

    if (!encodedUpstream || !plexToken) {
      sendJson(response, 400, {
        ok: false,
        error: "Missing HLS proxy target."
      });
      return;
    }

    try {
      const upstreamUrl = decodeProxyTarget(encodedUpstream);

      if (!isAllowedPlexUrl(upstreamUrl, plexBaseUrl)) {
        sendJson(response, 400, {
          ok: false,
          error: "Rejected HLS proxy target."
        });
        return;
      }

      await proxyPlexResponse({
        request,
        response,
        sourceUrl: upstreamUrl.toString(),
        rewritePlaylist: upstreamUrl.pathname.endsWith(".m3u8"),
        plexBaseUrl,
        plexToken
      });

      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to proxy the Plex HLS resource.";
      sendJson(response, 502, {
        ok: false,
        error: message
      });
      return;
    }
  }

  if ((request.method === "GET" || request.method === "HEAD") && routePath === "/api/playback/art/current") {
    const snapshot = db.getPlaybackSnapshot();
    const kind = requestUrl.searchParams.get("kind");
    const sourceUrl = kind === "thumb"
      ? snapshot.currentItem?.thumbUrl
      : snapshot.currentItem?.posterUrl;

    if (!sourceUrl) {
      sendJson(response, 404, {
        ok: false,
        error: "No artwork is available for the current playback item."
      });
      return;
    }

    try {
      await proxyBinaryResponse({
        request,
        response,
        sourceUrl
      });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load playback artwork.";
      sendJson(response, 502, {
        ok: false,
        error: message
      });
      return;
    }
  }

  if (request.method === "POST" && routePath === "/api/playback/state") {
    const body = (await readJsonBody(request)) as unknown as PlaybackStateUpdateRequest;
    const nextState = parseOptionalPlaybackState(body.state);
    const nextPositionMs = typeof body.positionMs === "number" && Number.isFinite(body.positionMs)
      ? Math.max(0, Math.round(body.positionMs))
      : undefined;
    db.setClientPlaybackState(nextState, {
      sessionId: typeof body.sessionId === "string" ? body.sessionId : undefined,
      positionMs: nextPositionMs
    });

    sendJson(response, 200, buildPlaybackSnapshot());
    return;
  }

  if (request.method === "POST" && routePath === "/api/playback/receiver-command/ack") {
    const body = await readJsonBody(request);
    const nextSnapshot = db.clearReceiverCommand(
      typeof body.sessionId === "string" ? body.sessionId : undefined,
      typeof body.commandId === "string" ? body.commandId : undefined
    );
    sendJson(response, 200, {
      ok: true,
      snapshot: {
        ...nextSnapshot,
        diagnostics: latestPlaybackDiagnostics
      }
    });
    return;
  }

  if ((request.method === "GET" || request.method === "HEAD") && routePath === "/api/playback/stream/current") {
    const snapshot = buildPlaybackSnapshot();

    if (!snapshot.currentItem) {
      sendJson(response, 404, {
        ok: false,
        error: "No queued media item is active."
      });
      return;
    }

    if (!plexToken) {
      sendJson(response, 500, {
        ok: false,
        error: "PLEX_TOKEN is not configured on the server."
      });
      return;
    }

    try {
      const streamUrl = await resolvePlexStreamUrl({
        baseUrl: plexBaseUrl,
        token: plexToken,
        ratingKey: snapshot.currentItem.plexRatingKey
      });

      await proxyBinaryResponse({
        request,
        response,
        sourceUrl: streamUrl.toString()
      });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to open Plex stream.";
      sendJson(response, 502, {
        ok: false,
        error: message
      });
      return;
    }
  }

  if (request.method === "GET" && routePath === "/api/sessions") {
    sendJson(response, 200, { sessions: db.listSessions() });
    return;
  }

  if (request.method === "GET" && routePath === "/api/catalog/search") {
    const query = requestUrl.searchParams.get("query") ?? requestUrl.searchParams.get("q") ?? "";
    const mediaType = parseCatalogMediaType(requestUrl.searchParams.get("type"));
    const limit = parseCatalogLimit(requestUrl.searchParams.get("limit"));

    sendJson(response, 200, db.searchCatalog({
      query,
      mediaType,
      limit
    }));
    return;
  }

  if (request.method === "GET" && routePath === "/api/catalog/shows") {
    const limit = parseCatalogLimit(requestUrl.searchParams.get("limit"));
    sendJson(response, 200, db.listShows(limit));
    return;
  }

  if (request.method === "GET" && routePath === "/api/catalog/collections") {
    const limit = parseCatalogLimit(requestUrl.searchParams.get("limit"));
    sendJson(response, 200, db.listCollections(limit));
    return;
  }

  if (request.method === "GET" && routePath === "/api/catalog/recently-added") {
    const mediaType = parseCatalogMediaType(requestUrl.searchParams.get("type"));
    const limit = parseCatalogLimit(requestUrl.searchParams.get("limit"));
    sendJson(response, 200, db.listRecentlyAdded({
      mediaType,
      limit
    }));
    return;
  }

  if (request.method === "GET" && routePath === "/api/sync/status") {
    sendJson(response, 200, {
      latestRun: db.getLatestSyncRun()
    });
    return;
  }

  if (request.method === "POST" && routePath === "/api/sync/plex") {
    const body = await readJsonBody(request);
    const mode = parseSyncMode(body.mode);
    const library = typeof body.library === "string" ? body.library : undefined;
    if (!plexToken) {
      const syncRun = db.recordFailedSyncRun({
        mode,
        status: "failed",
        librariesSynced: 0,
        mediaItemsSynced: 0,
        errorMessage: "PLEX_TOKEN is not configured on the server."
      });

      sendJson(response, 500, {
        ok: false,
        error: "PLEX_TOKEN is not configured on the server.",
        syncRun
      });
      return;
    }

    try {
      const payload = await syncPlexCatalog({
        baseUrl: plexBaseUrl,
        token: plexToken,
        mode,
        library
      });
      const syncRun = db.applyCatalogSync(payload, {
        mode,
        status: "success",
        librariesSynced: payload.libraries.length,
        mediaItemsSynced: payload.mediaItems.length
      });

      sendJson(response, 202, {
        ok: true,
        syncRun
      });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Plex sync failed.";
      const syncRun = db.recordFailedSyncRun({
        mode,
        status: "failed",
        librariesSynced: 0,
        mediaItemsSynced: 0,
        errorMessage: message
      });

      sendJson(response, 500, {
        ok: false,
        error: message,
        syncRun
      });
      return;
    }
  }

  if (request.method === "POST" && routePath.startsWith("/api/commands/")) {
    const commandName = parseCommandName(routePath.replace("/api/commands/", ""));

    if (!commandName) {
      sendJson(response, 404, {
        ok: false,
        error: `Unknown command route: ${routePath}`
      });
      return;
    }

    const body = await readJsonBody(request);
    const result = db.applyCommand({
      commandName,
      payload: body,
      source: "cli"
    });

    sendJson(response, result.ok ? 202 : 404, result);
    return;
  }

  if (request.method === "GET" && serveStaticAsset(requestPath, response)) {
    return;
  }

  sendJson(response, 404, {
    ok: false,
    error: `No route for ${request.method ?? "GET"} ${requestUrl.pathname}`
  });
});

server.listen(port, () => {
  console.log(`ClawTV server listening on http://localhost:${port}${withBasePath(basePath, "/")}`);
  console.log(`API status endpoint: http://localhost:${port}${withBasePath(basePath, "/api/status")}`);
});

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function parseSyncMode(value: unknown): SyncMode {
  return value === "incremental-sync" || value === "single-item-refresh" || value === "full-sync"
    ? value
    : "full-sync";
}

function parseCatalogMediaType(value: string | null): CatalogMediaTypeFilter {
  return value === "show" || value === "season" || value === "episode" || value === "movie"
    ? value
    : "any";
}

function parseCatalogLimit(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return undefined;
  }

  return parsed;
}

function parsePlaybackState(value: unknown): ClientPlaybackState {
  return value === "booting"
    || value === "idle"
    || value === "loading"
    || value === "playing"
    || value === "paused"
    || value === "error"
    ? value
    : "idle";
}

function parseOptionalPlaybackState(value: unknown): ClientPlaybackState | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  return parsePlaybackState(value);
}

function parseCommandName(value: string): CommandName | null {
  return value === "play"
    || value === "play-latest"
    || value === "shuffle"
    || value === "pause"
    || value === "resume"
    || value === "seek"
    || value === "refresh"
    || value === "next"
    || value === "stop"
    ? value
    : null;
}

function parsePlaybackClientMode(value: unknown): PlaybackDiagnostics["playbackMode"] {
  return value === "idle" || value === "native-hls" || value === "hls.js" || value === "unsupported"
    ? value
    : "idle";
}

function parsePlaybackAutoplayStatus(value: unknown): PlaybackDiagnostics["autoplayStatus"] {
  return value === "unknown" || value === "started" || value === "blocked" || value === "failed"
    ? value
    : "unknown";
}

function toRoutePath(pathname: string): string {
  if (pathname === basePath || pathname === `${basePath}/`) {
    return "/";
  }

  if (basePath && pathname.startsWith(`${basePath}/`)) {
    return pathname.slice(basePath.length) || "/";
  }

  return pathname;
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload, null, 2));
}

function buildPlaybackSnapshot() {
  const snapshot = db.getPlaybackSnapshot();

  if (activeHlsSession && snapshot.currentItem?.id !== activeHlsSession.mediaItemId) {
    activeHlsSession = null;
  }

  if (!snapshot.currentItem) {
    return {
      ...snapshot,
      streamPath: null,
      diagnostics: latestPlaybackDiagnostics
    };
  }

  return {
    ...snapshot,
    currentItem: {
      ...snapshot.currentItem,
      posterUrl: withBasePath(basePath, `/api/playback/art/current?kind=poster&currentItemId=${encodeURIComponent(snapshot.currentItem.id)}`),
      thumbUrl: withBasePath(basePath, `/api/playback/art/current?kind=thumb&currentItemId=${encodeURIComponent(snapshot.currentItem.id)}`)
    },
    streamPath: snapshot.currentItem ? withBasePath(basePath, "/api/playback/hls/current.m3u8") : null,
    diagnostics: latestPlaybackDiagnostics
  };
}

function buildProxyHeaders(response: Response): Record<string, string> {
  const headerNames = [
    "accept-ranges",
    "cache-control",
    "content-length",
    "content-range",
    "content-type",
    "etag",
    "last-modified",
    "transfer-encoding"
  ];

  return Object.fromEntries(
    headerNames
      .map((name) => {
        const value = response.headers.get(name);
        return value ? [name, value] : null;
      })
      .filter((entry): entry is [string, string] => Boolean(entry))
  );
}

async function resolvePlexStreamUrl(input: {
  baseUrl: string;
  token: string;
  ratingKey: string;
}): Promise<URL> {
  const metadataUrl = new URL(`library/metadata/${input.ratingKey}`, ensureTrailingSlash(input.baseUrl));
  metadataUrl.searchParams.set("X-Plex-Token", input.token);

  const metadataResponse = await fetch(metadataUrl, {
    headers: {
      Accept: "application/json"
    }
  });

  if (!metadataResponse.ok) {
    throw new Error(`Plex metadata request failed with status ${metadataResponse.status}.`);
  }

  const payload = await metadataResponse.json() as PlexMetadataResponse;
  const metadataItem = payload.MediaContainer?.Metadata?.[0];
  const partKey = metadataItem?.Media?.[0]?.Part?.[0]?.key;

  if (typeof partKey !== "string" || partKey.length === 0) {
    throw new Error(`No playable Plex media part was found for item ${input.ratingKey}.`);
  }

  const streamUrl = new URL(partKey.replace(/^\/+/u, ""), ensureTrailingSlash(input.baseUrl));
  streamUrl.searchParams.set("download", "0");
  streamUrl.searchParams.set("X-Plex-Token", input.token);
  return streamUrl;
}

function resolvePlexHlsStartUrl(input: {
  baseUrl: string;
  token: string;
  ratingKey: string;
}): URL {
  const hlsUrl = new URL("video/%3A/transcode/universal/start.m3u8", ensureTrailingSlash(input.baseUrl));

  hlsUrl.searchParams.set("path", `/library/metadata/${input.ratingKey}`);
  hlsUrl.searchParams.set("mediaIndex", "0");
  hlsUrl.searchParams.set("partIndex", "0");
  hlsUrl.searchParams.set("protocol", "hls");
  hlsUrl.searchParams.set("offset", "0");
  hlsUrl.searchParams.set("fastSeek", "1");
  hlsUrl.searchParams.set("directPlay", "0");
  hlsUrl.searchParams.set("directStream", "1");
  hlsUrl.searchParams.set("subtitleSize", "100");
  hlsUrl.searchParams.set("audioBoost", "100");
  hlsUrl.searchParams.set("maxVideoBitrate", "8000");
  hlsUrl.searchParams.set("X-Plex-Platform", "Chrome");
  hlsUrl.searchParams.set("X-Plex-Product", "ClawTV");
  hlsUrl.searchParams.set("X-Plex-Client-Identifier", "clawtv-web");
  hlsUrl.searchParams.set("X-Plex-Token", input.token);

  return hlsUrl;
}

async function getOrCreatePlexHlsMediaPlaylistUrl(input: {
  baseUrl: string;
  token: string;
  mediaItemId: string;
  ratingKey: string;
}): Promise<string> {
  if (
    activeHlsSession
    && activeHlsSession.mediaItemId === input.mediaItemId
    && activeHlsSession.plexRatingKey === input.ratingKey
  ) {
    return activeHlsSession.mediaPlaylistUrl;
  }

  const startUrl = resolvePlexHlsStartUrl({
    baseUrl: input.baseUrl,
    token: input.token,
    ratingKey: input.ratingKey
  });
  const startResponse = await fetch(startUrl, {
    headers: {
      Accept: "application/vnd.apple.mpegurl"
    }
  });

  if (!startResponse.ok) {
    throw new Error(`Plex HLS session start failed with status ${startResponse.status}.`);
  }

  const masterPlaylist = await startResponse.text();
  const mediaPlaylistPath = masterPlaylist
    .split(/\r?\n/u)
    .find((line) => line.length > 0 && !line.startsWith("#"));

  if (!mediaPlaylistPath) {
    throw new Error("Plex HLS session did not return a media playlist path.");
  }

  const mediaPlaylistUrl = new URL(mediaPlaylistPath, startUrl).toString();

  activeHlsSession = {
    mediaItemId: input.mediaItemId,
    plexRatingKey: input.ratingKey,
    mediaPlaylistUrl
  };

  return mediaPlaylistUrl;
}

async function proxyCurrentPlexHlsPlaylist(input: {
  request: IncomingMessage;
  response: ServerResponse;
  plexBaseUrl: string;
  plexToken: string;
  mediaItemId: string;
  plexRatingKey: string;
}): Promise<void> {
  const playlistInput = {
    baseUrl: input.plexBaseUrl,
    token: input.plexToken,
    mediaItemId: input.mediaItemId,
    ratingKey: input.plexRatingKey
  };

  try {
    const mediaPlaylistUrl = await getOrCreatePlexHlsMediaPlaylistUrl(playlistInput);
    await proxyPlexResponse({
      request: input.request,
      response: input.response,
      sourceUrl: mediaPlaylistUrl,
      rewritePlaylist: true,
      plexBaseUrl: input.plexBaseUrl,
      plexToken: input.plexToken
    });
  } catch (error) {
    if (!isStalePlexPlaylistError(error)) {
      throw error;
    }

    activeHlsSession = null;
    const retryPlaylistUrl = await getOrCreatePlexHlsMediaPlaylistUrl(playlistInput);
    await proxyPlexResponse({
      request: input.request,
      response: input.response,
      sourceUrl: retryPlaylistUrl,
      rewritePlaylist: true,
      plexBaseUrl: input.plexBaseUrl,
      plexToken: input.plexToken
    });
  }
}

async function proxyBinaryResponse(input: {
  request: IncomingMessage;
  response: ServerResponse;
  sourceUrl: string;
}): Promise<void> {
  const upstreamHeaders = new Headers();
  const rangeHeader = input.request.headers.range;

  if (typeof rangeHeader === "string" && rangeHeader.length > 0) {
    upstreamHeaders.set("Range", rangeHeader);
  }

  const upstreamResponse = await fetch(input.sourceUrl, {
    method: input.request.method,
    headers: upstreamHeaders
  });

  if (!upstreamResponse.ok && upstreamResponse.status !== 206) {
    throw new Error(`Plex proxy request failed with status ${upstreamResponse.status}.`);
  }

  input.response.writeHead(upstreamResponse.status, buildProxyHeaders(upstreamResponse));

  if (input.request.method === "HEAD" || !upstreamResponse.body) {
    input.response.end();
    return;
  }

  const reader = upstreamResponse.body.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      if (value) {
        input.response.write(Buffer.from(value));
      }
    }
  } finally {
    reader.releaseLock();
  }

  input.response.end();
}

async function proxyPlexResponse(input: {
  request: IncomingMessage;
  response: ServerResponse;
  sourceUrl: string;
  rewritePlaylist: boolean;
  plexBaseUrl: string;
  plexToken: string;
}): Promise<void> {
  const sourceUrl = appendPlexToken(input.sourceUrl, input.plexToken, input.plexBaseUrl);

  if (!input.rewritePlaylist) {
    await proxyBinaryResponse({
      request: input.request,
      response: input.response,
      sourceUrl
    });
    return;
  }

  const upstreamResponse = await fetch(sourceUrl, {
    method: input.request.method
  });

  if (!upstreamResponse.ok) {
    throw new Error(`Plex playlist request failed with status ${upstreamResponse.status}.`);
  }

  const contentType = upstreamResponse.headers.get("content-type") ?? "application/vnd.apple.mpegurl";

  if (input.request.method === "HEAD") {
    input.response.writeHead(upstreamResponse.status, {
      "cache-control": upstreamResponse.headers.get("cache-control") ?? "no-cache",
      "content-type": contentType
    });
    input.response.end();
    return;
  }

  const playlistText = await upstreamResponse.text();
  const rewrittenPlaylist = rewriteHlsPlaylist(playlistText, sourceUrl);

  input.response.writeHead(upstreamResponse.status, {
    "cache-control": upstreamResponse.headers.get("cache-control") ?? "no-cache",
    "content-type": contentType
  });
  input.response.end(rewrittenPlaylist);
}

function rewriteHlsPlaylist(playlistText: string, upstreamUrlValue: string): string {
  const upstreamUrl = new URL(upstreamUrlValue);

  return playlistText
    .split(/\r?\n/u)
    .map((line) => rewriteHlsPlaylistLine(line, upstreamUrl))
    .join("\n");
}

function rewriteHlsPlaylistLine(line: string, upstreamUrl: URL): string {
  if (line.length === 0) {
    return line;
  }

  if (line.startsWith("#")) {
    return line.replace(/URI="([^"]+)"/gu, (_match, uri: string) => {
      const proxied = buildHlsProxyUrl(new URL(uri, upstreamUrl));
      return `URI="${proxied}"`;
    });
  }

  return buildHlsProxyUrl(new URL(line, upstreamUrl));
}

function buildHlsProxyUrl(targetUrl: URL): string {
  const sanitizedUrl = new URL(targetUrl.toString());

  sanitizedUrl.searchParams.delete("X-Plex-Token");

  return withBasePath(basePath, `/api/playback/hls/proxy?upstream=${encodeURIComponent(encodeProxyTarget(sanitizedUrl.toString()))}`);
}

function appendPlexToken(sourceUrl: string, token: string, plexBaseUrl: string): string {
  const url = new URL(sourceUrl);

  if (isAllowedPlexUrl(url, plexBaseUrl) && !url.searchParams.has("X-Plex-Token")) {
    url.searchParams.set("X-Plex-Token", token);
  }

  return url.toString();
}

function isStalePlexPlaylistError(error: unknown): boolean {
  return error instanceof Error
    && /Plex playlist request failed with status 404/u.test(error.message);
}

function encodeProxyTarget(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodeProxyTarget(value: string): URL {
  const decoded = Buffer.from(value, "base64url").toString("utf8");
  return new URL(decoded);
}

function isAllowedPlexUrl(url: URL, plexBaseUrl: string): boolean {
  const plexUrl = new URL(plexBaseUrl);

  return url.protocol === plexUrl.protocol
    && url.hostname === plexUrl.hostname
    && String(url.port || defaultPortForProtocol(url.protocol)) === String(plexUrl.port || defaultPortForProtocol(plexUrl.protocol));
}

function defaultPortForProtocol(protocol: string): string {
  return protocol === "https:" ? "443" : "80";
}

function serveStaticAsset(requestPath: string, response: ServerResponse): boolean {
  const routePath = toRoutePath(requestPath);
  const relativePath = routePath === "/"
    ? "index.html"
    : routePath.replace(/^\/+/u, "");
  const normalizedPath = normalize(relativePath).replace(/^(\.\.(\/|\\|$))+/, "");
  const assetPath = join(webDistDir, normalizedPath);

  if (!assetPath.startsWith(webDistDir) || !existsSync(assetPath)) {
    const indexPath = join(webDistDir, "index.html");

    if (existsSync(indexPath) && !relativePath.includes(".")) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(readFileSync(indexPath));
      return true;
    }

    return false;
  }

  response.writeHead(200, {
    "content-type": contentTypeFor(assetPath)
  });
  response.end(readFileSync(assetPath));
  return true;
}

function contentTypeFor(filePath: string): string {
  const extension = extname(filePath);

  if (extension === ".html") {
    return "text/html; charset=utf-8";
  }

  if (extension === ".css") {
    return "text/css; charset=utf-8";
  }

  if (extension === ".js") {
    return "text/javascript; charset=utf-8";
  }

  if (extension === ".json") {
    return "application/json; charset=utf-8";
  }

  if (extension === ".svg") {
    return "image/svg+xml";
  }

  return "application/octet-stream";
}

interface PlexMetadataResponse {
  MediaContainer?: {
    Metadata?: Array<{
      Media?: Array<{
        Part?: Array<{
          key?: string;
        }>;
      }>;
    }>;
  };
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}
