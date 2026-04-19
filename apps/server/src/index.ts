import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFileSync, readFileSync, existsSync, mkdirSync, readdirSync, statSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, extname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type {
  CatalogRecommendationResponse,
  CatalogMediaTypeFilter,
  CatalogMovieListResponse,
  CheckNewContentRequest,
  CheckNewContentResponse,
  ClientPlaybackState,
  CommandName,
  ExternalLiveTvState,
  LiveTvChannelsResponse,
  LiveTvProvider,
  LiveTvTuneRequest,
  LiveTvTuneResponse,
  MediaItemSummary,
  PlaybackDiagnostics,
  PlaybackDiagnosticsUpdateRequest,
  PlaybackSnapshot,
  VoiceConfig,
  VoiceTurnRequest,
  VoiceTurnResponse,
  PlaybackStateUpdateRequest,
  RecommendationStrategy,
  SyncMode,
  SyncStatusResponse,
  VoiceHealthResponse
} from "@clawtv/contracts";
import { DEFAULT_BASE_PATH, normalizeBasePath, withBasePath } from "@clawtv/core";
import { openClawTvDatabase } from "@clawtv/db";
import { syncPlexCatalog, triggerPlexLibraryScan, waitForPlexLibraryScan } from "@clawtv/plex-sync";

const rootDir = fileURLToPath(new URL("../../..", import.meta.url));
const serverDataDir = process.env.CLAWTV_DATA_DIR ?? join(rootDir, "data");
const voiceAssetDir = join(rootDir, "assets", "voice");
const voiceCacheDir = join(serverDataDir, "voice-cache");
const port = Number(process.env.PORT ?? 8787);
const basePath = normalizeBasePath(process.env.CLAWTV_BASE_PATH ?? DEFAULT_BASE_PATH) || DEFAULT_BASE_PATH;
const webDistDir = join(rootDir, "apps", "web", "dist");
const execFileAsync = promisify(execFile);
const runtimeStartedAt = new Date().toISOString();
const runtimeStdoutLogPath = normalizeRuntimeLogPath(process.env.CLAWTV_SERVER_STDOUT_LOG);
const runtimeStderrLogPath = normalizeRuntimeLogPath(process.env.CLAWTV_SERVER_STDERR_LOG);
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
let syncInFlight: Promise<{
  syncRun: CheckNewContentResponse["syncRun"];
  items: MediaItemSummary[];
}> | null = null;
let voiceHealthProbeCache: {
  result: VoiceHealthResponse;
  expiresAt: number;
} | null = null;
let voiceHealthProbeInFlight: Promise<VoiceHealthResponse> | null = null;
type LiveTvChannelDefinition = {
  key: string;
  label: string;
  aliases: string[];
  provider: LiveTvProvider;
  defaultUrl?: string;
};

type ResolvedLiveTvChannel = LiveTvChannelDefinition & {
  url: string | null;
};

const youTubeTvChannelCatalog = [
  {
    key: "abc",
    label: "ABC",
    aliases: ["abc", "abc local", "channel abc"],
    provider: "youtube-tv"
  },
  {
    key: "cnbc",
    label: "CNBC",
    aliases: ["cnbc"],
    provider: "youtube-tv",
    defaultUrl: "https://tv.youtube.com/watch/cw87fKrpKUc"
  },
  {
    key: "cnn",
    label: "CNN",
    aliases: ["cnn"],
    provider: "youtube-tv",
    defaultUrl: "https://tv.youtube.com/watch/TJSwwtXbvLw"
  },
  {
    key: "espn",
    label: "ESPN",
    aliases: ["espn"],
    provider: "youtube-tv",
    defaultUrl: "https://tv.youtube.com/watch/ferg3lVdMOg"
  },
  {
    key: "espn2",
    label: "ESPN2",
    aliases: ["espn2", "espn 2"],
    provider: "youtube-tv",
    defaultUrl: "https://tv.youtube.com/watch/qHoTWZ9M9gw"
  },
  {
    key: "espn-news",
    label: "ESPNews",
    aliases: ["espnews", "espn news", "espn now"],
    provider: "youtube-tv",
    defaultUrl: "https://tv.youtube.com/watch/ReMgHDtmz_w"
  },
  {
    key: "espnu",
    label: "ESPNU",
    aliases: ["espnu", "espn u"],
    provider: "youtube-tv",
    defaultUrl: "https://tv.youtube.com/watch/6x-T96Q-5eY"
  },
  {
    key: "fox",
    label: "FOX",
    aliases: ["fox", "fox local", "channel fox"],
    provider: "youtube-tv"
  },
  {
    key: "fox-business",
    label: "FOX Business",
    aliases: ["fox business", "foxbusiness", "fbn"],
    provider: "youtube-tv",
    defaultUrl: "https://tv.youtube.com/watch/dfo8tRrx8Yc"
  },
  {
    key: "fox-news",
    label: "FOX News",
    aliases: ["fox news", "foxnews", "fox news channel", "fnc"],
    provider: "youtube-tv",
    defaultUrl: "https://tv.youtube.com/watch/SBwjcDPe99c"
  },
  {
    key: "golf-channel",
    label: "Golf Channel",
    aliases: ["golf", "golf channel"],
    provider: "youtube-tv",
    defaultUrl: "https://tv.youtube.com/watch/ll39j_Jw-yM"
  },
  {
    key: "ms-now",
    label: "MS NOW",
    aliases: ["ms now", "msnow", "msnbc"],
    provider: "youtube-tv",
    defaultUrl: "https://tv.youtube.com/watch/FKRGbcbVW1I"
  },
  {
    key: "nbc",
    label: "NBC",
    aliases: ["nbc", "nbc local", "channel nbc"],
    provider: "youtube-tv"
  },
  {
    key: "pbs",
    label: "PBS",
    aliases: ["pbs", "arizona pbs", "arizonapbs", "pbs local"],
    provider: "youtube-tv"
  }
] as const satisfies readonly LiveTvChannelDefinition[];

function getLiveTvChannelDefaultUrl(channel: LiveTvChannelDefinition): string | null {
  return "defaultUrl" in channel && typeof channel.defaultUrl === "string"
    ? channel.defaultUrl
    : null;
}

type VoiceDecision = {
  ok: boolean;
  replyText: string;
  commandName: VoiceTurnResponse["action"];
  payload: Record<string, unknown>;
  expectsReply: boolean;
  rawReplyText?: string | null;
  executedAction?: {
    action: VoiceTurnResponse["action"];
    payload: Record<string, unknown>;
    ok: boolean;
    message: string;
    matchedItemCount?: number | null;
  } | null;
};

type AgentToolCall = {
  name: string;
  arguments?: Record<string, unknown>;
};

type AgentToolOutcome = {
  name: string;
  ok: boolean;
  arguments: Record<string, unknown>;
  result: unknown;
  executedAction?: NonNullable<VoiceDecision["executedAction"]>;
};

mkdirSync(voiceCacheDir, { recursive: true });

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
      basePath,
      runtimeStartedAt
    });
    return;
  }

  if (request.method === "GET" && routePath === "/api/health/runtime") {
    const probeMode = requestUrl.searchParams.get("probe");
    const activeProbe = probeMode !== "cached";
    const voiceConfig = await buildVoiceConfig();
    const voice = voiceConfig.enabled
      ? await probeVoiceAssistantHealth(voiceConfig, {
          force: activeProbe,
          cachedOnly: probeMode === "cached"
        })
      : {
          ok: false,
          assistantId: voiceConfig.assistantId,
          assistantName: voiceConfig.assistantName,
          checkedAt: new Date().toISOString(),
          durationMs: null,
          cached: false,
          error: "Voice is disabled."
        };

    sendJson(response, 200, {
      ok: voice.ok,
      service: "clawtv-server",
      basePath,
      runtimeStartedAt,
      playback: buildPlaybackSnapshot(),
      sync: buildSyncStatusResponse(),
      voice
    });
    return;
  }

  if (request.method === "GET" && routePath === "/api/status") {
    sendJson(response, 200, db.getStatus());
    return;
  }

  if (request.method === "GET" && routePath === "/api/voice/config") {
    sendJson(response, 200, await buildVoiceConfig());
    return;
  }

  if ((request.method === "GET" || request.method === "HEAD") && routePath.startsWith("/api/voice/audio/")) {
    const served = serveVoiceAudio(routePath, request.method === "HEAD", response);

    if (!served) {
      sendJson(response, 404, {
        ok: false,
        error: `No voice audio route for ${routePath}`
      });
    }
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

  if (
    (request.method === "GET" || request.method === "HEAD")
    && (routePath === "/api/playback/hls/proxy" || routePath.startsWith("/api/playback/hls/proxy."))
  ) {
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
      positionMs: nextPositionMs,
      currentItemId: typeof body.currentItemId === "string" ? body.currentItemId : body.currentItemId === null ? null : undefined
    });
    maybeClearExternalLiveTvState({
      sessionId: typeof body.sessionId === "string" ? body.sessionId : undefined,
      playbackState: nextState,
      currentItemId: typeof body.currentItemId === "string" ? body.currentItemId : body.currentItemId === null ? null : undefined
    });

    sendJson(response, 200, buildPlaybackSnapshot());
    return;
  }

  if (request.method === "POST" && routePath === "/api/voice/turn") {
    const body = (await readJsonBody(request)) as unknown as VoiceTurnRequest;
    const voiceConfig = await buildVoiceConfig();

    if (!voiceConfig.enabled) {
      sendJson(response, 503, {
        ok: false,
        error: "Voice is disabled on this ClawTV server.",
        config: voiceConfig
      });
      return;
    }

    sendJson(response, 200, await buildVoiceTurnResponse(body, voiceConfig));
    return;
  }

  if (request.method === "POST" && routePath === "/api/live-tv/tune") {
    const body = (await readJsonBody(request)) as unknown as Partial<LiveTvTuneRequest>;

    try {
      const result = await tuneLiveTv({
        provider: parseLiveTvProvider(body.provider),
        channel: typeof body.channel === "string" ? body.channel : ""
      });
      sendJson(response, 200, result);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to tune live TV.";
      sendJson(response, 500, {
        ok: false,
        provider: parseLiveTvProvider(body.provider),
        channel: typeof body.channel === "string" ? body.channel.trim().toLowerCase() : "",
        message,
        deviceSerial: process.env.CLAWTV_ANDROID_TV_ADB_SERIAL?.trim() || null,
        packageName: null,
        launchedUrl: null,
        clawTvPlaybackStopped: false
      } satisfies LiveTvTuneResponse);
      return;
    }
  }

  if (request.method === "GET" && routePath === "/api/live-tv/channels") {
    sendJson(response, 200, buildLiveTvChannelsResponse());
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
    const offset = parseCatalogOffset(requestUrl.searchParams.get("offset"));
    const startsWith = requestUrl.searchParams.get("startsWith");
    sendJson(response, 200, db.listShows({
      limit,
      offset,
      startsWith
    }));
    return;
  }

  if (request.method === "GET" && routePath === "/api/catalog/movies") {
    const limit = parseCatalogLimit(requestUrl.searchParams.get("limit"));
    const offset = parseCatalogOffset(requestUrl.searchParams.get("offset"));
    const startsWith = requestUrl.searchParams.get("startsWith");
    sendJson(response, 200, db.listMovies({
      limit,
      offset,
      startsWith
    }) satisfies CatalogMovieListResponse);
    return;
  }

  if (request.method === "GET" && routePath === "/api/catalog/collections") {
    const limit = parseCatalogLimit(requestUrl.searchParams.get("limit"));
    sendJson(response, 200, db.listCollections(limit));
    return;
  }

  if (request.method === "GET" && routePath === "/api/catalog/networks") {
    const limit = parseCatalogLimit(requestUrl.searchParams.get("limit"));
    sendJson(response, 200, db.listNetworks(limit));
    return;
  }

  if (request.method === "GET" && routePath === "/api/catalog/network-shows") {
    const network = requestUrl.searchParams.get("network") ?? "";
    const limit = parseCatalogLimit(requestUrl.searchParams.get("limit"));
    sendJson(response, 200, db.listNetworkShows(network, limit));
    return;
  }

  if (request.method === "GET" && routePath === "/api/catalog/recommendations/show") {
    const show = requestUrl.searchParams.get("show") ?? "";
    const limit = parseCatalogLimit(requestUrl.searchParams.get("limit"));
    const strategy = parseRecommendationStrategy(requestUrl.searchParams.get("strategy"));
    const unwatchedOnly = parseBooleanQuery(requestUrl.searchParams.get("unwatchedOnly"));

    sendJson(response, 200, db.recommendEpisodes({
      show,
      strategy,
      limit,
      unwatchedOnly
    } satisfies {
      show: string;
      strategy?: RecommendationStrategy;
      limit?: number;
      unwatchedOnly?: boolean;
    }));
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
    sendJson(response, 200, buildSyncStatusResponse());
    return;
  }

  if (request.method === "POST" && routePath === "/api/sync/plex") {
    const body = await readJsonBody(request);
    const mode = parseSyncMode(body.mode);
    const library = typeof body.library === "string" ? body.library : undefined;
    try {
      const { syncRun } = await runCatalogSync({
        plexBaseUrl,
        plexToken,
        mode,
        library
      });
      sendJson(response, 202, {
        ok: true,
        syncRun
      });
      return;
    } catch (error) {
      const syncRun = db.getLatestSyncRun();
      const message = error instanceof Error ? error.message : "Plex sync failed.";

      sendJson(response, 500, {
        ok: false,
        error: message,
        syncRun
      });
      return;
    }
  }

  if (request.method === "POST" && routePath === "/api/sync/check-new-content") {
    const body = (await readJsonBody(request)) as unknown as CheckNewContentRequest;
    const library = typeof body.library === "string" ? body.library : undefined;
    const limit = typeof body.limit === "number" && Number.isFinite(body.limit)
      ? Math.max(1, Math.min(25, Math.round(body.limit)))
      : 10;

    try {
      const result = await checkForNewContent({
        plexBaseUrl,
        plexToken,
        library,
        limit
      });

      sendJson(response, 202, result);
      return;
    } catch (error) {
      const syncRun = db.getLatestSyncRun();
      const message = error instanceof Error ? error.message : "Failed to check for new content.";

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
    maybeClearExternalLiveTvStateForCommand(commandName, result.ok);

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

trimRuntimeLogsIfNeeded();
setInterval(trimRuntimeLogsIfNeeded, resolveRuntimeLogTrimIntervalMs()).unref();
startAutomaticIncrementalSyncLoop();

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

async function runCatalogSync(input: {
  plexBaseUrl: string;
  plexToken?: string;
  mode: SyncMode;
  library?: string;
}): Promise<{
  syncRun: CheckNewContentResponse["syncRun"];
  items: MediaItemSummary[];
}> {
  if (syncInFlight) {
    return syncInFlight;
  }

  syncInFlight = (async () => {
    const startedAt = new Date().toISOString();
    let attemptedPayloadSummary: Record<string, unknown> | null = null;

    if (!input.plexToken) {
      const syncRun = db.recordFailedSyncRun({
        mode: input.mode,
        status: "failed",
        startedAt,
        librariesSynced: 0,
        mediaItemsSynced: 0,
        errorMessage: "PLEX_TOKEN is not configured on the server.",
        details: {
          library: input.library ?? null
        }
      });

      throw Object.assign(new Error("PLEX_TOKEN is not configured on the server."), { syncRun });
    }

    try {
      const lastSuccessfulSync = db.getLatestSuccessfulSyncRun();
      const payload = await syncPlexCatalog({
        baseUrl: input.plexBaseUrl,
        token: input.plexToken,
        mode: input.mode,
        library: input.library,
        lastSuccessfulSyncAt: lastSuccessfulSync?.finishedAt ?? null
      });
      attemptedPayloadSummary = summarizeCatalogSyncPayload(payload);
      const finishedAt = new Date().toISOString();
      const syncRun = db.applyCatalogSync(payload, {
        mode: input.mode,
        status: "success",
        startedAt,
        finishedAt,
        librariesSynced: payload.libraries.length,
        mediaItemsSynced: payload.mediaItems.length,
        details: {
          library: input.library ?? null,
          fallbackUsed: false
        }
      });

      return {
        syncRun,
        items: summarizeSyncedMediaItems(payload.mediaItems)
      };
    } catch (error) {
      if (input.mode === "incremental-sync" && isForeignKeyConstraintError(error)) {
        console.warn("Incremental ClawTV sync hit a foreign key constraint; retrying with a full sync.");

        try {
          const fallbackStartedAt = new Date().toISOString();
          const payload = await syncPlexCatalog({
            baseUrl: input.plexBaseUrl,
            token: input.plexToken,
            mode: "full-sync",
            library: input.library
          });
          const finishedAt = new Date().toISOString();
          const syncRun = db.applyCatalogSync(payload, {
            mode: "full-sync",
            status: "success",
            startedAt: fallbackStartedAt,
            finishedAt,
            librariesSynced: payload.libraries.length,
            mediaItemsSynced: payload.mediaItems.length,
            details: {
              library: input.library ?? null,
              fallbackUsed: true,
              fallbackReason: error.message,
              attemptedMode: input.mode,
              attemptedPayloadSummary
            }
          });

          return {
            syncRun,
            items: summarizeSyncedMediaItems(payload.mediaItems)
          };
        } catch (fallbackError) {
          error = fallbackError;
        }
      }

      const finishedAt = new Date().toISOString();
      const message = error instanceof Error ? error.message : "Plex sync failed.";
      const syncRun = db.recordFailedSyncRun({
        mode: input.mode,
        status: "failed",
        startedAt,
        finishedAt,
        librariesSynced: 0,
        mediaItemsSynced: 0,
        errorMessage: message,
        details: {
          library: input.library ?? null,
          attemptedMode: input.mode,
          attemptedPayloadSummary
        }
      });

      throw Object.assign(error instanceof Error ? error : new Error(message), { syncRun });
    } finally {
      syncInFlight = null;
    }
  })();

  return syncInFlight;
}

function buildSyncStatusResponse(): SyncStatusResponse {
  return {
    latestRun: db.getLatestSyncRun(),
    latestSuccessfulRun: db.getLatestSuccessfulSyncRun(),
    latestFailedRun: db.getLatestFailedSyncRun()
  };
}

function summarizeCatalogSyncPayload(payload: {
  libraries: Array<{ id: string }>;
  mediaItems: Array<{ id: string; mediaType: string; libraryId: string }>;
  collections: Array<{ id: string }>;
  tags: Array<{ mediaItemId: string }>;
}): Record<string, unknown> {
  return {
    libraries: payload.libraries.length,
    mediaItems: payload.mediaItems.length,
    collections: payload.collections.length,
    tags: payload.tags.length,
    sampleMediaItemIds: payload.mediaItems.slice(0, 12).map((item) => item.id),
    sampleCollectionIds: payload.collections.slice(0, 8).map((collection) => collection.id),
    sampleLibraryIds: payload.libraries.slice(0, 8).map((library) => library.id)
  };
}

function maybeClearExternalLiveTvState(input: {
  sessionId?: string | null;
  playbackState?: ClientPlaybackState;
  currentItemId?: string | null;
}): void {
  const shouldClear = input.currentItemId !== undefined
    ? Boolean(input.currentItemId)
    : input.playbackState === "loading" || input.playbackState === "playing";

  if (!shouldClear) {
    return;
  }

  db.clearExternalLiveTvState(input.sessionId);
}

function maybeClearExternalLiveTvStateForCommand(commandName: CommandName, commandOk: boolean): void {
  if (!commandOk) {
    return;
  }

  if (commandName === "play" || commandName === "play-latest" || commandName === "shuffle" || commandName === "resume") {
    db.clearExternalLiveTvState();
  }
}

async function probeVoiceAssistantHealth(
  voiceConfig: VoiceConfig,
  input?: {
    force?: boolean;
    cachedOnly?: boolean;
  }
): Promise<VoiceHealthResponse> {
  if (!input?.force && voiceHealthProbeCache && voiceHealthProbeCache.expiresAt > Date.now()) {
    return {
      ...voiceHealthProbeCache.result,
      cached: true
    };
  }

  if (input?.cachedOnly) {
    return {
      ok: false,
      assistantId: voiceConfig.assistantId,
      assistantName: voiceConfig.assistantName,
      checkedAt: new Date().toISOString(),
      durationMs: null,
      cached: true,
      error: "No cached voice probe is available yet."
    };
  }

  if (voiceHealthProbeInFlight) {
    return voiceHealthProbeInFlight;
  }

  const startedAt = Date.now();
  voiceHealthProbeInFlight = (async () => {
    const rawText = await runOpenClawJsonPrompt({
      prompt: "Return JSON only. {\"replyText\":\"ok\",\"expectsReply\":false,\"action\":\"none\",\"payload\":{},\"ok\":true}",
      agentId: voiceConfig.assistantId,
      timeoutSeconds: 20,
      thinking: "low",
      sessionKey: makeOpenClawEphemeralSessionKey(voiceConfig.assistantId, "clawtv-voice-health")
    });
    const durationMs = Date.now() - startedAt;
    const result: VoiceHealthResponse = rawText
      ? {
          ok: true,
          assistantId: voiceConfig.assistantId,
          assistantName: voiceConfig.assistantName,
          checkedAt: new Date().toISOString(),
          durationMs,
          cached: false,
          error: null
        }
      : {
          ok: false,
          assistantId: voiceConfig.assistantId,
          assistantName: voiceConfig.assistantName,
          checkedAt: new Date().toISOString(),
          durationMs,
          cached: false,
          error: "OpenClaw did not return a health-check reply."
        };

    voiceHealthProbeCache = {
      result,
      expiresAt: Date.now() + 30_000
    };
    voiceHealthProbeInFlight = null;
    return result;
  })();

  return voiceHealthProbeInFlight;
}

function isForeignKeyConstraintError(error: unknown): error is Error {
  return error instanceof Error && /FOREIGN KEY constraint failed/iu.test(error.message);
}

async function checkForNewContent(input: {
  plexBaseUrl: string;
  plexToken?: string;
  library?: string;
  limit: number;
}): Promise<CheckNewContentResponse> {
  if (!input.plexToken) {
    const startedAt = new Date().toISOString();
    const syncRun = db.recordFailedSyncRun({
      mode: "incremental-sync",
      status: "failed",
      startedAt,
      librariesSynced: 0,
      mediaItemsSynced: 0,
      errorMessage: "PLEX_TOKEN is not configured on the server."
    });

    throw Object.assign(new Error("PLEX_TOKEN is not configured on the server."), { syncRun });
  }

  await triggerPlexLibraryScan({
    baseUrl: input.plexBaseUrl,
    token: input.plexToken,
    mode: "incremental-sync",
    library: input.library
  });
  await waitForPlexLibraryScan({
    baseUrl: input.plexBaseUrl,
    token: input.plexToken,
    mode: "incremental-sync",
    library: input.library
  }, {
    timeoutMs: resolveContentRefreshWaitTimeoutMs()
  });

  const { syncRun, items } = await runCatalogSync({
    plexBaseUrl: input.plexBaseUrl,
    plexToken: input.plexToken,
    mode: "incremental-sync",
    library: input.library
  });

  return {
    ok: true,
    scanTriggered: true,
    library: input.library ?? null,
    syncRun,
    items: items.slice(0, input.limit)
  };
}

function summarizeSyncedMediaItems(items: Array<{
  id: string;
  title: string;
  mediaType: "show" | "season" | "episode" | "movie";
  showId: string | null;
  year: number | null;
  addedAt: string | null;
  originallyAvailableAt: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  viewCount: number | null;
  lastViewedAt: string | null;
  viewOffsetMs: number | null;
  userRating: number | null;
  audienceRating: number | null;
  criticRating: number | null;
}>): MediaItemSummary[] {
  const showTitlesById = new Map(
    items
      .filter((item) => item.mediaType === "show")
      .map((item) => [item.id, item.title] as const)
  );

  return items
    .filter((item) => item.mediaType === "movie" || item.mediaType === "episode")
    .sort((left, right) => {
      const leftDate = Date.parse(left.addedAt ?? left.originallyAvailableAt ?? "") || 0;
      const rightDate = Date.parse(right.addedAt ?? right.originallyAvailableAt ?? "") || 0;

      if (leftDate !== rightDate) {
        return rightDate - leftDate;
      }

      return left.title.localeCompare(right.title);
    })
    .map((item) => ({
      id: item.id,
      title: item.title,
      mediaType: item.mediaType,
      showTitle: item.showId ? showTitlesById.get(item.showId) ?? null : null,
      year: item.year,
      originallyAvailableAt: item.originallyAvailableAt,
      seasonNumber: item.seasonNumber,
      episodeNumber: item.episodeNumber,
      viewCount: item.viewCount,
      lastViewedAt: item.lastViewedAt,
      viewOffsetMs: item.viewOffsetMs,
      userRating: item.userRating,
      audienceRating: item.audienceRating,
      criticRating: item.criticRating
    }));
}

function resolveAutomaticSyncIntervalMs(): number {
  const raw = process.env.CLAWTV_PLEX_SYNC_INTERVAL_MINUTES?.trim();

  if (!raw) {
    return 15 * 60 * 1000;
  }

  const parsed = Number(raw);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }

  return Math.round(parsed * 60 * 1000);
}

function resolveContentRefreshWaitTimeoutMs(): number {
  const raw = process.env.CLAWTV_PLEX_REFRESH_TIMEOUT_SECONDS?.trim();
  const parsed = raw ? Number(raw) : 60;

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 60_000;
  }

  return Math.round(parsed * 1000);
}

function startAutomaticIncrementalSyncLoop(): void {
  const intervalMs = resolveAutomaticSyncIntervalMs();
  const plexToken = process.env.PLEX_TOKEN;
  const plexBaseUrl = process.env.PLEX_BASE_URL ?? "http://127.0.0.1:32400";

  if (!plexToken || intervalMs <= 0) {
    return;
  }

  const run = async (): Promise<void> => {
    try {
      await runCatalogSync({
        plexBaseUrl,
        plexToken,
        mode: "incremental-sync"
      });
    } catch (error) {
      console.warn("Automatic ClawTV incremental sync failed:", error instanceof Error ? error.message : error);
    }
  };

  if (!db.getLatestSuccessfulSyncRun()) {
    void run();
  }

  setInterval(() => {
    void run();
  }, intervalMs).unref();
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

function parseCatalogOffset(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed) || parsed < 0) {
    return undefined;
  }

  return parsed;
}

function parseRecommendationStrategy(value: string | null): RecommendationStrategy | undefined {
  return value === "default" || value === "random" || value === "highly-rated"
    ? value
    : undefined;
}

function parseBooleanQuery(value: string | null): boolean | undefined {
  if (value === null) {
    return undefined;
  }

  return value === "1" || value === "true" || value === "yes";
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
  if (response.destroyed || response.writableEnded) {
    return;
  }

  if (response.headersSent) {
    response.end();
    return;
  }

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
  const externalLiveTv = snapshot.sessionId ? db.getExternalLiveTvState(snapshot.sessionId) : null;

  if (activeHlsSession && snapshot.currentItem?.id !== activeHlsSession.mediaItemId) {
    activeHlsSession = null;
  }

  if (!snapshot.currentItem) {
    return {
      ...snapshot,
      externalLiveTv,
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
    externalLiveTv,
    streamPath: snapshot.currentItem ? withBasePath(basePath, "/api/playback/hls/current.m3u8") : null,
    diagnostics: latestPlaybackDiagnostics
  };
}

function parseLiveTvProvider(value: unknown): LiveTvProvider {
  return value === "youtube-tv" ? value : "youtube-tv";
}

function normalizeLiveTvChannelKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

function resolveYouTubeTvChannelConfig(): Record<string, ResolvedLiveTvChannel> {
  const raw = process.env.CLAWTV_YOUTUBE_TV_CHANNEL_URLS_JSON?.trim();
  const defaults = Object.fromEntries(
    youTubeTvChannelCatalog.map((channel) => [
      channel.key,
      {
        ...channel,
        url: getLiveTvChannelDefaultUrl(channel)
      }
    ])
  ) as Record<string, ResolvedLiveTvChannel>;

  if (!raw) {
    return defaults;
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const channels = { ...defaults };

    for (const [channelName, url] of Object.entries(parsed)) {
      if (typeof url !== "string" || url.trim().length === 0) {
        continue;
      }

      const channelKey = normalizeLiveTvChannelKey(channelName);
      const existing = channels[channelKey];
      channels[channelKey] = existing
        ? {
          ...existing,
          url: url.trim()
        }
        : {
          key: channelKey,
          label: channelName.trim(),
          aliases: [channelName.trim()],
          provider: "youtube-tv",
          url: url.trim()
        };
    }

    return channels;
  } catch {
    throw new Error("CLAWTV_YOUTUBE_TV_CHANNEL_URLS_JSON is not valid JSON.");
  }
}

function resolveLiveTvChannelByName(channelName: string): ResolvedLiveTvChannel | null {
  const channels = resolveYouTubeTvChannelConfig();
  const normalizedInput = normalizeLiveTvChannelKey(channelName);

  if (channels[normalizedInput]) {
    return channels[normalizedInput];
  }

  for (const channel of Object.values(channels)) {
    if (channel.aliases.some((alias) => normalizeLiveTvChannelKey(alias) === normalizedInput)) {
      return channel;
    }
  }

  return null;
}

function buildLiveTvChannelsResponse(): LiveTvChannelsResponse {
  return {
    provider: "youtube-tv",
    channels: Object.values(resolveYouTubeTvChannelConfig())
      .sort((left, right) => left.label.localeCompare(right.label))
      .map((channel) => ({
        key: channel.key,
        label: channel.label,
        aliases: channel.aliases,
        provider: channel.provider,
        urlConfigured: Boolean(channel.url)
      }))
  };
}

function describeLiveTvChannelsForPrompt(): string {
  const configuredChannels = buildLiveTvChannelsResponse().channels
    .filter((channel) => channel.urlConfigured)
    .sort((left, right) => left.label.localeCompare(right.label))
    .map((channel) => {
      const aliasSummary = channel.aliases.slice(0, 4).join(", ");
      return `${channel.label} [key ${channel.key}; aliases: ${aliasSummary}]`;
    });

  return configuredChannels.length > 0
    ? configuredChannels.join(" | ")
    : "No live TV channels are configured right now.";
}

function describeLastLiveTvTuneForPrompt(): string {
  const liveTvState = db.getExternalLiveTvState();

  if (!liveTvState) {
    return "No live TV channel has been tuned by ClawTV since this server started.";
  }

  return `${liveTvState.channelLabel} via ${liveTvState.provider} at ${liveTvState.tunedAt}. Active: ${liveTvState.isActive ? "yes" : "no"}.`;
}

async function tuneLiveTv(input: LiveTvTuneRequest): Promise<LiveTvTuneResponse> {
  if (!input.channel.trim()) {
    throw new Error("A live TV channel name is required.");
  }

  const deviceSerial = process.env.CLAWTV_ANDROID_TV_ADB_SERIAL?.trim();
  if (!deviceSerial) {
    throw new Error("CLAWTV_ANDROID_TV_ADB_SERIAL is not configured on the server.");
  }

  const packageName = process.env.CLAWTV_YOUTUBE_TV_PACKAGE?.trim() || "com.google.android.youtube.tvunplugged";
  const channel = resolveLiveTvChannelByName(input.channel);

  if (!channel || !channel.url) {
    throw new Error(`No ${input.provider} URL is configured for channel "${input.channel}".`);
  }

  const shouldConnect = parseBooleanEnv(process.env.CLAWTV_ANDROID_TV_ADB_CONNECT, true);
  const adbPath = process.env.CLAWTV_ANDROID_TV_ADB_PATH?.trim() || "adb";
  let clawTvPlaybackStopped = false;

  if (buildPlaybackSnapshot().sessionId) {
    const stopResult = db.applyCommand({
      commandName: "stop",
      payload: {},
      source: "cli"
    });
    clawTvPlaybackStopped = stopResult.ok;
  }

  await launchLiveTvIntent({
    adbPath,
    deviceSerial,
    channelUrl: channel.url,
    packageName,
    shouldConnect
  });

  const tunedAt = new Date().toISOString();
  const sessionId = buildPlaybackSnapshot().sessionId ?? process.env.CLAWTV_DEFAULT_SESSION_ID?.trim() ?? "primary-tv";
  db.setExternalLiveTvState({
    sessionId,
    provider: input.provider,
    channelKey: channel.key,
    channelLabel: channel.label,
    launchedUrl: channel.url,
    tunedAt,
    packageName,
    deviceSerial,
    isActive: true
  });

  return {
    ok: true,
    provider: input.provider,
    channel: channel.key,
    message: `Opened ${channel.label} in ${input.provider}.`,
    deviceSerial,
    packageName,
    launchedUrl: channel.url,
    clawTvPlaybackStopped
  };
}

async function prepareAdbDevice(adbPath: string, deviceSerial: string): Promise<void> {
  await runAdbCommandBestEffort(adbPath, ["kill-server"]);
  await runAdbCommand(adbPath, ["start-server"]);
  await runAdbCommandBestEffort(adbPath, ["disconnect", deviceSerial]);
  await runAdbCommand(adbPath, ["connect", deviceSerial]);
  await delay(750);
}

async function launchLiveTvIntent(input: {
  adbPath: string;
  deviceSerial: string;
  channelUrl: string;
  packageName: string;
  shouldConnect: boolean;
}): Promise<void> {
  const launchArgs = [
    "-s",
    input.deviceSerial,
    "shell",
    "am",
    "start",
    "-a",
    "android.intent.action.VIEW",
    "-d",
    input.channelUrl,
    input.packageName
  ];

  try {
    await runAdbCommand(input.adbPath, launchArgs);
  } catch (error) {
    const message = error instanceof Error ? error.message : "ADB launch failed.";
    const retryable = /device offline|device '.*' not found|cannot connect to daemon|adb server didn't ack/iu.test(message);

    if (!retryable) {
      throw error;
    }

    if (input.shouldConnect) {
      await prepareAdbDevice(input.adbPath, input.deviceSerial);
    }

    await runAdbCommand(input.adbPath, launchArgs);
  }
}

async function runAdbCommand(adbPath: string, args: string[]): Promise<void> {
  try {
    await execFileAsync(adbPath, args);
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : "ADB command failed.";
    throw new Error(`${message} Command: ${adbPath} ${args.join(" ")}`);
  }
}

async function runAdbCommandBestEffort(adbPath: string, args: string[]): Promise<void> {
  try {
    await execFileAsync(adbPath, args);
  } catch {
    // Best-effort cleanup commands should not block recovery.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}

async function buildVoiceConfig(): Promise<VoiceConfig> {
  const backend = resolveVoiceBackend();
  const replyMode = resolveVoiceReplyMode();
  // Wake-up speech is intentionally disabled so press-and-hold enters listening immediately.
  const greetingText = "";
  const processingText = pickCueLine("processing", process.env.CLAWTV_VOICE_PROCESSING_TEXT?.trim() || "Looking into it.");
  const acknowledgementText = pickCueLine("acknowledgement", process.env.CLAWTV_VOICE_ACKNOWLEDGEMENT_TEXT?.trim() || "Got it.");
  const unavailableText = pickCueLine("unavailable", process.env.CLAWTV_VOICE_UNAVAILABLE_TEXT?.trim() || "Voice chat is not available right now.");

  return {
    enabled: parseBooleanEnv(process.env.CLAWTV_VOICE_ENABLED, true),
    backend,
    assistantId: process.env.CLAWTV_VOICE_ASSISTANT_ID?.trim()
      || process.env.CLAWTV_OPENCLAW_AGENT_ID?.trim()
      || "main",
    assistantName: process.env.CLAWTV_VOICE_ASSISTANT_NAME?.trim() || "Assistant",
    greetingText,
    processingText,
    acknowledgementText,
    unavailableText,
    greetingAudioUrl: null,
    processingAudioUrl: await resolveVoiceCueUrl("processing", processingText),
    acknowledgementAudioUrl: await resolveVoiceCueUrl("acknowledgement", acknowledgementText),
    unavailableAudioUrl: await resolveVoiceCueUrl("unavailable", unavailableText),
    sttMode: "shield",
    replyMode
  };
}

async function buildVoiceTurnResponse(body: VoiceTurnRequest, voiceConfig: VoiceConfig): Promise<VoiceTurnResponse> {
  const transcript = typeof body.transcript === "string" ? body.transcript.trim() : "";
  const playbackBefore = buildPlaybackSnapshot();
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : playbackBefore.sessionId;
  const shouldResumeOriginalPlayback = body.playbackState === "playing" || body.playbackState === "loading";
  let action: VoiceTurnResponse["action"] = "none";
  let replyText = "";
  let expectsReply = false;
  let ok = true;
  let rawDecision: {
    replyText: string;
    commandName: VoiceTurnResponse["action"];
    payload: Record<string, unknown>;
    expectsReply: boolean;
    rawReplyText?: string | null;
  } | null = null;
  let finalPayload: Record<string, unknown> = {};
  let commandOk: boolean | null = null;
  let commandMessage: string | null = null;
  let matchedItemCount: number | null = null;

  if (!transcript) {
    replyText = "I didn't catch that. Please try again.";
  } else {
    const decision = await buildConversationalReply({
      transcript,
      playback: playbackBefore,
      voiceConfig,
      sessionId
    });

    replyText = decision.replyText;
    expectsReply = decision.expectsReply;
    ok = decision.ok;
    rawDecision = decision;

    if (decision.executedAction) {
      action = decision.executedAction.action;
      finalPayload = decision.executedAction.payload;
      commandOk = decision.executedAction.ok;
      commandMessage = decision.executedAction.message;
      matchedItemCount = decision.executedAction.matchedItemCount ?? null;

      if (!replyText.trim()) {
        replyText = decision.executedAction.message;
      }
    } else if (decision.commandName !== "none") {
      action = decision.commandName;
      finalPayload = decision.payload;
      commandOk = decision.ok;
      commandMessage = replyText.trim() || null;
      matchedItemCount = null;

      if (!replyText.trim()) {
        replyText = decision.ok
          ? "Done."
          : voiceConfig.unavailableText;
      }
    }
  }

  const playbackAfter = buildPlaybackSnapshot();
  const replyAudioUrl = await synthesizeVoiceReplyAudio(replyText);
  const replyMode = replyAudioUrl ? "server-audio" : voiceConfig.replyMode;
  db.recordVoiceTurn({
    sessionId: sessionId ?? playbackAfter.sessionId,
    transcript,
    rawReplyText: rawDecision?.rawReplyText ?? rawDecision?.replyText ?? null,
    rawCommandName: rawDecision?.commandName ?? null,
    rawPayload: rawDecision?.payload ?? null,
    rawExpectsReply: rawDecision?.expectsReply ?? null,
    finalReplyText: replyText,
    finalCommandName: action,
    finalPayload,
    commandOk,
    commandMessage,
    matchedItemCount
  });

  return {
    ok,
    enabled: voiceConfig.enabled,
    backend: voiceConfig.backend,
    assistantId: voiceConfig.assistantId,
    assistantName: voiceConfig.assistantName,
    transcript,
    greetingText: voiceConfig.greetingText,
    replyText,
    acknowledgementText: voiceConfig.acknowledgementText,
    processingText: voiceConfig.processingText,
    unavailableText: voiceConfig.unavailableText,
    greetingAudioUrl: voiceConfig.greetingAudioUrl,
    processingAudioUrl: voiceConfig.processingAudioUrl,
    acknowledgementAudioUrl: voiceConfig.acknowledgementAudioUrl,
    unavailableAudioUrl: voiceConfig.unavailableAudioUrl,
    replyAudioUrl,
    sttMode: voiceConfig.sttMode,
    replyMode,
    expectsReply,
    resumePlayback: !expectsReply && action === "none" && shouldResumeOriginalPlayback,
    action,
    playback: playbackAfter
  };
}

async function buildConversationalReply(input: {
  transcript: string;
  playback: PlaybackSnapshot & { diagnostics?: PlaybackDiagnostics | null };
  voiceConfig: VoiceConfig;
  sessionId?: string | null;
}): Promise<VoiceDecision> {
  if (input.voiceConfig.backend === "openclaw") {
    const openClawReply = await runOpenClawVoiceTurn({
      ...input
    });
    if (openClawReply) {
      return openClawReply;
    }

    return {
      ok: false,
      replyText: input.voiceConfig.unavailableText,
      commandName: "none",
      payload: {},
      expectsReply: false
    };
  }

  return {
    ok: false,
    replyText: `I heard: "${input.transcript}". The live assistant handoff is not available right now, but the voice turn plumbing is ready.`,
    commandName: "none",
    payload: {},
    expectsReply: false
  };
}

function maybeBuildCuratorVoiceDecision(transcript: string): {
  replyText: string;
  commandName: VoiceTurnResponse["action"];
  payload: Record<string, unknown>;
  expectsReply: boolean;
} | null {
  const normalized = transcript.toLowerCase().trim();
  const randomShow = extractShowRequest(normalized, [
    /(?:play|watch|put on)\s+(?:a\s+)?random episode of\s+(.+)/u
  ]);

  if (randomShow) {
    const recommendation = db.recommendEpisodes({
      show: randomShow,
      strategy: "random",
      limit: 1
    });
    const topPick = recommendation.items[0];

    if (!topPick) {
      return null;
    }

    return {
      replyText: `Let's do ${formatRecommendationTitle(topPick)}. ${topPick.reason}`,
      commandName: "play",
      payload: {
        mediaItemId: topPick.item.id,
        title: topPick.item.title
      },
      expectsReply: false
    };
  }

  const highlyRatedShow = extractShowRequest(normalized, [
    /shuffle\s+highly rated episodes of\s+(.+)/u,
    /play\s+highly rated episodes of\s+(.+)/u
  ]);

  if (highlyRatedShow) {
    const canonicalShow = db.recommendEpisodes({
      show: highlyRatedShow,
      strategy: "highly-rated",
      limit: 1
    }).show || highlyRatedShow;

    if (normalized.includes("shuffle")) {
      return {
        replyText: `Okay. Shuffling strong episodes from ${canonicalShow}.`,
        commandName: "shuffle",
        payload: {
          show: canonicalShow,
          highlyRated: true,
          limit: 12
        },
        expectsReply: false
      };
    }

    const recommendation = db.recommendEpisodes({
      show: highlyRatedShow,
      strategy: "highly-rated",
      limit: 1
    });
    const topPick = recommendation.items[0];
    if (!topPick) {
      return null;
    }

    return {
      replyText: `Let's go with ${formatRecommendationTitle(topPick)}. ${topPick.reason}`,
      commandName: "play",
      payload: {
        mediaItemId: topPick.item.id,
        title: topPick.item.title
      },
      expectsReply: false
    };
  }

  const shuffleShow = extractShowRequest(normalized, [
    /shuffle\s+episodes of\s+(.+)/u,
    /shuffle\s+(.+?)\s+episodes/u,
    /shuffle\s+(.+)/u
  ]);

  if (shuffleShow) {
    const canonicalShow = db.recommendEpisodes({
      show: shuffleShow,
      strategy: "default",
      limit: 1
    }).show || shuffleShow;

    return {
      replyText: `Okay. Shuffling ${canonicalShow}.`,
      commandName: "shuffle",
      payload: {
        show: canonicalShow,
        limit: 12
      },
      expectsReply: false
    };
  }

  return null;
}

function extractCuratorConversationIntent(transcript: string): {
  show: string;
  strategy: RecommendationStrategy;
  promptStyle: "broad" | "recommendation" | "best-of";
} | null {
  const normalized = transcript.toLowerCase().trim();
  const broadShow = extractShowRequest(normalized, [
    /let'?s watch some\s+(.+)/u,
    /play some\s+(.+)/u,
    /watch some\s+(.+)/u
  ]);

  if (broadShow) {
    return {
      show: broadShow,
      strategy: "default",
      promptStyle: "broad"
    };
  }

  const recommendationShow = extractShowRequest(normalized, [
    /what(?:'s|s| is)\s+(?:a\s+)?good episode of\s+(.+)/u,
    /recommend(?:\s+an?)?\s+episode of\s+(.+)/u,
    /suggest(?:\s+an?)?\s+episode of\s+(.+)/u,
    /suggest(?:\s+an?)?\s+(.+?)\s+episode/u,
    /recommend(?:\s+an?)?\s+(.+?)\s+episode/u,
    /what(?:'s|s| is)\s+(?:a\s+)?good\s+(.+?)\s+episode/u
  ]);

  if (recommendationShow) {
    return {
      show: recommendationShow,
      strategy: "default",
      promptStyle: "recommendation"
    };
  }

  const bestOfShow = extractShowRequest(normalized, [
    /best episodes of\s+(.+)/u,
    /best\s+(.+?)\s+episodes/u
  ]);

  if (bestOfShow) {
    return {
      show: bestOfShow,
      strategy: "highly-rated",
      promptStyle: "best-of"
    };
  }

  return null;
}

function extractShowRequest(transcript: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = transcript.match(pattern);
    const rawShow = match?.[1]?.trim().replace(/[?.!,]+$/u, "");
    if (rawShow) {
      return rawShow;
    }
  }

  return null;
}

function formatRecommendationTitle(input: CatalogRecommendationResponse["items"][number]): string {
  const episodeLabel = formatEpisodeLabel(input.item.seasonNumber ?? null, input.item.episodeNumber ?? null);
  const parts = [
    input.item.showTitle,
    episodeLabel,
    input.item.title
  ].filter((value): value is string => Boolean(value));

  return parts.join(" - ");
}

async function buildCuratorConversationReply(input: {
  transcript: string;
  playback: PlaybackSnapshot & { diagnostics?: PlaybackDiagnostics | null };
  voiceConfig: VoiceConfig;
  intent: {
    show: string;
    strategy: RecommendationStrategy;
    promptStyle: "broad" | "recommendation" | "best-of";
  };
}): Promise<{
  ok: boolean;
  replyText: string;
  commandName: VoiceTurnResponse["action"];
  payload: Record<string, unknown>;
  expectsReply: boolean;
} | null> {
  const recommendation = db.recommendEpisodes({
    show: input.intent.show,
    strategy: input.intent.strategy,
    limit: 5
  });

  if (recommendation.items.length === 0) {
    return null;
  }

  if (input.voiceConfig.backend === "openclaw") {
    const openClawReply = await runOpenClawVoiceTurn({
      transcript: input.transcript,
      playback: input.playback,
      voiceConfig: input.voiceConfig,
      curatorIntent: input.intent,
      recommendation
    });

    if (openClawReply) {
      return openClawReply;
    }
  }

  const picks = recommendation.items
    .slice(0, 3)
    .map((entry) => formatRecommendationTitle(entry))
    .join(", ");

  const followUp = input.intent.promptStyle === "best-of"
    ? "I can go with one of those, or I can narrow it by vibe. Want something cozy, chaotic, or all-timer?"
    : "I can narrow it by vibe if you want. Want something cozy, chaotic, or all-timer?";

  return {
    ok: true,
    replyText: `A few good ${recommendation.show} picks: ${picks}. ${followUp}`,
    commandName: "none",
    payload: {},
    expectsReply: true
  };
}

async function runOpenClawVoiceTurn(input: {
  transcript: string;
  playback: PlaybackSnapshot & { diagnostics?: PlaybackDiagnostics | null };
  voiceConfig: VoiceConfig;
  sessionId?: string | null;
  networkContext?: ReturnType<typeof db.findNetworkContextForTranscript>;
  curatorIntent?: {
    show: string;
    strategy: RecommendationStrategy;
    promptStyle: "broad" | "recommendation" | "best-of";
  };
  recommendation?: CatalogRecommendationResponse;
}): Promise<{
  ok: boolean;
  replyText: string;
  commandName: VoiceTurnResponse["action"];
  payload: Record<string, unknown>;
  expectsReply: boolean;
  rawReplyText?: string | null;
  executedAction?: VoiceDecision["executedAction"];
} | null> {
  const recentTurns = db.listRecentVoiceTurns(2, input.sessionId ?? input.playback.sessionId ?? null);
  const prompt = buildOpenClawPrompt({
    ...input,
    recentTurns
  });
  const conversationScope = input.sessionId ?? input.playback.sessionId ?? null;
  const rawText = await runOpenClawJsonPrompt({
    prompt,
    agentId: input.voiceConfig.assistantId,
    timeoutSeconds: Number(process.env.CLAWTV_OPENCLAW_TIMEOUT_SECONDS ?? 90),
    thinking: getOpenClawThinking(),
    sessionKey: makeOpenClawEphemeralSessionKey(input.voiceConfig.assistantId, "clawtv-voice", conversationScope)
  });

  if (rawText) {
    const parsed = extractOpenClawReplyFromRawText(rawText);
    if (parsed) {
      return parsed;
    }
  }

  const fallbackRawText = await runOpenClawPlainPrompt({
    prompt: buildOpenClawFinalOnlyPrompt({
      ...input,
      recentTurns
    }),
    agentId: input.voiceConfig.assistantId,
    timeoutSeconds: Number(process.env.CLAWTV_OPENCLAW_TIMEOUT_SECONDS ?? 90),
    thinking: getOpenClawThinking(),
    sessionKey: makeOpenClawEphemeralSessionKey(input.voiceConfig.assistantId, "clawtv-voice-fallback", conversationScope)
  });
  const finalFallback = fallbackRawText ? extractOpenClawReplyFromRawText(fallbackRawText) : null;
  return finalFallback ?? null;
}

function buildOpenClawPrompt(input: {
  transcript: string;
  playback: PlaybackSnapshot & { diagnostics?: PlaybackDiagnostics | null };
  voiceConfig: VoiceConfig;
  sessionId?: string | null;
  curatorIntent?: {
    show: string;
    strategy: RecommendationStrategy;
    promptStyle: "broad" | "recommendation" | "best-of";
  };
  recommendation?: CatalogRecommendationResponse;
  recentTurns: ReturnType<typeof db.listRecentVoiceTurns>;
}): string {
  const playbackSummary = describePlaybackContextForPrompt(input.playback);
  const externalLiveTvSummary = describeExternalLiveTvStateForPrompt(input.playback.externalLiveTv);
  const recentTurnsSummary = describeRecentVoiceTurnsForPrompt(input.recentTurns);

  return [
    `You are ${input.voiceConfig.assistantName}, the voice assistant for ClawTV on a television.`,
    "Return JSON only.",
    "Schema: {\"replyText\":\"string\",\"expectsReply\":boolean,\"action\":\"none|play|play-latest|shuffle|pause|resume|next|stop|live-tv-tune\",\"payload\":{},\"ok\":boolean}",
    "Keep replyText warm, concise, and human.",
    "Use the supplied Playback and Live TV state directly when it already answers the user.",
    "External live TV state is handoff memory, not live observation. Never say the user is definitely still on that channel or that you are watching it with them.",
    "Use clawtv-control for authoritative ClawTV facts or actions. Never call clawtv-control voice-turn from inside this handoff.",
    "If you change playback or retune live TV, do it through clawtv-control before replying and set action to what you completed.",
    "If you only answered a question, set action to none.",
    "If the request is ambiguous, ask one short follow-up question and set expectsReply to true.",
    "If external live TV is active, do not claim you can pause, resume, seek, or skip inside the YouTube TV app. Retuning is okay.",
    `Current playback context: ${playbackSummary}`,
    `Current external live TV state: ${externalLiveTvSummary}`,
    `Last ClawTV-tuned live TV state: ${describeLastLiveTvTuneForPrompt()}`,
    input.curatorIntent && input.recommendation
      ? `Recommendation context for ${input.curatorIntent.show}: ${describeRecommendationContextForPrompt(input.recommendation)}`
      : null,
    recentTurnsSummary === "none" ? null : `Recent conversation context: ${recentTurnsSummary}`,
    `User said: ${input.transcript}`
  ].filter((value): value is string => Boolean(value)).join(" ");
}

function describeRecommendationContextForPrompt(input: CatalogRecommendationResponse): string {
  return input.items
    .slice(0, 5)
    .map((entry) => {
      const rating = entry.item.userRating ?? entry.item.audienceRating ?? entry.item.criticRating;
      const watchState = (entry.item.viewCount ?? 0) > 0
        ? `watched ${entry.item.viewCount} time(s)`
        : "unwatched";
      const lastViewed = entry.item.lastViewedAt ? `last viewed ${entry.item.lastViewedAt}` : "not recently viewed";
      const ratingText = typeof rating === "number" && rating > 0 ? `rating ${formatRating(rating)}` : "no rating";
      return `${formatRecommendationTitle(entry)} [${watchState}; ${lastViewed}; ${ratingText}] because ${entry.reason}`;
    })
    .join(" | ");
}

function describeNetworkContextForPrompt(input: NonNullable<ReturnType<typeof db.findNetworkContextForTranscript>>): string {
  return input.shows
    .map((show) => {
      const latest = show.latestAirDate ? `latest ${show.latestAirDate}` : "latest date unknown";
      return `${show.title} (${show.episodeCount} episode${show.episodeCount === 1 ? "" : "s"}, ${latest})`;
    })
    .join(" | ");
}

function describePlaybackContextForPrompt(snapshot: PlaybackSnapshot): string {
  if (!snapshot.currentItem) {
    if (snapshot.externalLiveTv?.isActive) {
      return `ClawTV is not playing internal media. The last external live TV handoff was ${snapshot.externalLiveTv.channelLabel}, but the current screen in YouTube TV is unverified.`;
    }

    if (snapshot.externalLiveTv) {
      return `ClawTV is not playing internal media. The last remembered external live TV handoff was ${snapshot.externalLiveTv.channelLabel}, and the user has since returned to ClawTV.`;
    }

    return "Nothing is currently playing in ClawTV.";
  }

  const parts = [
    `State: ${snapshot.playbackState}`,
    `Title: ${snapshot.currentItem.title}`,
    snapshot.currentItem.showTitle ? `Show: ${snapshot.currentItem.showTitle}` : null,
    formatEpisodeLabel(snapshot.currentItem.seasonNumber, snapshot.currentItem.episodeNumber)
      ? `Episode: ${formatEpisodeLabel(snapshot.currentItem.seasonNumber, snapshot.currentItem.episodeNumber)}`
      : null,
    typeof snapshot.context?.remainingMs === "number" ? `Remaining runtime: ${formatDuration(snapshot.context.remainingMs)}` : null,
    typeof snapshot.context?.remainingEpisodesInSeason === "number"
      ? `Episodes remaining in this season after this one: ${snapshot.context.remainingEpisodesInSeason}`
      : null,
    typeof snapshot.context?.remainingSeasonsInShow === "number"
      ? `Seasons remaining after this one: ${snapshot.context.remainingSeasonsInShow}`
      : null
  ].filter((value): value is string => Boolean(value));

  return parts.join(" | ");
}

function buildOpenClawFinalOnlyPrompt(input: {
  transcript: string;
  playback: PlaybackSnapshot & { diagnostics?: PlaybackDiagnostics | null };
  voiceConfig: VoiceConfig;
  recentTurns: ReturnType<typeof db.listRecentVoiceTurns>;
}): string {
  return [
    `You are ${input.voiceConfig.assistantName}, the voice assistant for ClawTV on a television.`,
    "Return JSON only.",
    "Schema: {\"replyText\":\"string\",\"expectsReply\":boolean,\"action\":\"none|play|play-latest|shuffle|pause|resume|next|stop|live-tv-tune\",\"payload\":{},\"ok\":boolean}",
    "Keep the reply warm, concise, and direct.",
    "External live TV state is handoff memory, not live observation. Never say the user is definitely still on that channel or that you are watching it with them.",
    "Use clawtv-control when you need authoritative ClawTV state or need to perform a ClawTV action. Never call clawtv-control voice-turn from inside this handoff.",
    "Use the supplied state and recent conversation to resolve follow-ups like yes, the other one, switch to it, and go back.",
    "If external live TV is active, do not pretend ClawTV can pause or resume the YouTube TV app itself.",
    `Current playback context: ${describePlaybackContextForPrompt(input.playback)}`,
    `Current external live TV state: ${describeExternalLiveTvStateForPrompt(input.playback.externalLiveTv)}`,
    describeRecentVoiceTurnsForPrompt(input.recentTurns) === "none"
      ? null
      : `Recent conversation context: ${describeRecentVoiceTurnsForPrompt(input.recentTurns)}`,
    `User said: ${input.transcript}`
  ].filter((value): value is string => Boolean(value)).join(" ");
}

function extractOpenClawReplyFromRawText(rawText: string): {
  ok: boolean;
  replyText: string;
  commandName: VoiceTurnResponse["action"];
  payload: Record<string, unknown>;
  expectsReply: boolean;
  rawReplyText?: string | null;
} | null {
  try {
    const decision = JSON.parse(rawText) as {
      ok?: unknown;
      replyText?: unknown;
      action?: unknown;
      commandName?: unknown;
      payload?: unknown;
      expectsReply?: unknown;
    };
    const commandName = parseVoiceCommandName(decision.action ?? decision.commandName);

    return {
      ok: typeof decision.ok === "boolean" ? decision.ok : true,
      replyText: typeof decision.replyText === "string" && decision.replyText.trim().length > 0
        ? decision.replyText.trim()
        : rawText,
      commandName,
      payload: isPlainObject(decision.payload) ? decision.payload : {},
      expectsReply: typeof decision.expectsReply === "boolean"
        ? decision.expectsReply
        : commandName === "none" && rawText.trim().endsWith("?"),
      rawReplyText: rawText
    };
  } catch (error) {
    console.warn("Unable to parse OpenClaw agent JSON output", error);
    return rawText ? {
      ok: true,
      replyText: rawText,
      commandName: "none",
      payload: {},
      expectsReply: rawText.trim().endsWith("?"),
      rawReplyText: rawText
    } : null;
  }
}

function parseOpenClawToolLoopReply(rawText: string): (
  | {
      type: "tool_calls";
      toolCalls: AgentToolCall[];
    }
  | {
      type: "final";
      replyText: string;
      commandName: VoiceTurnResponse["action"];
      payload: Record<string, unknown>;
      expectsReply: boolean;
    }
) | null {
  try {
    const parsed = JSON.parse(rawText) as {
      type?: unknown;
      toolCalls?: unknown;
      replyText?: unknown;
      commandName?: unknown;
      payload?: unknown;
      expectsReply?: unknown;
    };

    if (parsed.type === "tool_calls" || Array.isArray(parsed.toolCalls)) {
      const toolCalls = Array.isArray(parsed.toolCalls)
        ? parsed.toolCalls
            .filter(isPlainObject)
            .map((toolCall) => ({
              name: typeof toolCall.name === "string" ? toolCall.name : "",
              arguments: isPlainObject(toolCall.arguments) ? toolCall.arguments : {}
            }))
            .filter((toolCall) => toolCall.name.length > 0)
        : [];

      return {
        type: "tool_calls",
        toolCalls
      };
    }

    if (parsed.type === "final" || typeof parsed.replyText === "string" || typeof parsed.commandName === "string") {
      return {
        type: "final",
        replyText: typeof parsed.replyText === "string" && parsed.replyText.trim().length > 0
          ? parsed.replyText.trim()
          : "",
        commandName: parseVoiceCommandName(parsed.commandName),
        payload: isPlainObject(parsed.payload) ? parsed.payload : {},
        expectsReply: typeof parsed.expectsReply === "boolean"
          ? parsed.expectsReply
          : false
      };
    }

    return null;
  } catch {
    return null;
  }
}

async function executeAgentToolCalls(
  toolCalls: AgentToolCall[],
  input: {
    sessionId: string | null;
    playback: PlaybackSnapshot;
  }
): Promise<AgentToolOutcome[]> {
  const outcomes: AgentToolOutcome[] = [];

  for (const toolCall of toolCalls.slice(0, 4)) {
    const args = toolCall.arguments ?? {};

    try {
      switch (toolCall.name) {
        case "get_playback_state":
          outcomes.push({
            name: toolCall.name,
            ok: true,
            arguments: args,
            result: buildPlaybackSnapshot()
          });
          break;
        case "search_catalog":
          outcomes.push({
            name: toolCall.name,
            ok: true,
            arguments: args,
            result: db.searchCatalog({
              query: typeof args.query === "string" ? args.query : "",
              mediaType: parseCatalogMediaType(typeof args.mediaType === "string" ? args.mediaType : null),
              limit: typeof args.limit === "number" ? args.limit : undefined
            })
          });
          break;
        case "get_recent_additions":
          outcomes.push({
            name: toolCall.name,
            ok: true,
            arguments: args,
            result: db.listRecentlyAdded({
              mediaType: parseCatalogMediaType(typeof args.mediaType === "string" ? args.mediaType : null),
              limit: typeof args.limit === "number" ? args.limit : undefined
            })
          });
          break;
        case "get_sync_status":
          outcomes.push({
            name: toolCall.name,
            ok: true,
            arguments: args,
            result: buildSyncStatusResponse()
          });
          break;
        case "list_live_tv_channels":
          outcomes.push({
            name: toolCall.name,
            ok: true,
            arguments: args,
            result: Object.values(resolveYouTubeTvChannelConfig()).map((channel) => ({
              key: channel.key,
              label: channel.label,
              aliases: channel.aliases,
              provider: channel.provider,
              urlConfigured: Boolean(channel.url)
            }))
          });
          break;
        case "get_live_tv_state":
          outcomes.push({
            name: toolCall.name,
            ok: true,
            arguments: args,
            result: buildPlaybackSnapshot().externalLiveTv
          });
          break;
        case "recommend_episodes":
          outcomes.push({
            name: toolCall.name,
            ok: true,
            arguments: args,
            result: db.recommendEpisodes({
              show: typeof args.show === "string" ? args.show : "",
              strategy: parseRecommendationStrategy(typeof args.strategy === "string" ? args.strategy : null) ?? "default",
              limit: typeof args.limit === "number" ? args.limit : undefined
            })
          });
          break;
        case "get_network_shows": {
          const network = typeof args.network === "string" ? args.network.trim() : "";
          outcomes.push({
            name: toolCall.name,
            ok: network.length > 0,
            arguments: args,
            result: network.length > 0
              ? db.listNetworkShows(network, typeof args.limit === "number" ? args.limit : undefined)
              : { error: "A network name is required." }
          });
          break;
        }
        case "tune_live_tv": {
          const request = parseLiveTvTunePayload(args);
          const result = await tuneLiveTv(request);
          outcomes.push({
            name: toolCall.name,
            ok: result.ok,
            arguments: args,
            result,
            executedAction: {
              action: "live-tv-tune",
              payload: {
                provider: request.provider,
                channel: result.channel
              },
              ok: result.ok,
              message: result.message
            }
          });
          break;
        }
        default:
          outcomes.push({
            name: toolCall.name,
            ok: false,
            arguments: args,
            result: {
              error: `Unknown tool: ${toolCall.name}`
            }
          });
          break;
      }
    } catch (error) {
      outcomes.push({
        name: toolCall.name,
        ok: false,
        arguments: args,
        result: {
          error: error instanceof Error ? error.message : `Tool ${toolCall.name} failed.`
        }
      });
    }
  }

  return outcomes;
}

async function runOpenClawJsonPrompt(input: {
  prompt: string;
  agentId: string;
  timeoutSeconds: number;
  thinking?: string | null;
  sessionKey?: string | null;
}): Promise<string | null> {
  return runOpenClawReplyText(input);
}

async function runOpenClawPlainPrompt(input: {
  prompt: string;
  agentId: string;
  timeoutSeconds: number;
  thinking?: string | null;
  sessionKey?: string | null;
}): Promise<string | null> {
  return runOpenClawReplyText(input);
}

function makeOpenClawEphemeralSessionKey(agentId: string, purpose: string, scope?: string | null): string {
  const normalizedScope = (scope ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const scopePart = normalizedScope.length > 0 ? `:${normalizedScope}` : "";
  return `agent:${agentId}:${purpose}${scopePart}:${randomUUID()}`;
}

async function runOpenClawReplyText(input: {
  prompt: string;
  agentId: string;
  timeoutSeconds: number;
  thinking?: string | null;
  sessionKey?: string | null;
}): Promise<string | null> {
  const bridgePath = process.env.CLAWTV_OPENCLAW_NATIVE_SESSION_TURN?.trim()
    || "/Users/briansnyder/clawd/scripts/openclaw_native_session_turn.py";
  const agentId = process.env.CLAWTV_OPENCLAW_AGENT_ID?.trim() || input.agentId || "main";
  const timeoutSeconds = Number.isFinite(input.timeoutSeconds) ? input.timeoutSeconds : 90;
  const sessionKey = input.sessionKey?.trim() || makeOpenClawEphemeralSessionKey(agentId, "clawtv");
  const args = [
    bridgePath,
    "--agent-id",
    agentId,
    "--session-key",
    sessionKey,
    "--message",
    input.prompt,
    "--timeout-seconds",
    String(timeoutSeconds),
    "--json"
  ];

  if (input.thinking) {
    args.splice(5, 0, "--thinking", input.thinking);
  }

  try {
    const { stdout, stderr } = await execFileAsync("python3", args, {
      env: {
        ...process.env,
        PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ""}`
      },
      maxBuffer: 8 * 1024 * 1024
    });
    const payload = JSON.parse(stdout) as {
      status?: unknown;
      reply?: unknown;
      error?: unknown;
    };
    if (payload.status !== "ok" || typeof payload.reply !== "string" || payload.reply.trim().length === 0) {
      console.warn("OpenClaw native voice handoff did not return a usable reply.", {
        agentId,
        sessionKey,
        status: payload.status,
        error: payload.error ?? null,
        stderr: stderr.trim()
      });
      return null;
    }
    return payload.reply.trim();
  } catch (error) {
    console.warn("OpenClaw voice handoff failed", error);
    return null;
  }
}

function getOpenClawThinking(): string {
  return process.env.CLAWTV_OPENCLAW_THINKING?.trim() || "low";
}

function extractOpenClawRawText(stdout: string): string | null {
  try {
    const payload = JSON.parse(stdout) as {
      result?: {
        payloads?: Array<{
          text?: string | null;
        }>;
        finalAssistantVisibleText?: string | null;
      };
    };

    return payload.result?.payloads
      ?.map((entry) => entry.text?.trim())
      .filter((entry): entry is string => Boolean(entry))
      .join("\n\n")
      || payload.result?.finalAssistantVisibleText?.trim()
      || null;
  } catch {
    return null;
  }
}

function describeRecentVoiceTurnsForPrompt(recentTurns: ReturnType<typeof db.listRecentVoiceTurns>): string {
  if (recentTurns.length === 0) {
    return "none";
  }

  return recentTurns
    .map((turn) => {
      const payloadSummary = Object.keys(turn.finalPayload).length > 0
        ? ` payload=${summarizeRecentVoiceTurnPayload(turn.finalPayload)}`
        : "";
      return `U:${turn.transcript} | A:${turn.finalReplyText} | action=${turn.finalCommandName}${payloadSummary}`;
    })
    .join(" || ");
}

function summarizeRecentVoiceTurnPayload(payload: Record<string, unknown>): string {
  const raw = JSON.stringify(payload);
  if (raw.length <= 120) {
    return raw;
  }

  return `${raw.slice(0, 117)}...`;
}

function describeToolOutcomesForPrompt(toolOutcomes: AgentToolOutcome[]): string {
  if (toolOutcomes.length === 0) {
    return "No tools have been used yet in this turn.";
  }

  return toolOutcomes
    .map((outcome) => JSON.stringify({
      tool: outcome.name,
      ok: outcome.ok,
      arguments: outcome.arguments,
      result: outcome.result
    }))
    .join(" || ");
}

function describeExternalLiveTvStateForPrompt(liveTvState: ExternalLiveTvState | null): string {
  if (!liveTvState) {
    return "No persisted external live TV state.";
  }

  if (liveTvState.isActive) {
    return `${liveTvState.channelLabel} via ${liveTvState.provider} at ${liveTvState.tunedAt}. ClawTV last launched this channel externally, but the current screen is unverified.`;
  }

  return `${liveTvState.channelLabel} via ${liveTvState.provider} at ${liveTvState.tunedAt}. Historical handoff only; the user has since returned to ClawTV.`;
}

function parseVoiceCommandName(value: unknown): VoiceTurnResponse["action"] {
  return value === "play"
    || value === "play-latest"
    || value === "shuffle"
    || value === "pause"
    || value === "resume"
    || value === "next"
    || value === "stop"
    || value === "live-tv-tune"
    ? value
    : "none";
}

function parseLiveTvTunePayload(payload: Record<string, unknown>): LiveTvTuneRequest {
  const channel = typeof payload.channel === "string" ? payload.channel.trim() : "";
  if (!channel) {
    throw new Error("The live TV tune request did not include a channel.");
  }

  return {
    provider: parseLiveTvProvider(payload.provider),
    channel
  };
}

function normalizeRuntimeLogPath(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function resolveRuntimeLogTrimIntervalMs(): number {
  const raw = Number(process.env.CLAWTV_RUNTIME_LOG_TRIM_INTERVAL_MINUTES ?? 15);

  if (!Number.isFinite(raw) || raw <= 0) {
    return 15 * 60 * 1000;
  }

  return Math.round(raw * 60 * 1000);
}

function resolveRuntimeLogMaxBytes(): number {
  const raw = Number(process.env.CLAWTV_RUNTIME_LOG_MAX_BYTES ?? 1_000_000);

  if (!Number.isFinite(raw) || raw <= 0) {
    return 1_000_000;
  }

  return Math.round(raw);
}

function trimRuntimeLogsIfNeeded(): void {
  const maxBytes = resolveRuntimeLogMaxBytes();
  trimRuntimeLogIfNeeded(runtimeStdoutLogPath, maxBytes);
  trimRuntimeLogIfNeeded(runtimeStderrLogPath, maxBytes);
}

function trimRuntimeLogIfNeeded(logPath: string | null, maxBytes: number): void {
  if (!logPath || !existsSync(logPath)) {
    return;
  }

  try {
    const stats = statSync(logPath);
    if (stats.size <= maxBytes) {
      return;
    }

    const archivePath = `${logPath}.${new Date().toISOString().replace(/[:]/gu, "-")}`;
    copyFileSync(logPath, archivePath);
    truncateSync(logPath, 0);
    pruneArchivedRuntimeLogs(logPath);
  } catch (error) {
    console.warn("Unable to trim runtime log", logPath, error);
  }
}

function pruneArchivedRuntimeLogs(baseLogPath: string): void {
  try {
    const directory = dirname(baseLogPath);
    const fileName = baseLogPath.split("/").at(-1);

    if (!fileName) {
      return;
    }

    const archivedLogs = readdirSync(directory)
      .filter((entry) => entry.startsWith(`${fileName}.`))
      .sort()
      .reverse()
      .slice(10);

    archivedLogs.forEach((entry) => {
      try {
        unlinkSync(join(directory, entry));
      } catch {
        // Ignore prune issues; archived logs are best-effort.
      }
    });
  } catch {
    // Ignore prune issues; archived logs are best-effort.
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveVoiceBackend(): VoiceConfig["backend"] {
  const configured = process.env.CLAWTV_VOICE_BACKEND?.trim().toLowerCase();
  if (configured === "mock" || configured === "openclaw") {
    return configured;
  }

  return "openclaw";
}

function resolveVoiceReplyMode(): VoiceConfig["replyMode"] {
  return isElevenLabsConfigured() ? "server-audio" : "client-tts";
}

async function synthesizeVoiceReplyAudio(text: string): Promise<string | null> {
  return synthesizeVoiceAudio(text, {
    bucket: "replies",
    modelId: process.env.ELEVENLABS_MODEL_ID?.trim() || "eleven_flash_v2_5"
  });
}

async function resolveVoiceCueUrl(
  category: "greeting" | "processing" | "acknowledgement" | "unavailable",
  text: string
): Promise<string | null> {
  const synthesized = await synthesizeVoiceAudio(text, {
    bucket: `cues/${category}`,
    modelId: process.env.ELEVENLABS_CUE_MODEL_ID?.trim()
      || process.env.ELEVENLABS_MODEL_ID?.trim()
      || "eleven_flash_v2_5"
  });

  return synthesized ?? pickVoiceCueUrl(category);
}

async function synthesizeVoiceAudio(inputText: string, options: {
  bucket: string;
  modelId: string;
}): Promise<string | null> {
  const text = inputText.trim();

  if (!text.trim() || !isElevenLabsConfigured()) {
    return null;
  }

  const apiKey = process.env.ELEVENLABS_API_KEY?.trim();
  const voiceId = process.env.ELEVENLABS_VOICE_ID?.trim();
  const modelId = options.modelId;
  const voiceSettings = resolveElevenLabsVoiceSettings(options.bucket.startsWith("cues/"));

  if (!apiKey || !voiceId) {
    return null;
  }

  const cacheDir = join(voiceCacheDir, ...options.bucket.split("/"));
  mkdirSync(cacheDir, { recursive: true });

  const cacheKey = createHash("sha256")
    .update(JSON.stringify({ voiceId, modelId, bucket: options.bucket, text, voiceSettings }))
    .digest("hex");
  const fileName = `${cacheKey}.mp3`;
  const filePath = join(cacheDir, fileName);

  if (!existsSync(filePath)) {
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`, {
      method: "POST",
      headers: {
        Accept: "audio/mpeg",
        "Content-Type": "application/json",
        "xi-api-key": apiKey
      },
      body: JSON.stringify({
        text,
        model_id: modelId,
        voice_settings: voiceSettings ?? undefined
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.warn(`ElevenLabs synthesis failed with status ${response.status}: ${errorText}`);
      return null;
    }

    const audioBuffer = Buffer.from(await response.arrayBuffer());
    writeFileSync(filePath, audioBuffer);
  }

  return withBasePath(basePath, `/api/voice/audio/${options.bucket}/${encodeURIComponent(fileName)}`);
}

function pickCueLine(
  category: "greeting" | "processing" | "acknowledgement" | "unavailable",
  fallbackText: string
): string {
  const envKey = category === "greeting"
    ? "CLAWTV_VOICE_GREETING_VARIANTS"
    : category === "processing"
      ? "CLAWTV_VOICE_PROCESSING_VARIANTS"
      : category === "acknowledgement"
        ? "CLAWTV_VOICE_ACKNOWLEDGEMENT_VARIANTS"
        : "CLAWTV_VOICE_UNAVAILABLE_VARIANTS";
  const variants = (process.env[envKey] ?? "")
    .split("|")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (variants.length === 0) {
    return fallbackText;
  }

  return variants[Math.floor(Math.random() * variants.length)] ?? fallbackText;
}

function resolveElevenLabsVoiceSettings(isCue: boolean): Record<string, unknown> | null {
  const raw = isCue
    ? process.env.ELEVENLABS_CUE_VOICE_SETTINGS_JSON?.trim() || process.env.ELEVENLABS_VOICE_SETTINGS_JSON?.trim()
    : process.env.ELEVENLABS_VOICE_SETTINGS_JSON?.trim();

  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : null;
  } catch (error) {
    console.warn(`Unable to parse ElevenLabs voice settings JSON (${isCue ? "cue" : "reply"}):`, error);
    return null;
  }
}

function isElevenLabsConfigured(): boolean {
  return Boolean(process.env.ELEVENLABS_API_KEY?.trim() && process.env.ELEVENLABS_VOICE_ID?.trim());
}

function pickVoiceCueUrl(category: "greeting" | "processing" | "acknowledgement" | "unavailable"): string | null {
  const pack = process.env.CLAWTV_VOICE_AUDIO_PACK?.trim() || "default";
  const categoryDir = join(voiceAssetDir, pack, category);

  if (!existsSync(categoryDir)) {
    return null;
  }

  const files = readdirSync(categoryDir)
    .filter((fileName) => isAudioFile(fileName))
    .sort();

  if (files.length === 0) {
    return null;
  }

  const selectedFile = files[Math.floor(Math.random() * files.length)] ?? files[0];
  return withBasePath(
    basePath,
    `/api/voice/audio/packs/${encodeURIComponent(pack)}/${encodeURIComponent(category)}/${encodeURIComponent(selectedFile)}`
  );
}

function isAudioFile(fileName: string): boolean {
  return [".mp3", ".m4a", ".wav", ".aiff", ".aac"].includes(extname(fileName).toLowerCase());
}

function serveVoiceAudio(routePath: string, headOnly: boolean, response: ServerResponse): boolean {
  if (routePath.startsWith("/api/voice/audio/replies/")) {
    const fileName = decodeURIComponent(routePath.replace("/api/voice/audio/replies/", ""));
    return serveFileFromRoot(join(voiceCacheDir, "replies"), fileName, headOnly, response);
  }

  if (routePath.startsWith("/api/voice/audio/cues/")) {
    const parts = routePath.replace("/api/voice/audio/cues/", "").split("/").map((part) => decodeURIComponent(part));
    const [category, fileName] = parts;
    if (!category || !fileName) {
      return false;
    }
    return serveFileFromRoot(join(voiceCacheDir, "cues", category), fileName, headOnly, response);
  }

  if (routePath.startsWith("/api/voice/audio/packs/")) {
    const parts = routePath.replace("/api/voice/audio/packs/", "").split("/").map((part) => decodeURIComponent(part));
    const [pack, category, ...rest] = parts;
    const fileName = rest.join("/");

    if (!pack || !category || !fileName) {
      return false;
    }

    return serveFileFromRoot(join(voiceAssetDir, pack, category), fileName, headOnly, response);
  }

  return false;
}

function serveFileFromRoot(root: string, relativeFilePath: string, headOnly: boolean, response: ServerResponse): boolean {
  const assetPath = resolveSafeAssetPath(root, relativeFilePath);

  if (!assetPath || !existsSync(assetPath)) {
    return false;
  }

  response.writeHead(200, {
    "cache-control": "public, max-age=31536000, immutable",
    "content-type": contentTypeFor(assetPath)
  });

  if (headOnly) {
    response.end();
    return true;
  }

  response.end(readFileSync(assetPath));
  return true;
}

function matchesVoiceCommand(transcript: string, phrases: string[]): boolean {
  const normalized = normalizeVoiceCommandTranscript(transcript);

  return phrases.some((phrase) => {
    const normalizedPhrase = normalizeVoiceCommandTranscript(phrase);
    const commandPattern = new RegExp(
      `^(?:(?:hey|hi|okay|ok|please|assistant)\\s+)*(?:can you\\s+|could you\\s+|would you\\s+)?${escapeRegExp(normalizedPhrase)}(?:\\s+please)?$`,
      "u"
    );

    return commandPattern.test(normalized);
  });
}

function normalizeVoiceCommandTranscript(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function formatEpisodeLabel(seasonNumber: number | null, episodeNumber: number | null): string | null {
  if (typeof seasonNumber !== "number" || typeof episodeNumber !== "number") {
    return null;
  }

  return `S${String(seasonNumber).padStart(2, "0")}E${String(episodeNumber).padStart(2, "0")}`;
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours} hour${hours === 1 ? "" : "s"}, ${minutes} minute${minutes === 1 ? "" : "s"}, and ${seconds} second${seconds === 1 ? "" : "s"}`;
  }

  if (minutes > 0) {
    return `${minutes} minute${minutes === 1 ? "" : "s"} and ${seconds} second${seconds === 1 ? "" : "s"}`;
  }

  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

function formatRating(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  if (value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes") {
    return true;
  }

  if (value === "0" || value.toLowerCase() === "false" || value.toLowerCase() === "no") {
    return false;
  }

  return fallback;
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

  let upstreamResponse: Response | null = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const candidateResponse = await fetch(input.sourceUrl, {
      method: input.request.method,
      headers: upstreamHeaders
    });

    if (candidateResponse.ok || candidateResponse.status === 206) {
      upstreamResponse = candidateResponse;
      break;
    }

    if (!isRetryablePlexStatus(candidateResponse.status) || attempt === 2) {
      throw new Error(`Plex proxy request failed with status ${candidateResponse.status}.`);
    }

    await candidateResponse.body?.cancel().catch(() => undefined);
    await sleep(350 * (attempt + 1));
  }

  if (upstreamResponse == null) {
    throw new Error("Plex proxy request failed before a usable response was received.");
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
  const extension = extname(sanitizedUrl.pathname);

  sanitizedUrl.searchParams.delete("X-Plex-Token");

  const proxyPath = extension
    ? `/api/playback/hls/proxy${extension}`
    : "/api/playback/hls/proxy";

  return withBasePath(basePath, `${proxyPath}?upstream=${encodeURIComponent(encodeProxyTarget(sanitizedUrl.toString()))}`);
}

function appendPlexToken(sourceUrl: string, token: string, plexBaseUrl: string): string {
  const url = new URL(sourceUrl);

  if (isAllowedPlexUrl(url, plexBaseUrl) && !url.searchParams.has("X-Plex-Token")) {
    url.searchParams.set("X-Plex-Token", token);
  }

  return url.toString();
}

function isRetryablePlexStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

async function sleep(delayMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
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
  const assetPath = resolveSafeAssetPath(webDistDir, relativePath);

  if (!assetPath || !existsSync(assetPath)) {
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

function resolveSafeAssetPath(root: string, relativeFilePath: string): string | null {
  const safeRoot = resolve(root);
  const candidatePath = resolve(safeRoot, normalize(relativeFilePath));
  const relativePath = relative(safeRoot, candidatePath);

  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    return null;
  }

  return candidatePath;
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

  if (extension === ".mp3") {
    return "audio/mpeg";
  }

  if (extension === ".m4a") {
    return "audio/mp4";
  }

  if (extension === ".wav") {
    return "audio/wav";
  }

  if (extension === ".aiff" || extension === ".aif") {
    return "audio/aiff";
  }

  if (extension === ".aac") {
    return "audio/aac";
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
