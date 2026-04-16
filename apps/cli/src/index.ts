#!/usr/bin/env node
import type {
  CatalogCollectionListResponse,
  CatalogMediaTypeFilter,
  CatalogRecommendationResponse,
  CatalogNetworkListResponse,
  CatalogNetworkShowsResponse,
  CatalogRecentResponse,
  CatalogSearchResponse,
  CatalogShowListResponse,
  CheckNewContentRequest,
  CheckNewContentResponse,
  CommandName,
  CommandResult,
  PlaybackContext,
  PlaybackSnapshot,
  SeekCommandRequest,
  ServerStatus,
  SyncRequest,
  SyncRunSummary,
  VoiceConfig,
  VoiceTurnRequest,
  VoiceTurnResponse
} from "@clawtv/contracts";
import { DEFAULT_BASE_PATH, resolveRelativeUrl } from "@clawtv/core";

const [, , rawCommand = "help", ...restArgs] = process.argv;
const serverOrigin = process.env.CLAWTV_SERVER_ORIGIN ?? `http://localhost:8787${DEFAULT_BASE_PATH}/`;

async function main(): Promise<void> {
  try {
    if (rawCommand === "help" || rawCommand === "--help" || rawCommand === "-h") {
      printHelp();
      return;
    }

    if (rawCommand === "status") {
      const status = await getJson<ServerStatus>("api/status");
      console.log(JSON.stringify(status, null, 2));
      return;
    }

    if (rawCommand === "sessions") {
      const sessions = await getJson("api/sessions");
      console.log(JSON.stringify(sessions, null, 2));
      return;
    }

    if (rawCommand === "now-playing") {
      const playback = await getJson<PlaybackSnapshot>("api/playback/current");
      console.log(JSON.stringify(playback, null, 2));
      return;
    }

    if (rawCommand === "now-playing-summary") {
      const playback = await getJson<PlaybackSnapshot>("api/playback/current");
      console.log(formatPlaybackSummary(playback));
      return;
    }

    if (rawCommand === "voice-config") {
      const config = await getJson<VoiceConfig>("api/voice/config");
      console.log(JSON.stringify(config, null, 2));
      return;
    }

    if (rawCommand === "voice-turn") {
      const payload = parseVoiceTurnFlags(restArgs);
      if (!payload.transcript) {
        throw new Error("voice-turn requires --text \"...\"");
      }

      const playback = await getJson<PlaybackSnapshot>("api/playback/current");
      const result = await postJson<VoiceTurnResponse>("api/voice/turn", {
        transcript: payload.transcript,
        sessionId: playback.sessionId ?? undefined,
        playbackState: payload.playbackState ?? playback.playbackState,
        currentItemId: playback.currentItem?.id ?? null,
        currentItemTitle: playback.currentItem?.title ?? null,
        showTitle: playback.currentItem?.showTitle ?? null
      } satisfies VoiceTurnRequest);
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (rawCommand === "sync-status") {
      const syncStatus = await getJson<{ latestRun: SyncRunSummary | null }>("api/sync/status");
      console.log(JSON.stringify(syncStatus, null, 2));
      return;
    }

    if (rawCommand === "check-new-content") {
      const payload = parseKeyValueFlags(restArgs);
      const parsedLimit = payload.limit ? Number(payload.limit) : undefined;
      const result = await postJson<CheckNewContentResponse>("api/sync/check-new-content", {
        library: payload.library,
        limit: typeof parsedLimit === "number" && Number.isFinite(parsedLimit) ? parsedLimit : undefined
      } satisfies CheckNewContentRequest);
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (rawCommand === "search") {
      const payload = parseCatalogFlags(restArgs);
      const result = await getJson<CatalogSearchResponse>(withSearchParams("api/catalog/search", {
        query: payload.query ?? payload.q ?? "",
        type: payload.type,
        limit: payload.limit
      }));
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (rawCommand === "list-shows") {
      const payload = parseCatalogFlags(restArgs);
      const result = await getJson<CatalogShowListResponse>(withSearchParams("api/catalog/shows", {
        limit: payload.limit
      }));
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (rawCommand === "list-collections") {
      const payload = parseCatalogFlags(restArgs);
      const result = await getJson<CatalogCollectionListResponse>(withSearchParams("api/catalog/collections", {
        limit: payload.limit
      }));
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (rawCommand === "list-networks") {
      const payload = parseCatalogFlags(restArgs);
      const result = await getJson<CatalogNetworkListResponse>(withSearchParams("api/catalog/networks", {
        limit: payload.limit
      }));
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (rawCommand === "list-network-shows") {
      const flags = parseKeyValueFlags(restArgs);
      if (!flags.network) {
        throw new Error("list-network-shows requires --network \"...\"");
      }

      const result = await getJson<CatalogNetworkShowsResponse>(withSearchParams("api/catalog/network-shows", {
        network: flags.network,
        limit: flags.limit
      }));
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (rawCommand === "recently-added") {
      const payload = parseCatalogFlags(restArgs);
      const result = await getJson<CatalogRecentResponse>(withSearchParams("api/catalog/recently-added", {
        type: payload.type,
        limit: payload.limit
      }));
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (rawCommand === "recommend-show") {
      const flags = parseKeyValueFlags(restArgs);
      if (!flags.show) {
        throw new Error("recommend-show requires --show \"...\"");
      }

      const result = await getJson<CatalogRecommendationResponse>(withSearchParams("api/catalog/recommendations/show", {
        show: flags.show,
        strategy: flags.strategy,
        limit: flags.limit,
        unwatchedOnly: flags["unwatched-only"]
      }));
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (rawCommand === "sync-plex") {
      const payload = parseKeyValueFlags(restArgs) as Partial<SyncRequest>;
      const result = await postJson("api/sync/plex", {
        mode: payload.mode ?? "full-sync",
        library: payload.library
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (rawCommand === "seek") {
      const payload = parseSeekFlags(restArgs);
      const result = await postJson<CommandResult>("api/commands/seek", payload);
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (isCommandName(rawCommand)) {
      const payload = parseKeyValueFlags(restArgs);
      const result = await postJson<CommandResult>(`api/commands/${rawCommand}`, payload);
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.error(`Unknown command: ${rawCommand}`);
    printHelp();
    process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "ClawTV CLI request failed.");
    process.exitCode = 1;
  }
}

function printHelp(): void {
  console.log(`ClawTV CLI

Usage:
  clawtv status
  clawtv sessions
  clawtv now-playing
  clawtv now-playing-summary
  clawtv voice-config
  clawtv voice-turn --text "how long is left in this?"
  clawtv search --query "john oliver" [--type episode]
  clawtv list-shows [--limit 20]
  clawtv list-collections [--limit 20]
  clawtv list-networks [--limit 20]
  clawtv list-network-shows --network "HGTV" [--limit 20]
  clawtv recently-added [--type movie] [--limit 10]
  clawtv recommend-show --show "Seinfeld" [--strategy default|random|highly-rated] [--limit 3]
  clawtv sync-status
  clawtv sync-plex --mode full-sync [--library "TV Shows"]
  clawtv check-new-content [--library "TV Shows"] [--limit 10]
  clawtv play --title "The Matrix"
  clawtv play-latest --series "The Late Show with Stephen Colbert"
  clawtv shuffle --show "Bluey"
  clawtv shuffle --network "HGTV"
  clawtv shuffle --collection "HGTV"
  clawtv pause
  clawtv resume
  clawtv seek --by 30s
  clawtv seek --by -2m
  clawtv seek --forward 90s
  clawtv seek --back 15s
  clawtv seek --to 12:34
  clawtv refresh
  clawtv next
  clawtv stop

Environment:
  CLAWTV_SERVER_ORIGIN=${serverOrigin}`);
}

function parseKeyValueFlags(args: string[]): Record<string, string> {
  const payload: Record<string, string> = {};

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    const next = args[index + 1];

    if (current?.startsWith("--") && next) {
      payload[current.slice(2)] = next;
      index += 1;
    }
  }

  return payload;
}

function parseCatalogFlags(args: string[]): {
  query?: string;
  q?: string;
  type?: CatalogMediaTypeFilter;
  limit?: string;
} {
  const flags = parseKeyValueFlags(args);
  const type = parseCatalogMediaType(flags.type);

  return {
    query: flags.query,
    q: flags.q,
    type,
    limit: flags.limit
  };
}

function parseVoiceTurnFlags(args: string[]): {
  transcript?: string;
  playbackState?: PlaybackSnapshot["playbackState"];
} {
  const flags = parseKeyValueFlags(args);
  return {
    transcript: flags.text ?? flags.transcript,
    playbackState: parsePlaybackState(flags["playback-state"])
  };
}

function isCommandName(value: string): value is CommandName {
  return [
    "play",
    "play-latest",
    "shuffle",
    "pause",
    "resume",
    "seek",
    "refresh",
    "next",
    "stop"
  ].includes(value);
}

function parseSeekFlags(args: string[]): SeekCommandRequest {
  const flags = parseKeyValueFlags(args);
  const payload: SeekCommandRequest = {};
  const by = flags.by ? parseDurationToMs(flags.by) : null;
  const forward = flags.forward ? parseDurationToMs(flags.forward) : null;
  const back = flags.back ? parseDurationToMs(flags.back) : null;
  const to = flags.to ? parseClockPositionToMs(flags.to) : null;

  if (typeof by === "number") {
    payload.deltaMs = by;
  } else if (typeof forward === "number") {
    payload.deltaMs = Math.abs(forward);
  } else if (typeof back === "number") {
    payload.deltaMs = -Math.abs(back);
  }

  if (typeof to === "number") {
    payload.positionMs = to;
  }

  return payload;
}

function parseCatalogMediaType(value: string | undefined): CatalogMediaTypeFilter | undefined {
  return value === "show" || value === "season" || value === "episode" || value === "movie"
    ? value
    : undefined;
}

function parsePlaybackState(value: string | undefined): PlaybackSnapshot["playbackState"] | undefined {
  return value === "booting"
    || value === "idle"
    || value === "loading"
    || value === "playing"
    || value === "paused"
    || value === "error"
    ? value
    : undefined;
}

function parseDurationToMs(rawValue: string): number | null {
  const value = rawValue.trim();

  if (!value) {
    return null;
  }

  const match = value.match(/^(-?\d+(?:\.\d+)?)(ms|s|m|h)?$/iu);

  if (!match) {
    return null;
  }

  const numericValue = Number(match[1]);

  if (!Number.isFinite(numericValue)) {
    return null;
  }

  const unit = (match[2] ?? "s").toLowerCase();
  const multiplier = unit === "ms"
    ? 1
    : unit === "m"
      ? 60_000
      : unit === "h"
        ? 3_600_000
        : 1000;

  return Math.round(numericValue * multiplier);
}

function parseClockPositionToMs(rawValue: string): number | null {
  const segments = rawValue
    .trim()
    .split(":")
    .map((segment) => Number(segment));

  if (segments.length === 0 || segments.length > 3 || segments.some((segment) => !Number.isFinite(segment) || segment < 0)) {
    return null;
  }

  const [hours, minutes, seconds] = segments.length === 3
    ? segments
    : segments.length === 2
      ? [0, segments[0], segments[1]]
      : [0, 0, segments[0]];

  return Math.round((((hours * 60) + minutes) * 60 + seconds) * 1000);
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(resolveRelativeUrl(serverOrigin, path));

  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`);
  }

  return response.json() as Promise<T>;
}

function withSearchParams(path: string, params: Record<string, string | undefined>): string {
  const searchParams = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (typeof value === "string" && value.length > 0) {
      searchParams.set(key, value);
    }
  });

  const query = searchParams.toString();
  return query ? `${path}?${query}` : path;
}

async function postJson<T>(path: string, payload: unknown): Promise<T> {
  const response = await fetch(resolveRelativeUrl(serverOrigin, path), {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Request failed with status ${response.status}: ${errorBody}`);
  }

  return response.json() as Promise<T>;
}

function formatPlaybackSummary(playback: PlaybackSnapshot): string {
  if (!playback.currentItem) {
    return playback.playbackState === "idle"
      ? "Nothing is currently playing."
      : `Nothing is currently playing. Receiver state: ${playback.playbackState}.`;
  }

  const item = playback.currentItem;
  const titleParts = [item.showTitle, formatEpisodeTag(item), item.title].filter(Boolean);
  const lines = [
    `Now playing: ${titleParts.join(" - ") || item.title}`,
    `State: ${playback.playbackState}`
  ];
  const remainingRuntime = formatRemainingRuntime(playback.context, item.durationMs, playback.playbackPositionMs);

  if (remainingRuntime) {
    lines.push(`Time left: ${remainingRuntime}`);
  }

  if (item.mediaType === "episode") {
    if (typeof playback.context?.remainingEpisodesInSeason === "number") {
      lines.push(`More episodes after this one in this season: ${playback.context.remainingEpisodesInSeason}`);
    }

    if (typeof playback.context?.remainingSeasonsInShow === "number") {
      lines.push(`More seasons after this one in this show: ${playback.context.remainingSeasonsInShow}`);
    }
  }

  return lines.join("\n");
}

function formatEpisodeTag(item: PlaybackSnapshot["currentItem"]): string | null {
  if (!item || item.mediaType !== "episode") {
    return null;
  }

  if (typeof item.seasonNumber === "number" && typeof item.episodeNumber === "number") {
    return `S${String(item.seasonNumber).padStart(2, "0")}E${String(item.episodeNumber).padStart(2, "0")}`;
  }

  return null;
}

function formatRemainingRuntime(
  context: PlaybackContext | null,
  durationMs: number | null,
  playbackPositionMs: number
): string | null {
  const remainingMs = context?.remainingMs
    ?? (typeof durationMs === "number" ? Math.max(durationMs - playbackPositionMs, 0) : null);

  if (typeof remainingMs !== "number") {
    return null;
  }

  return formatDuration(remainingMs);
}

function formatDuration(valueMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(valueMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }

  return `${seconds}s`;
}

void main();
