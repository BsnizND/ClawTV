import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type {
  CatalogMediaTypeFilter,
  ClientPlaybackState,
  CommandName,
  PlaybackDiagnostics,
  PlaybackDiagnosticsUpdateRequest,
  PlaybackSnapshot,
  VoiceConfig,
  VoiceTurnRequest,
  VoiceTurnResponse,
  PlaybackStateUpdateRequest,
  SyncMode
} from "@clawtv/contracts";
import { DEFAULT_BASE_PATH, normalizeBasePath, withBasePath } from "@clawtv/core";
import { openClawTvDatabase } from "@clawtv/db";
import { syncPlexCatalog } from "@clawtv/plex-sync";

const rootDir = fileURLToPath(new URL("../../..", import.meta.url));
const serverDataDir = process.env.CLAWTV_DATA_DIR ?? join(rootDir, "data");
const voiceAssetDir = join(rootDir, "assets", "voice");
const voiceCacheDir = join(serverDataDir, "voice-cache");
const port = Number(process.env.PORT ?? 8787);
const basePath = normalizeBasePath(process.env.CLAWTV_BASE_PATH ?? DEFAULT_BASE_PATH) || DEFAULT_BASE_PATH;
const webDistDir = join(rootDir, "apps", "web", "dist");
const execFileAsync = promisify(execFile);
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
      basePath
    });
    return;
  }

  if (request.method === "GET" && routePath === "/api/status") {
    sendJson(response, 200, db.getStatus());
    return;
  }

  if (request.method === "GET" && routePath === "/api/voice/config") {
    sendJson(response, 200, buildVoiceConfig());
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
      positionMs: nextPositionMs
    });

    sendJson(response, 200, buildPlaybackSnapshot());
    return;
  }

  if (request.method === "POST" && routePath === "/api/voice/turn") {
    const body = (await readJsonBody(request)) as unknown as VoiceTurnRequest;
    const voiceConfig = buildVoiceConfig();

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

function buildVoiceConfig(): VoiceConfig {
  const backend = resolveVoiceBackend();
  const replyMode = resolveVoiceReplyMode();

  return {
    enabled: parseBooleanEnv(process.env.CLAWTV_VOICE_ENABLED, true),
    backend,
    assistantId: process.env.CLAWTV_VOICE_ASSISTANT_ID?.trim() || "default-assistant",
    assistantName: process.env.CLAWTV_VOICE_ASSISTANT_NAME?.trim() || "Assistant",
    greetingText: process.env.CLAWTV_VOICE_GREETING_TEXT?.trim() || "Hey, what can I do for you?",
    processingText: process.env.CLAWTV_VOICE_PROCESSING_TEXT?.trim() || "Looking into it.",
    acknowledgementText: process.env.CLAWTV_VOICE_ACKNOWLEDGEMENT_TEXT?.trim() || "Got it.",
    unavailableText: process.env.CLAWTV_VOICE_UNAVAILABLE_TEXT?.trim() || "Voice chat is not available right now.",
    greetingAudioUrl: pickVoiceCueUrl("greeting"),
    processingAudioUrl: pickVoiceCueUrl("processing"),
    acknowledgementAudioUrl: pickVoiceCueUrl("acknowledgement"),
    unavailableAudioUrl: pickVoiceCueUrl("unavailable"),
    sttMode: "shield",
    replyMode
  };
}

async function buildVoiceTurnResponse(body: VoiceTurnRequest, voiceConfig: VoiceConfig): Promise<VoiceTurnResponse> {
  const transcript = typeof body.transcript === "string" ? body.transcript.trim() : "";
  const normalizedTranscript = transcript.toLowerCase();
  const playbackBefore = buildPlaybackSnapshot();
  const shouldResumeOriginalPlayback = body.playbackState === "playing" || body.playbackState === "loading";
  let action: VoiceTurnResponse["action"] = "none";
  let replyText = "";

  if (!transcript) {
    replyText = "I didn't catch that. Please try again.";
  } else if (matchesVoiceCommand(normalizedTranscript, ["pause", "hold on", "stop playback"])) {
    action = "pause";
    const result = db.applyCommand({
      commandName: "pause",
      payload: {},
      source: "voice"
    });
    replyText = result.message;
  } else if (matchesVoiceCommand(normalizedTranscript, ["resume", "keep going", "continue playback"])) {
    action = "resume";
    const result = db.applyCommand({
      commandName: "resume",
      payload: {},
      source: "voice"
    });
    replyText = result.message;
  } else if (matchesVoiceCommand(normalizedTranscript, ["next", "skip this"])) {
    action = "next";
    const result = db.applyCommand({
      commandName: "next",
      payload: {},
      source: "voice"
    });
    replyText = result.message;
  } else if (matchesVoiceCommand(normalizedTranscript, ["stop", "turn it off"])) {
    action = "stop";
    const result = db.applyCommand({
      commandName: "stop",
      payload: {},
      source: "voice"
    });
    replyText = result.message;
  } else if (asksForRemainingTime(normalizedTranscript)) {
    replyText = describeRemainingRuntime(playbackBefore);
  } else if (asksForRemainingEpisodes(normalizedTranscript)) {
    replyText = describeRemainingEpisodes(playbackBefore);
  } else if (asksForRemainingSeasons(normalizedTranscript)) {
    replyText = describeRemainingSeasons(playbackBefore);
  } else if (asksWhatIsPlaying(normalizedTranscript)) {
    replyText = describeNowPlaying(playbackBefore);
  } else {
    replyText = await buildConversationalReply({
      transcript,
      playback: playbackBefore,
      voiceConfig
    });
  }

  const playbackAfter = buildPlaybackSnapshot();
  const replyAudioUrl = await synthesizeVoiceReplyAudio(replyText);
  const replyMode = replyAudioUrl ? "server-audio" : voiceConfig.replyMode;

  return {
    ok: true,
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
    resumePlayback: action === "none" && shouldResumeOriginalPlayback,
    action,
    playback: playbackAfter
  };
}

async function buildConversationalReply(input: {
  transcript: string;
  playback: PlaybackSnapshot & { diagnostics?: PlaybackDiagnostics | null };
  voiceConfig: VoiceConfig;
}): Promise<string> {
  if (input.voiceConfig.backend === "openclaw") {
    const openClawReply = await runOpenClawVoiceTurn(input);
    if (openClawReply) {
      return openClawReply;
    }
  }

  return `I heard: "${input.transcript}". The live assistant handoff is not available right now, but the voice turn plumbing is ready.`;
}

async function runOpenClawVoiceTurn(input: {
  transcript: string;
  playback: PlaybackSnapshot & { diagnostics?: PlaybackDiagnostics | null };
  voiceConfig: VoiceConfig;
}): Promise<string | null> {
  const command = process.env.CLAWTV_OPENCLAW_COMMAND?.trim() || "openclaw";
  const agentId = process.env.CLAWTV_OPENCLAW_AGENT_ID?.trim() || "jay";
  const thinking = process.env.CLAWTV_OPENCLAW_THINKING?.trim() || "minimal";
  const timeoutSeconds = Number(process.env.CLAWTV_OPENCLAW_TIMEOUT_SECONDS ?? 90);
  const prompt = buildOpenClawPrompt(input);

  try {
    const { stdout } = await execFileAsync(command, [
      "agent",
      "--agent",
      agentId,
      "--message",
      prompt,
      "--thinking",
      thinking,
      "--timeout",
      String(Number.isFinite(timeoutSeconds) ? timeoutSeconds : 90),
      "--json"
    ], {
      maxBuffer: 2 * 1024 * 1024
    });

    return extractOpenClawReplyText(stdout);
  } catch (error) {
    console.warn("OpenClaw voice handoff failed", error);
    return null;
  }
}

function buildOpenClawPrompt(input: {
  transcript: string;
  playback: PlaybackSnapshot & { diagnostics?: PlaybackDiagnostics | null };
  voiceConfig: VoiceConfig;
}): string {
  const playbackSummary = describePlaybackContextForPrompt(input.playback);

  return [
    `You are ${input.voiceConfig.assistantName}, the voice assistant for ClawTV on a television.`,
    "Reply in natural spoken language for TV playback voice chat.",
    "Keep the response concise, warm, and under two short sentences unless the question truly needs more.",
    "Do not mention OpenClaw, prompts, JSON, transport, or implementation details.",
    "If the user asks about what is currently on, remaining runtime, remaining episodes, or remaining seasons, use the supplied playback context only.",
    "If the user asks for something you cannot verify from the supplied playback context, answer helpfully but briefly.",
    `Current playback context: ${playbackSummary}`,
    `User said: ${input.transcript}`
  ].join(" ");
}

function describePlaybackContextForPrompt(snapshot: PlaybackSnapshot): string {
  if (!snapshot.currentItem) {
    return "Nothing is currently playing.";
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

function extractOpenClawReplyText(stdout: string): string | null {
  try {
    const payload = JSON.parse(stdout) as {
      result?: {
        payloads?: Array<{
          text?: string | null;
        }>;
      };
    };

    const text = payload.result?.payloads
      ?.map((entry) => entry.text?.trim())
      .filter((entry): entry is string => Boolean(entry))
      .join("\n\n");

    return text && text.length > 0 ? text : null;
  } catch (error) {
    console.warn("Unable to parse OpenClaw agent JSON output", error);
    return null;
  }
}

function resolveVoiceBackend(): VoiceConfig["backend"] {
  const configured = process.env.CLAWTV_VOICE_BACKEND?.trim().toLowerCase();
  return configured === "openclaw" ? "openclaw" : "mock";
}

function resolveVoiceReplyMode(): VoiceConfig["replyMode"] {
  return isElevenLabsConfigured() ? "server-audio" : "client-tts";
}

async function synthesizeVoiceReplyAudio(text: string): Promise<string | null> {
  if (!text.trim() || !isElevenLabsConfigured()) {
    return null;
  }

  const apiKey = process.env.ELEVENLABS_API_KEY?.trim();
  const voiceId = process.env.ELEVENLABS_VOICE_ID?.trim();
  const modelId = process.env.ELEVENLABS_MODEL_ID?.trim() || "eleven_flash_v2_5";

  if (!apiKey || !voiceId) {
    return null;
  }

  const replyDir = join(voiceCacheDir, "replies");
  mkdirSync(replyDir, { recursive: true });

  const cacheKey = createHash("sha256")
    .update(JSON.stringify({ voiceId, modelId, text }))
    .digest("hex");
  const fileName = `${cacheKey}.mp3`;
  const filePath = join(replyDir, fileName);

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
        model_id: modelId
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

  return withBasePath(basePath, `/api/voice/audio/replies/${encodeURIComponent(fileName)}`);
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
  return phrases.some((phrase) => transcript.includes(phrase));
}

function asksForRemainingTime(transcript: string): boolean {
  return transcript.includes("how long is left")
    || transcript.includes("how much is left")
    || transcript.includes("time left")
    || transcript.includes("how much longer")
    || transcript.includes("when is this over");
}

function asksForRemainingEpisodes(transcript: string): boolean {
  return transcript.includes("how many more episodes")
    || transcript.includes("episodes left in this season")
    || transcript.includes("episodes are there in this season after this one");
}

function asksForRemainingSeasons(transcript: string): boolean {
  return transcript.includes("how many more seasons")
    || transcript.includes("seasons left after this one")
    || transcript.includes("seasons are there in this show after this one");
}

function asksWhatIsPlaying(transcript: string): boolean {
  return transcript.includes("what's on")
    || transcript.includes("what is on")
    || transcript.includes("what are we watching")
    || transcript.includes("what is playing");
}

function describeNowPlaying(snapshot: ReturnType<typeof buildPlaybackSnapshot>): string {
  if (!snapshot.currentItem) {
    return "Nothing is currently playing.";
  }

  const titleParts = [
    snapshot.currentItem.showTitle,
    formatEpisodeLabel(snapshot.currentItem.seasonNumber, snapshot.currentItem.episodeNumber),
    snapshot.currentItem.title
  ].filter((value): value is string => Boolean(value));

  return `Right now it's ${titleParts.join(" - ")}.`;
}

function describeRemainingRuntime(snapshot: ReturnType<typeof buildPlaybackSnapshot>): string {
  if (!snapshot.currentItem) {
    return "Nothing is currently playing.";
  }

  const remainingMs = snapshot.context?.remainingMs;
  if (typeof remainingMs !== "number") {
    return `I don't have a remaining runtime for ${snapshot.currentItem.title}.`;
  }

  return `${snapshot.currentItem.title} has ${formatDuration(remainingMs)} left.`;
}

function describeRemainingEpisodes(snapshot: ReturnType<typeof buildPlaybackSnapshot>): string {
  if (!snapshot.currentItem || snapshot.currentItem.mediaType !== "episode") {
    return "That question only makes sense for a TV episode.";
  }

  const remainingEpisodes = snapshot.context?.remainingEpisodesInSeason;
  if (typeof remainingEpisodes !== "number") {
    return `I don't have episode counts for ${snapshot.currentItem.title}.`;
  }

  return remainingEpisodes === 0
    ? "This is the last episode left in the current season."
    : `There ${remainingEpisodes === 1 ? "is" : "are"} ${remainingEpisodes} more ${remainingEpisodes === 1 ? "episode" : "episodes"} in this season after this one.`;
}

function describeRemainingSeasons(snapshot: ReturnType<typeof buildPlaybackSnapshot>): string {
  if (!snapshot.currentItem || snapshot.currentItem.mediaType !== "episode") {
    return "That question only makes sense for a TV episode.";
  }

  const remainingSeasons = snapshot.context?.remainingSeasonsInShow;
  if (typeof remainingSeasons !== "number") {
    return `I don't have season counts for ${snapshot.currentItem.title}.`;
  }

  return remainingSeasons === 0
    ? "There are no more seasons after this one."
    : `There ${remainingSeasons === 1 ? "is" : "are"} ${remainingSeasons} more ${remainingSeasons === 1 ? "season" : "seasons"} after this one.`;
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
