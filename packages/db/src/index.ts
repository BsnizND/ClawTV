import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  CatalogCollectionListResponse,
  CatalogCollectionSummary,
  CatalogMediaTypeFilter,
  CatalogRecentResponse,
  CatalogSearchResponse,
  CatalogShowListResponse,
  CatalogShowSummary,
  ClientPlaybackState,
  CommandName,
  CommandResult,
  MediaItemSummary,
  PlaybackMediaItem,
  PlaybackSnapshot,
  ServerStatus,
  SessionSummary,
  SyncMode,
  SyncRunSummary,
  SyncStatus
} from "@clawtv/contracts";

export interface DatabasePaths {
  dataDir: string;
  sqliteFile: string;
  migrationsDir: string;
}

export interface CatalogLibraryRecord {
  id: string;
  plexLibraryKey: string;
  name: string;
  type: string;
  updatedAt: string;
}

export interface CatalogMediaItemRecord {
  id: string;
  plexRatingKey: string;
  libraryId: string;
  mediaType: "show" | "season" | "episode" | "movie";
  title: string;
  sortTitle: string | null;
  summary: string | null;
  originallyAvailableAt: string | null;
  year: number | null;
  durationMs: number | null;
  posterUrl: string | null;
  thumbUrl: string | null;
  addedAt: string | null;
  updatedAt: string;
  showId: string | null;
  seasonId: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  airDate: string | null;
}

export interface CatalogCollectionRecord {
  id: string;
  plexCollectionKey: string;
  libraryId: string;
  title: string;
  updatedAt: string;
  mediaItemIds: string[];
}

export interface CatalogSyncPayload {
  libraries: CatalogLibraryRecord[];
  mediaItems: CatalogMediaItemRecord[];
  collections: CatalogCollectionRecord[];
}

export interface ApplyCommandInput {
  commandName: CommandName;
  payload: Record<string, unknown>;
  source: string;
  sessionId?: string | null;
}

export interface RecordSyncRunInput {
  mode: SyncMode;
  status: SyncStatus;
  librariesSynced: number;
  mediaItemsSynced: number;
  errorMessage?: string | null;
}

export interface ClawTvDatabaseOptions {
  rootDir: string;
  basePath: string;
  dataDir?: string;
}

interface SessionRow {
  id: string;
  session_name: string;
  session_type: "tv";
  client_id: string;
  claimed: number;
  active: number;
  last_seen_at: string;
  status: "connected" | "disconnected";
  player_state: ClientPlaybackState | null;
}

interface MediaRow {
  id: string;
  plex_rating_key?: string;
  title: string;
  media_type: "show" | "season" | "episode" | "movie";
  show_title: string | null;
  summary?: string | null;
  year: number | null;
  originally_available_at: string | null;
  duration_ms?: number | null;
  poster_url?: string | null;
  thumb_url?: string | null;
  season_number?: number | null;
  episode_number?: number | null;
  air_date?: string | null;
}

interface QueueStateRow {
  queue_id: string | null;
  current_queue_item_id: string | null;
  player_state: ClientPlaybackState;
  playback_position_ms: number;
  control_revision: number;
  receiver_command_id: string | null;
  receiver_command_type: string | null;
  receiver_command_at: string | null;
  updated_at: string;
}

interface PlaybackSnapshotRow {
  session_id: string;
  queue_id: string | null;
  current_queue_item_id: string | null;
  player_state: ClientPlaybackState;
  playback_position_ms: number;
  control_revision: number;
  receiver_command_id: string | null;
  receiver_command_type: string | null;
  receiver_command_at: string | null;
  updated_at: string;
  current_queue_position: number | null;
  queue_length: number;
  id: string | null;
  plex_rating_key: string | null;
  title: string | null;
  media_type: "show" | "season" | "episode" | "movie" | null;
  show_title: string | null;
  summary: string | null;
  year: number | null;
  originally_available_at: string | null;
  duration_ms: number | null;
  poster_url: string | null;
  thumb_url: string | null;
  season_number: number | null;
  episode_number: number | null;
  air_date: string | null;
  remaining_ms: number | null;
  total_episodes_in_season: number | null;
  remaining_episodes_in_season: number | null;
  total_seasons_in_show: number | null;
  remaining_seasons_in_show: number | null;
}

interface ShowSummaryRow {
  id: string;
  title: string;
  episode_count: number;
  latest_air_date: string | null;
}

interface CollectionSummaryRow {
  id: string;
  title: string;
  item_count: number;
}

export function createDatabasePaths(rootDir: string, dataDir?: string): DatabasePaths {
  const resolvedDataDir = dataDir ?? join(rootDir, "data");

  return {
    dataDir: resolvedDataDir,
    sqliteFile: join(resolvedDataDir, "clawtv.sqlite"),
    migrationsDir: join(rootDir, "packages", "db", "migrations")
  };
}

export class ClawTvDatabase {
  private readonly db: DatabaseSync;
  private readonly paths: DatabasePaths;
  private readonly basePath: string;

  constructor(options: ClawTvDatabaseOptions) {
    this.paths = createDatabasePaths(options.rootDir, options.dataDir);
    this.basePath = options.basePath;

    mkdirSync(this.paths.dataDir, { recursive: true });
    this.db = new DatabaseSync(this.paths.sqliteFile);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.runMigrations();
    this.ensureDefaultSession();
  }

  close(): void {
    this.db.close();
  }

  getStatus(): ServerStatus {
    const activeSession = this.getActiveSessionRow();
    const counts = this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM sessions) AS session_count,
        (SELECT COUNT(*) FROM libraries) AS libraries_indexed,
        (SELECT COUNT(*) FROM media_items) AS media_items_indexed
    `).get() as {
      session_count: number;
      libraries_indexed: number;
      media_items_indexed: number;
    };
    const lastCommand = this.db.prepare(`
      SELECT command_name, created_at
      FROM command_log
      ORDER BY created_at DESC
      LIMIT 1
    `).get() as { command_name: CommandName; created_at: string } | undefined;
    const lastSync = this.db.prepare(`
      SELECT finished_at, status
      FROM sync_runs
      ORDER BY started_at DESC
      LIMIT 1
    `).get() as { finished_at: string | null; status: SyncStatus } | undefined;

    return {
      service: "clawtv-server",
      environment: process.env.NODE_ENV ?? "development",
      basePath: this.basePath,
      activeSessionId: activeSession?.id ?? null,
      sessionCount: counts.session_count,
      playbackState: activeSession?.player_state ?? "idle",
      lastCommandName: lastCommand?.command_name ?? null,
      lastCommandAt: lastCommand?.created_at ?? null,
      catalog: {
        librariesIndexed: counts.libraries_indexed,
        mediaItemsIndexed: counts.media_items_indexed,
        lastSyncAt: lastSync?.finished_at ?? null,
        lastSyncStatus: lastSync?.status ?? null
      }
    };
  }

  listSessions(): SessionSummary[] {
    const rows = this.db.prepare(`
      SELECT
        s.id,
        s.session_name,
        s.session_type,
        s.client_id,
        s.claimed,
        s.active,
        s.last_seen_at,
        s.status,
        ps.player_state
      FROM sessions s
      LEFT JOIN playback_state ps ON ps.session_id = s.id
      ORDER BY s.active DESC, s.session_name ASC
    `).all() as unknown as SessionRow[];

    return rows.map((row) => ({
      id: row.id,
      sessionName: row.session_name,
      sessionType: row.session_type,
      clientId: row.client_id,
      claimed: Boolean(row.claimed),
      active: Boolean(row.active),
      lastSeenAt: row.last_seen_at,
      status: row.status,
      playbackState: row.player_state ?? "idle"
    }));
  }

  getLatestSyncRun(): SyncRunSummary | null {
    const row = this.db.prepare(`
      SELECT id, mode, status, started_at, finished_at, libraries_synced, media_items_synced, error_message
      FROM sync_runs
      ORDER BY started_at DESC
      LIMIT 1
    `).get() as {
      id: string;
      mode: SyncMode;
      status: SyncStatus;
      started_at: string;
      finished_at: string | null;
      libraries_synced: number;
      media_items_synced: number;
      error_message: string | null;
    } | undefined;

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      mode: row.mode,
      status: row.status,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      librariesSynced: row.libraries_synced,
      mediaItemsSynced: row.media_items_synced,
      errorMessage: row.error_message
    };
  }

  getPlaybackSnapshot(sessionId?: string | null): PlaybackSnapshot {
    const session = this.getTargetSession(sessionId);

    if (!session) {
      return {
        sessionId: null,
        queueId: null,
        playbackState: "idle",
        playbackPositionMs: 0,
        controlRevision: 0,
      receiverCommand: null,
      updatedAt: null,
      queueLength: 0,
      currentQueuePosition: null,
      currentItem: null,
      context: null,
      streamPath: null,
      diagnostics: null
    };
  }

    const row = this.db.prepare(`
      SELECT
        ps.session_id,
        ps.queue_id,
        ps.current_queue_item_id,
        ps.player_state,
        ps.playback_position_ms,
        ps.control_revision,
        ps.receiver_command_id,
        ps.receiver_command_type,
        ps.receiver_command_at,
        ps.updated_at,
        current_qi.position AS current_queue_position,
        COALESCE(queue_counts.queue_length, 0) AS queue_length,
        mi.id,
        mi.plex_rating_key,
        mi.title,
        mi.media_type,
        show_mi.title AS show_title,
        mi.summary,
        mi.year,
        mi.originally_available_at,
        mi.duration_ms,
        mi.poster_url,
        mi.thumb_url,
        COALESCE(episode_season.season_number, season.season_number) AS season_number,
        e.episode_number,
        e.air_date,
        CASE
          WHEN mi.duration_ms IS NULL THEN NULL
          WHEN mi.duration_ms - ps.playback_position_ms < 0 THEN 0
          ELSE mi.duration_ms - ps.playback_position_ms
        END AS remaining_ms,
        CASE
          WHEN e.season_id IS NULL THEN NULL
          ELSE (
            SELECT COUNT(*)
            FROM episodes season_episode
            WHERE season_episode.season_id = e.season_id
          )
        END AS total_episodes_in_season,
        CASE
          WHEN e.season_id IS NULL OR e.episode_number IS NULL THEN NULL
          ELSE (
            SELECT COUNT(*)
            FROM episodes season_episode
            WHERE season_episode.season_id = e.season_id
              AND season_episode.episode_number > e.episode_number
          )
        END AS remaining_episodes_in_season,
        CASE
          WHEN COALESCE(e.show_id, season.show_id) IS NULL THEN NULL
          ELSE (
            SELECT COUNT(*)
            FROM seasons show_season
            WHERE show_season.show_id = COALESCE(e.show_id, season.show_id)
          )
        END AS total_seasons_in_show,
        CASE
          WHEN COALESCE(e.show_id, season.show_id) IS NULL
            OR COALESCE(episode_season.season_number, season.season_number) IS NULL THEN NULL
          ELSE (
            SELECT COUNT(*)
            FROM seasons show_season
            WHERE show_season.show_id = COALESCE(e.show_id, season.show_id)
              AND show_season.season_number > COALESCE(episode_season.season_number, season.season_number)
          )
        END AS remaining_seasons_in_show
      FROM playback_state ps
      LEFT JOIN queue_items current_qi ON current_qi.id = ps.current_queue_item_id
      LEFT JOIN (
        SELECT queue_id, COUNT(*) AS queue_length
        FROM queue_items
        GROUP BY queue_id
      ) queue_counts ON queue_counts.queue_id = ps.queue_id
      LEFT JOIN media_items mi ON mi.id = current_qi.media_item_id
      LEFT JOIN episodes e ON e.media_item_id = mi.id
      LEFT JOIN seasons episode_season ON episode_season.media_item_id = e.season_id
      LEFT JOIN seasons season ON season.media_item_id = mi.id
      LEFT JOIN media_items show_mi ON show_mi.id = COALESCE(e.show_id, season.show_id)
      WHERE ps.session_id = :sessionId
      LIMIT 1
    `).get({ sessionId: session.id }) as unknown as PlaybackSnapshotRow | undefined;

    if (!row) {
      return {
        sessionId: session.id,
        queueId: null,
        playbackState: "idle",
        playbackPositionMs: 0,
        controlRevision: 0,
        receiverCommand: null,
        updatedAt: null,
        queueLength: 0,
        currentQueuePosition: null,
        currentItem: null,
        context: null,
        streamPath: null,
        diagnostics: null
      };
    }

    return {
      sessionId: row.session_id,
      queueId: row.queue_id,
      playbackState: row.player_state,
      playbackPositionMs: row.playback_position_ms,
      controlRevision: row.control_revision,
      receiverCommand: row.receiver_command_id && row.receiver_command_type && row.receiver_command_at
        ? {
            id: row.receiver_command_id,
            type: row.receiver_command_type === "refresh" ? "refresh" : "refresh",
            issuedAt: row.receiver_command_at
          }
        : null,
      updatedAt: row.updated_at,
      queueLength: row.queue_length,
      currentQueuePosition: row.current_queue_position,
      currentItem: row.id && row.plex_rating_key && row.title && row.media_type
        ? {
            id: row.id,
            plexRatingKey: row.plex_rating_key,
            title: row.title,
            mediaType: row.media_type,
            showTitle: row.show_title,
            summary: row.summary,
            year: row.year,
            originallyAvailableAt: row.originally_available_at,
            durationMs: row.duration_ms,
            posterUrl: row.poster_url,
            thumbUrl: row.thumb_url,
            seasonNumber: row.season_number,
            episodeNumber: row.episode_number,
            airDate: row.air_date
          }
        : null,
      context: row.id
        ? {
            remainingMs: row.remaining_ms,
            totalEpisodesInSeason: row.total_episodes_in_season,
            remainingEpisodesInSeason: row.remaining_episodes_in_season,
            totalSeasonsInShow: row.total_seasons_in_show,
            remainingSeasonsInShow: row.remaining_seasons_in_show
          }
        : null,
      streamPath: null,
      diagnostics: null
    };
  }

  searchCatalog(input: {
    query: string;
    mediaType?: CatalogMediaTypeFilter;
    limit?: number;
  }): CatalogSearchResponse {
    const query = input.query.trim();
    const mediaType = input.mediaType ?? "any";
    const limit = clampCatalogLimit(input.limit);

    if (!query) {
      return {
        query,
        mediaType,
        items: []
      };
    }

    const mediaTypeFilter = mediaType === "any" ? null : mediaType;
    const rows = this.db.prepare(`
      SELECT
        mi.id,
        mi.title,
        mi.media_type,
        show_mi.title AS show_title,
        mi.year,
        mi.originally_available_at
      FROM media_items mi
      LEFT JOIN episodes e ON e.media_item_id = mi.id
      LEFT JOIN media_items show_mi ON show_mi.id = e.show_id
      WHERE (
        lower(mi.title) LIKE lower(:queryPattern)
        OR lower(COALESCE(show_mi.title, '')) LIKE lower(:queryPattern)
        OR lower(COALESCE(mi.summary, '')) LIKE lower(:queryPattern)
      )
        AND (:mediaType IS NULL OR mi.media_type = :mediaType)
      ORDER BY
        CASE
          WHEN lower(mi.title) = lower(:query) THEN 0
          WHEN lower(COALESCE(show_mi.title, '')) = lower(:query) THEN 1
          WHEN lower(mi.title) LIKE lower(:queryPrefix) THEN 2
          WHEN lower(COALESCE(show_mi.title, '')) LIKE lower(:queryPrefix) THEN 3
          ELSE 4
        END,
        COALESCE(mi.originally_available_at, '') DESC,
        mi.title ASC
      LIMIT :limit
    `).all({
      query,
      queryPattern: `%${query}%`,
      queryPrefix: `${query}%`,
      mediaType: mediaTypeFilter,
      limit
    }) as unknown as MediaRow[];

    return {
      query,
      mediaType,
      items: rows.map(mapMediaRow)
    };
  }

  listShows(limit?: number): CatalogShowListResponse {
    const rows = this.db.prepare(`
      SELECT
        show_mi.id,
        show_mi.title,
        COUNT(e.media_item_id) AS episode_count,
        MAX(COALESCE(e.air_date, episode_mi.originally_available_at)) AS latest_air_date
      FROM shows s
      JOIN media_items show_mi ON show_mi.id = s.media_item_id
      LEFT JOIN episodes e ON e.show_id = s.media_item_id
      LEFT JOIN media_items episode_mi ON episode_mi.id = e.media_item_id
      GROUP BY show_mi.id, show_mi.title
      ORDER BY show_mi.title ASC
      LIMIT :limit
    `).all({
      limit: clampCatalogLimit(limit)
    }) as unknown as ShowSummaryRow[];

    return {
      shows: rows.map((row) => mapShowSummaryRow(row))
    };
  }

  listCollections(limit?: number): CatalogCollectionListResponse {
    const rows = this.db.prepare(`
      SELECT
        c.id,
        c.title,
        COUNT(ci.media_item_id) AS item_count
      FROM collections c
      LEFT JOIN collection_items ci ON ci.collection_id = c.id
      GROUP BY c.id, c.title
      ORDER BY c.title ASC
      LIMIT :limit
    `).all({
      limit: clampCatalogLimit(limit)
    }) as unknown as CollectionSummaryRow[];

    return {
      collections: rows.map((row) => mapCollectionSummaryRow(row))
    };
  }

  listRecentlyAdded(input?: {
    mediaType?: CatalogMediaTypeFilter;
    limit?: number;
  }): CatalogRecentResponse {
    const mediaType = input?.mediaType ?? "any";
    const mediaTypeFilter = mediaType === "any" ? null : mediaType;
    const rows = this.db.prepare(`
      SELECT
        mi.id,
        mi.title,
        mi.media_type,
        show_mi.title AS show_title,
        mi.year,
        mi.originally_available_at
      FROM media_items mi
      LEFT JOIN episodes e ON e.media_item_id = mi.id
      LEFT JOIN media_items show_mi ON show_mi.id = e.show_id
      WHERE (:mediaType IS NULL OR mi.media_type = :mediaType)
      ORDER BY
        COALESCE(mi.added_at, mi.updated_at, mi.originally_available_at) DESC,
        mi.title ASC
      LIMIT :limit
    `).all({
      mediaType: mediaTypeFilter,
      limit: clampCatalogLimit(input?.limit)
    }) as unknown as MediaRow[];

    return {
      mediaType,
      items: rows.map(mapMediaRow)
    };
  }

  setClientPlaybackState(
    state: ClientPlaybackState | undefined,
    options?: {
      sessionId?: string | null;
      positionMs?: number | null;
    }
  ): PlaybackSnapshot {
    const session = this.getTargetSession(options?.sessionId);

    if (!session) {
      return this.getPlaybackSnapshot(null);
    }

    const now = new Date().toISOString();
    const currentState = this.getQueueState(session.id);
    const requestedState = state ?? currentState.player_state;
    const playbackState = currentState.current_queue_item_id ? requestedState : "idle";

    this.db.prepare(`
      UPDATE playback_state
      SET
        player_state = :playerState,
        playback_position_ms = :playbackPositionMs,
        updated_at = :updatedAt
      WHERE session_id = :sessionId
    `).run({
      sessionId: session.id,
      playerState: playbackState,
      playbackPositionMs: options?.positionMs ?? currentState.playback_position_ms,
      updatedAt: now
    });

    this.db.prepare(`
      UPDATE sessions
      SET last_seen_at = :lastSeenAt
      WHERE id = :sessionId
    `).run({
      sessionId: session.id,
      lastSeenAt: now
    });

    return this.getPlaybackSnapshot(session.id);
  }

  clearReceiverCommand(sessionId?: string | null, commandId?: string | null): PlaybackSnapshot {
    const session = this.getTargetSession(sessionId);

    if (!session) {
      return this.getPlaybackSnapshot(null);
    }

    const currentState = this.getQueueState(session.id);

    if (!currentState.receiver_command_id || (commandId && currentState.receiver_command_id !== commandId)) {
      return this.getPlaybackSnapshot(session.id);
    }

    const now = new Date().toISOString();

    this.db.prepare(`
      UPDATE playback_state
      SET
        receiver_command_id = NULL,
        receiver_command_type = NULL,
        receiver_command_at = NULL,
        updated_at = :updatedAt
      WHERE session_id = :sessionId
    `).run({
      sessionId: session.id,
      updatedAt: now
    });

    this.db.prepare(`
      UPDATE sessions
      SET last_seen_at = :lastSeenAt
      WHERE id = :sessionId
    `).run({
      sessionId: session.id,
      lastSeenAt: now
    });

    return this.getPlaybackSnapshot(session.id);
  }

  applyCommand(input: ApplyCommandInput): CommandResult {
    const session = this.getTargetSession(input.sessionId);
    const acceptedAt = new Date().toISOString();

    if (!session) {
      return this.finishCommand({
        commandName: input.commandName,
        acceptedAt,
        message: "No active TV session is available.",
        ok: false,
        playbackState: "error",
        queueId: null,
        matchedItems: [],
        source: input.source,
        sessionId: null,
        payload: input.payload
      });
    }

    if (input.commandName === "pause") {
      this.updatePlaybackState(session.id, "paused", {
        incrementControlRevision: true
      });
      return this.finishCommand({
        commandName: input.commandName,
        acceptedAt,
        message: "Playback paused.",
        ok: true,
        playbackState: "paused",
        queueId: this.getQueueState(session.id).queue_id,
        matchedItems: [],
        source: input.source,
        sessionId: session.id,
        payload: input.payload
      });
    }

    if (input.commandName === "resume") {
      const queueState = this.getQueueState(session.id);
      const playbackState = queueState.current_queue_item_id ? "playing" : "idle";
      this.updatePlaybackState(session.id, playbackState, {
        incrementControlRevision: true
      });
      return this.finishCommand({
        commandName: input.commandName,
        acceptedAt,
        message: queueState.current_queue_item_id ? "Playback resumed." : "Nothing is queued yet.",
        ok: Boolean(queueState.current_queue_item_id),
        playbackState,
        queueId: queueState.queue_id,
        matchedItems: [],
        source: input.source,
        sessionId: session.id,
        payload: input.payload
      });
    }

    if (input.commandName === "stop") {
      this.updatePlaybackState(session.id, "idle", {
        clearCurrentQueueItem: true,
        positionMs: 0,
        incrementControlRevision: true
      });
      return this.finishCommand({
        commandName: input.commandName,
        acceptedAt,
        message: "Playback stopped.",
        ok: true,
        playbackState: "idle",
        queueId: this.getQueueState(session.id).queue_id,
        matchedItems: [],
        source: input.source,
        sessionId: session.id,
        payload: input.payload
      });
    }

    if (input.commandName === "next") {
      const queueState = this.getQueueState(session.id);

      if (!queueState.queue_id || !queueState.current_queue_item_id) {
        return this.finishCommand({
          commandName: input.commandName,
          acceptedAt,
          message: "No queue is active yet.",
          ok: false,
          playbackState: "idle",
          queueId: queueState.queue_id,
          matchedItems: [],
          source: input.source,
          sessionId: session.id,
          payload: input.payload
        });
      }

      const nextQueueItem = this.db.prepare(`
        SELECT qi.id, qi.media_item_id
        FROM queue_items qi
        JOIN queue_items current_qi ON current_qi.id = :currentQueueItemId
        WHERE qi.queue_id = :queueId
          AND qi.position > current_qi.position
        ORDER BY qi.position ASC
        LIMIT 1
      `).get({
        currentQueueItemId: queueState.current_queue_item_id,
        queueId: queueState.queue_id
      }) as unknown as { id: string; media_item_id: string | null } | undefined;

      if (!nextQueueItem) {
        this.updatePlaybackState(session.id, "idle", {
          clearCurrentQueueItem: true,
          positionMs: 0,
          incrementControlRevision: true
        });
        return this.finishCommand({
          commandName: input.commandName,
          acceptedAt,
          message: "Reached the end of the queue.",
          ok: true,
          playbackState: "idle",
          queueId: queueState.queue_id,
          matchedItems: [],
          source: input.source,
          sessionId: session.id,
          payload: input.payload
        });
      }

      this.updatePlaybackState(session.id, "loading", {
        currentQueueItemId: nextQueueItem.id,
        positionMs: 0,
        incrementControlRevision: true
      });

      return this.finishCommand({
        commandName: input.commandName,
        acceptedAt,
        message: "Advanced to the next queued item.",
        ok: true,
        playbackState: "loading",
        queueId: queueState.queue_id,
        matchedItems: this.lookupMediaItemsByIds([nextQueueItem.media_item_id].filter(Boolean) as string[]),
        source: input.source,
        sessionId: session.id,
        payload: input.payload
      });
    }

    if (input.commandName === "seek") {
      const queueState = this.getQueueState(session.id);

      if (!queueState.current_queue_item_id) {
        return this.finishCommand({
          commandName: input.commandName,
          acceptedAt,
          message: "Nothing is currently playing, so there is nowhere to seek.",
          ok: false,
          playbackState: "idle",
          queueId: queueState.queue_id,
          matchedItems: [],
          source: input.source,
          sessionId: session.id,
          payload: input.payload
        });
      }

      const currentSnapshot = this.getPlaybackSnapshot(session.id);
      const targetPositionMs = resolveTargetPlaybackPosition({
        currentPositionMs: queueState.playback_position_ms,
        durationMs: currentSnapshot.currentItem?.durationMs ?? null,
        payload: input.payload
      });

      if (targetPositionMs === null) {
        return this.finishCommand({
          commandName: input.commandName,
          acceptedAt,
          message: "Provide a seek target like --by 30s, --by -2m, --forward 90s, --back 15s, or --to 12:34.",
          ok: false,
          playbackState: queueState.player_state,
          queueId: queueState.queue_id,
          matchedItems: currentSnapshot.currentItem ? [mapPlaybackItemToMediaSummary(currentSnapshot.currentItem)] : [],
          source: input.source,
          sessionId: session.id,
          payload: input.payload
        });
      }

      this.updatePlaybackState(session.id, queueState.player_state, {
        positionMs: targetPositionMs,
        incrementControlRevision: true
      });

      return this.finishCommand({
        commandName: input.commandName,
        acceptedAt,
        message: `Seeked to ${formatPlaybackPosition(targetPositionMs)}.`,
        ok: true,
        playbackState: queueState.player_state,
        queueId: queueState.queue_id,
        matchedItems: currentSnapshot.currentItem ? [mapPlaybackItemToMediaSummary(currentSnapshot.currentItem)] : [],
        source: input.source,
        sessionId: session.id,
        payload: input.payload
      });
    }

    if (input.commandName === "refresh") {
      const queueState = this.getQueueState(session.id);
      this.issueReceiverCommand(session.id, "refresh");

      return this.finishCommand({
        commandName: input.commandName,
        acceptedAt,
        message: "Requested a receiver refresh.",
        ok: true,
        playbackState: queueState.player_state,
        queueId: queueState.queue_id,
        matchedItems: [],
        source: input.source,
        sessionId: session.id,
        payload: input.payload
      });
    }

    const matchedItems = this.resolveMediaItems(input.commandName, input.payload);

    if (matchedItems.length === 0) {
      return this.finishCommand({
        commandName: input.commandName,
        acceptedAt,
        message: "No matching media items were found in the local catalog. Run a Plex sync first or refine the request.",
        ok: false,
        playbackState: this.getQueueState(session.id).player_state,
        queueId: this.getQueueState(session.id).queue_id,
        matchedItems: [],
        source: input.source,
        sessionId: session.id,
        payload: input.payload
      });
    }

    const queueId = randomUUID();
    const createdAt = new Date().toISOString();

    this.db.exec("BEGIN");

    try {
      this.db.prepare(`
        INSERT INTO queues (id, session_id, created_at, created_by, mode)
        VALUES (:id, :sessionId, :createdAt, :createdBy, :mode)
      `).run({
        id: queueId,
        sessionId: session.id,
        createdAt,
        createdBy: input.source,
        mode: input.commandName
      });

      const insertQueueItem = this.db.prepare(`
        INSERT INTO queue_items (
          id,
          queue_id,
          media_item_id,
          position,
          origin_reason,
          requested_title,
          created_at
        ) VALUES (
          :id,
          :queueId,
          :mediaItemId,
          :position,
          :originReason,
          :requestedTitle,
          :createdAt
        )
      `);

      matchedItems.forEach((item, index) => {
        insertQueueItem.run({
          id: randomUUID(),
          queueId,
          mediaItemId: item.id,
          position: index,
          originReason: input.commandName,
          requestedTitle: String(input.payload.title ?? input.payload.series ?? input.payload.collection ?? ""),
          createdAt
        });
      });

      const firstQueueItem = this.db.prepare(`
        SELECT id
        FROM queue_items
        WHERE queue_id = :queueId
        ORDER BY position ASC
        LIMIT 1
      `).get({ queueId }) as unknown as { id: string };

      this.updatePlaybackState(session.id, "loading", {
        queueId,
        currentQueueItemId: firstQueueItem.id,
        positionMs: 0,
        incrementControlRevision: true
      });

      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    return this.finishCommand({
      commandName: input.commandName,
      acceptedAt,
      message: `Queued ${matchedItems.length} item${matchedItems.length === 1 ? "" : "s"}.`,
      ok: true,
      playbackState: "loading",
      queueId,
      matchedItems,
      source: input.source,
      sessionId: session.id,
      payload: input.payload
    });
  }

  applyCatalogSync(payload: CatalogSyncPayload, syncRun: RecordSyncRunInput): SyncRunSummary {
    const syncRunId = randomUUID();
    const startedAt = new Date().toISOString();

    this.db.exec("BEGIN");

    try {
      const insertSyncRun = this.db.prepare(`
        INSERT INTO sync_runs (
          id,
          mode,
          status,
          started_at,
          finished_at,
          libraries_synced,
          media_items_synced,
          error_message,
          details_json
        ) VALUES (
          :id,
          :mode,
          :status,
          :startedAt,
          :finishedAt,
          :librariesSynced,
          :mediaItemsSynced,
          :errorMessage,
          :detailsJson
        )
      `);

      insertSyncRun.run({
        id: syncRunId,
        mode: syncRun.mode,
        status: syncRun.status,
        startedAt,
        finishedAt: startedAt,
        librariesSynced: syncRun.librariesSynced,
        mediaItemsSynced: syncRun.mediaItemsSynced,
        errorMessage: syncRun.errorMessage ?? null,
        detailsJson: JSON.stringify({
          libraries: payload.libraries.length,
          mediaItems: payload.mediaItems.length,
          collections: payload.collections.length
        })
      });

      const upsertLibrary = this.db.prepare(`
        INSERT INTO libraries (id, plex_library_key, name, type, updated_at)
        VALUES (:id, :plexLibraryKey, :name, :type, :updatedAt)
        ON CONFLICT(id) DO UPDATE SET
          plex_library_key = excluded.plex_library_key,
          name = excluded.name,
          type = excluded.type,
          updated_at = excluded.updated_at
      `);
      const upsertMediaItem = this.db.prepare(`
        INSERT INTO media_items (
          id,
          plex_rating_key,
          library_id,
          media_type,
          title,
          sort_title,
          summary,
          originally_available_at,
          year,
          duration_ms,
          poster_url,
          thumb_url,
          added_at,
          updated_at
        ) VALUES (
          :id,
          :plexRatingKey,
          :libraryId,
          :mediaType,
          :title,
          :sortTitle,
          :summary,
          :originallyAvailableAt,
          :year,
          :durationMs,
          :posterUrl,
          :thumbUrl,
          :addedAt,
          :updatedAt
        )
        ON CONFLICT(id) DO UPDATE SET
          plex_rating_key = excluded.plex_rating_key,
          library_id = excluded.library_id,
          media_type = excluded.media_type,
          title = excluded.title,
          sort_title = excluded.sort_title,
          summary = excluded.summary,
          originally_available_at = excluded.originally_available_at,
          year = excluded.year,
          duration_ms = excluded.duration_ms,
          poster_url = excluded.poster_url,
          thumb_url = excluded.thumb_url,
          added_at = excluded.added_at,
          updated_at = excluded.updated_at
      `);
      const upsertShow = this.db.prepare(`
        INSERT INTO shows (media_item_id)
        VALUES (:mediaItemId)
        ON CONFLICT(media_item_id) DO NOTHING
      `);
      const upsertSeason = this.db.prepare(`
        INSERT INTO seasons (media_item_id, show_id, season_number)
        VALUES (:mediaItemId, :showId, :seasonNumber)
        ON CONFLICT(media_item_id) DO UPDATE SET
          show_id = excluded.show_id,
          season_number = excluded.season_number
      `);
      const upsertEpisode = this.db.prepare(`
        INSERT INTO episodes (media_item_id, show_id, season_id, episode_number, air_date)
        VALUES (:mediaItemId, :showId, :seasonId, :episodeNumber, :airDate)
        ON CONFLICT(media_item_id) DO UPDATE SET
          show_id = excluded.show_id,
          season_id = excluded.season_id,
          episode_number = excluded.episode_number,
          air_date = excluded.air_date
      `);
      const upsertMovie = this.db.prepare(`
        INSERT INTO movies (media_item_id)
        VALUES (:mediaItemId)
        ON CONFLICT(media_item_id) DO NOTHING
      `);
      const upsertCollection = this.db.prepare(`
        INSERT INTO collections (id, plex_collection_key, library_id, title, updated_at)
        VALUES (:id, :plexCollectionKey, :libraryId, :title, :updatedAt)
        ON CONFLICT(id) DO UPDATE SET
          plex_collection_key = excluded.plex_collection_key,
          library_id = excluded.library_id,
          title = excluded.title,
          updated_at = excluded.updated_at
      `);
      const deleteCollectionItems = this.db.prepare(`
        DELETE FROM collection_items WHERE collection_id = :collectionId
      `);
      const insertCollectionItem = this.db.prepare(`
        INSERT INTO collection_items (collection_id, media_item_id)
        VALUES (:collectionId, :mediaItemId)
      `);

      payload.libraries.forEach((library) => upsertLibrary.run({
        id: library.id,
        plexLibraryKey: library.plexLibraryKey,
        name: library.name,
        type: library.type,
        updatedAt: library.updatedAt
      }));

      payload.mediaItems.forEach((item) => {
        upsertMediaItem.run({
          id: item.id,
          plexRatingKey: item.plexRatingKey,
          libraryId: item.libraryId,
          mediaType: item.mediaType,
          title: item.title,
          sortTitle: item.sortTitle,
          summary: item.summary,
          originallyAvailableAt: item.originallyAvailableAt,
          year: item.year,
          durationMs: item.durationMs,
          posterUrl: item.posterUrl,
          thumbUrl: item.thumbUrl,
          addedAt: item.addedAt,
          updatedAt: item.updatedAt
        });

        if (item.mediaType === "show") {
          upsertShow.run({ mediaItemId: item.id });
        }

        if (item.mediaType === "season") {
          upsertSeason.run({
            mediaItemId: item.id,
            showId: item.showId,
            seasonNumber: item.seasonNumber
          });
        }

        if (item.mediaType === "episode") {
          upsertEpisode.run({
            mediaItemId: item.id,
            showId: item.showId,
            seasonId: item.seasonId,
            episodeNumber: item.episodeNumber,
            airDate: item.airDate
          });
        }

        if (item.mediaType === "movie") {
          upsertMovie.run({ mediaItemId: item.id });
        }
      });

      payload.collections.forEach((collection) => {
        upsertCollection.run({
          id: collection.id,
          plexCollectionKey: collection.plexCollectionKey,
          libraryId: collection.libraryId,
          title: collection.title,
          updatedAt: collection.updatedAt
        });
        deleteCollectionItems.run({ collectionId: collection.id });

        collection.mediaItemIds.forEach((mediaItemId) => {
          insertCollectionItem.run({
            collectionId: collection.id,
            mediaItemId
          });
        });
      });

      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    return this.getLatestSyncRun()!;
  }

  recordFailedSyncRun(syncRun: RecordSyncRunInput): SyncRunSummary {
    const id = randomUUID();
    const finishedAt = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO sync_runs (
        id,
        mode,
        status,
        started_at,
        finished_at,
        libraries_synced,
        media_items_synced,
        error_message,
        details_json
      ) VALUES (
        :id,
        :mode,
        :status,
        :startedAt,
        :finishedAt,
        :librariesSynced,
        :mediaItemsSynced,
        :errorMessage,
        :detailsJson
      )
    `).run({
      id,
      mode: syncRun.mode,
      status: syncRun.status,
      startedAt: finishedAt,
      finishedAt,
      librariesSynced: syncRun.librariesSynced,
      mediaItemsSynced: syncRun.mediaItemsSynced,
      errorMessage: syncRun.errorMessage ?? null,
      detailsJson: JSON.stringify({ failed: true })
    });

    return this.getLatestSyncRun()!;
  }

  private runMigrations(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
    `);

    if (!existsSync(this.paths.migrationsDir)) {
      return;
    }

    const appliedMigrations = new Set(
      (this.db.prepare("SELECT id FROM schema_migrations").all() as unknown as { id: string }[]).map((row) => row.id)
    );
    const migrationFiles = readdirSync(this.paths.migrationsDir)
      .filter((fileName) => fileName.endsWith(".sql"))
      .sort();

    migrationFiles.forEach((fileName) => {
      if (appliedMigrations.has(fileName)) {
        return;
      }

      const sql = readFileSync(join(this.paths.migrationsDir, fileName), "utf8");
      this.db.exec("BEGIN");

      try {
        this.db.exec(sql);
        this.db.prepare(`
          INSERT INTO schema_migrations (id, applied_at)
          VALUES (:id, :appliedAt)
        `).run({
          id: fileName,
          appliedAt: new Date().toISOString()
        });
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  private ensureDefaultSession(): void {
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO sessions (
        id,
        session_name,
        session_type,
        client_id,
        claimed,
        active,
        last_seen_at,
        status
      ) VALUES (
        'living-room-shield',
        'Living Room Shield',
        'tv',
        'shield-web-client',
        1,
        1,
        :now,
        'connected'
      )
      ON CONFLICT(id) DO UPDATE SET
        session_name = excluded.session_name,
        session_type = excluded.session_type,
        client_id = excluded.client_id,
        claimed = excluded.claimed,
        active = excluded.active,
        status = excluded.status
    `).run({ now });

    this.db.prepare(`
      INSERT INTO playback_state (
        session_id,
        queue_id,
        current_queue_item_id,
        player_state,
        playback_position_ms,
        control_revision,
        receiver_command_id,
        receiver_command_type,
        receiver_command_at,
        updated_at
      ) VALUES (
        'living-room-shield',
        NULL,
        NULL,
        'idle',
        0,
        0,
        NULL,
        NULL,
        NULL,
        :now
      )
      ON CONFLICT(session_id) DO NOTHING
    `).run({ now });
  }

  private getActiveSessionRow(): SessionRow | undefined {
    return this.db.prepare(`
      SELECT
        s.id,
        s.session_name,
        s.session_type,
        s.client_id,
        s.claimed,
        s.active,
        s.last_seen_at,
        s.status,
        ps.player_state
      FROM sessions s
      LEFT JOIN playback_state ps ON ps.session_id = s.id
      WHERE s.active = 1
      LIMIT 1
    `).get() as unknown as SessionRow | undefined;
  }

  private getTargetSession(sessionId?: string | null): SessionRow | undefined {
    if (sessionId) {
      return this.db.prepare(`
        SELECT
          s.id,
          s.session_name,
          s.session_type,
          s.client_id,
          s.claimed,
          s.active,
          s.last_seen_at,
          s.status,
          ps.player_state
        FROM sessions s
        LEFT JOIN playback_state ps ON ps.session_id = s.id
        WHERE s.id = :sessionId
        LIMIT 1
      `).get({ sessionId }) as unknown as SessionRow | undefined;
    }

    return this.getActiveSessionRow();
  }

  private getQueueState(sessionId: string): QueueStateRow {
    return this.db.prepare(`
      SELECT
        queue_id,
        current_queue_item_id,
        player_state,
        playback_position_ms,
        control_revision,
        receiver_command_id,
        receiver_command_type,
        receiver_command_at,
        updated_at
      FROM playback_state
      WHERE session_id = :sessionId
      LIMIT 1
    `).get({ sessionId }) as unknown as QueueStateRow;
  }

  private updatePlaybackState(
    sessionId: string,
    playerState: ClientPlaybackState,
    options?: {
      queueId?: string | null;
      currentQueueItemId?: string | null;
      clearCurrentQueueItem?: boolean;
      positionMs?: number;
      incrementControlRevision?: boolean;
    }
  ): void {
    const now = new Date().toISOString();
    const currentState = this.getQueueState(sessionId);
    const queueId = options?.queueId === undefined ? currentState.queue_id : options.queueId;
    const currentQueueItemId = options?.clearCurrentQueueItem
      ? null
      : options?.currentQueueItemId === undefined
        ? currentState.current_queue_item_id
        : options.currentQueueItemId;
    const playbackPositionMs = options?.positionMs === undefined
      ? (playerState === "idle" ? 0 : currentState.playback_position_ms)
      : Math.max(0, Math.round(options.positionMs));
    const controlRevision = options?.incrementControlRevision
      ? currentState.control_revision + 1
      : currentState.control_revision;

    this.db.prepare(`
      UPDATE playback_state
      SET
        queue_id = :queueId,
        current_queue_item_id = :currentQueueItemId,
        player_state = :playerState,
        playback_position_ms = :playbackPositionMs,
        control_revision = :controlRevision,
        updated_at = :updatedAt
      WHERE session_id = :sessionId
    `).run({
      sessionId,
      queueId,
      currentQueueItemId,
      playerState,
      playbackPositionMs,
      controlRevision,
      updatedAt: now
    });

    this.db.prepare(`
      UPDATE sessions
      SET last_seen_at = :lastSeenAt
      WHERE id = :sessionId
    `).run({
      sessionId,
      lastSeenAt: now
    });
  }

  private issueReceiverCommand(sessionId: string, commandType: "refresh"): void {
    const now = new Date().toISOString();

    this.db.prepare(`
      UPDATE playback_state
      SET
        receiver_command_id = :commandId,
        receiver_command_type = :commandType,
        receiver_command_at = :commandAt,
        updated_at = :updatedAt
      WHERE session_id = :sessionId
    `).run({
      sessionId,
      commandId: randomUUID(),
      commandType,
      commandAt: now,
      updatedAt: now
    });

    this.db.prepare(`
      UPDATE sessions
      SET last_seen_at = :lastSeenAt
      WHERE id = :sessionId
    `).run({
      sessionId,
      lastSeenAt: now
    });
  }

  private finishCommand(input: {
    commandName: CommandName;
    acceptedAt: string;
    message: string;
    ok: boolean;
    playbackState: ClientPlaybackState;
    queueId: string | null;
    matchedItems: MediaItemSummary[];
    source: string;
    sessionId: string | null;
    payload: Record<string, unknown>;
  }): CommandResult {
    this.db.prepare(`
      INSERT INTO command_log (
        id,
        session_id,
        source,
        command_name,
        payload_json,
        created_at
      ) VALUES (
        :id,
        :sessionId,
        :source,
        :commandName,
        :payloadJson,
        :createdAt
      )
    `).run({
      id: randomUUID(),
      sessionId: input.sessionId,
      source: input.source,
      commandName: input.commandName,
      payloadJson: JSON.stringify(input.payload),
      createdAt: input.acceptedAt
    });

    return {
      ok: input.ok,
      requestId: randomUUID(),
      commandName: input.commandName,
      acceptedAt: input.acceptedAt,
      playbackState: input.playbackState,
      queueId: input.queueId,
      message: input.message,
      matchedItemCount: input.matchedItems.length,
      matchedItems: input.matchedItems
    };
  }

  private resolveMediaItems(commandName: CommandName, payload: Record<string, unknown>): MediaItemSummary[] {
    if (commandName === "play") {
      const title = String(payload.title ?? "").trim();

      if (!title) {
        return [];
      }

      const exactMatches = this.db.prepare(`
        SELECT mi.id, mi.title, mi.media_type, show_mi.title AS show_title, mi.year, mi.originally_available_at
        FROM media_items mi
        LEFT JOIN episodes e ON e.media_item_id = mi.id
        LEFT JOIN media_items show_mi ON show_mi.id = e.show_id
        WHERE lower(mi.title) = lower(:title)
        ORDER BY
          CASE mi.media_type
            WHEN 'movie' THEN 0
            WHEN 'episode' THEN 1
            ELSE 2
          END,
          mi.year DESC
        LIMIT 5
      `).all({ title }) as unknown as MediaRow[];

      if (exactMatches.length > 0) {
        return exactMatches.map(mapMediaRow);
      }

      const fuzzyMatches = this.db.prepare(`
        SELECT mi.id, mi.title, mi.media_type, show_mi.title AS show_title, mi.year, mi.originally_available_at
        FROM media_items mi
        LEFT JOIN episodes e ON e.media_item_id = mi.id
        LEFT JOIN media_items show_mi ON show_mi.id = e.show_id
        WHERE lower(mi.title) LIKE lower(:titlePattern)
        ORDER BY mi.title ASC
        LIMIT 5
      `).all({ titlePattern: `%${title}%` }) as unknown as MediaRow[];

      return fuzzyMatches.map(mapMediaRow);
    }

    if (commandName === "play-latest") {
      const series = String(payload.series ?? "").trim();

      if (!series) {
        return [];
      }

      const matches = this.db.prepare(`
        SELECT
          episode_mi.id,
          episode_mi.title,
          episode_mi.media_type,
          show_mi.title AS show_title,
          episode_mi.year,
          episode_mi.originally_available_at
        FROM episodes e
        JOIN media_items episode_mi ON episode_mi.id = e.media_item_id
        JOIN media_items show_mi ON show_mi.id = e.show_id
        WHERE lower(show_mi.title) = lower(:series)
           OR lower(show_mi.title) LIKE lower(:seriesPattern)
        ORDER BY
          COALESCE(e.air_date, episode_mi.originally_available_at) DESC,
          episode_mi.year DESC,
          e.episode_number DESC
        LIMIT 1
      `).all({
        series,
        seriesPattern: `%${series}%`
      }) as unknown as MediaRow[];

      return matches.map(mapMediaRow);
    }

    if (commandName === "shuffle") {
      const show = String(payload.show ?? "").trim();
      const collection = String(payload.collection ?? "").trim();

      if (show) {
        const matches = this.db.prepare(`
          SELECT
            episode_mi.id,
            episode_mi.title,
            episode_mi.media_type,
            show_mi.title AS show_title,
            episode_mi.year,
            episode_mi.originally_available_at
          FROM episodes e
          JOIN media_items episode_mi ON episode_mi.id = e.media_item_id
          JOIN media_items show_mi ON show_mi.id = e.show_id
          WHERE lower(show_mi.title) = lower(:show)
             OR lower(show_mi.title) LIKE lower(:showPattern)
          ORDER BY RANDOM()
          LIMIT 12
        `).all({
          show,
          showPattern: `%${show}%`
        }) as unknown as MediaRow[];

        return matches.map(mapMediaRow);
      }

      if (collection) {
        const matches = this.db.prepare(`
          SELECT
            mi.id,
            mi.title,
            mi.media_type,
            show_mi.title AS show_title,
            mi.year,
            mi.originally_available_at
          FROM collections c
          JOIN collection_items ci ON ci.collection_id = c.id
          JOIN media_items mi ON mi.id = ci.media_item_id
          LEFT JOIN episodes e ON e.media_item_id = mi.id
          LEFT JOIN media_items show_mi ON show_mi.id = e.show_id
          WHERE lower(c.title) = lower(:collection)
             OR lower(c.title) LIKE lower(:collectionPattern)
          ORDER BY RANDOM()
          LIMIT 12
        `).all({
          collection,
          collectionPattern: `%${collection}%`
        }) as unknown as MediaRow[];

        return matches.map(mapMediaRow);
      }
    }

    return [];
  }

  private lookupMediaItemsByIds(ids: string[]): MediaItemSummary[] {
    if (ids.length === 0) {
      return [];
    }

    const placeholders = ids.map((_, index) => `:id${index}`).join(", ");
    const params = Object.fromEntries(ids.map((id, index) => [`id${index}`, id]));
    const rows = this.db.prepare(`
      SELECT mi.id, mi.title, mi.media_type, show_mi.title AS show_title, mi.year, mi.originally_available_at
      FROM media_items mi
      LEFT JOIN episodes e ON e.media_item_id = mi.id
      LEFT JOIN media_items show_mi ON show_mi.id = e.show_id
      WHERE mi.id IN (${placeholders})
    `).all(params) as unknown as MediaRow[];

    return rows.map(mapMediaRow);
  }
}

export function openClawTvDatabase(options: ClawTvDatabaseOptions): ClawTvDatabase {
  return new ClawTvDatabase(options);
}

function mapMediaRow(row: MediaRow): MediaItemSummary {
  return {
    id: row.id,
    title: row.title,
    mediaType: row.media_type,
    showTitle: row.show_title,
    year: row.year,
    originallyAvailableAt: row.originally_available_at
  };
}

function mapShowSummaryRow(row: ShowSummaryRow): CatalogShowSummary {
  return {
    id: row.id,
    title: row.title,
    episodeCount: row.episode_count,
    latestAirDate: row.latest_air_date
  };
}

function mapCollectionSummaryRow(row: CollectionSummaryRow): CatalogCollectionSummary {
  return {
    id: row.id,
    title: row.title,
    itemCount: row.item_count
  };
}

function mapPlaybackItemToMediaSummary(item: PlaybackMediaItem): MediaItemSummary {
  return {
    id: item.id,
    title: item.title,
    mediaType: item.mediaType,
    showTitle: item.showTitle,
    year: item.year,
    originallyAvailableAt: item.originallyAvailableAt
  };
}

function resolveTargetPlaybackPosition(input: {
  currentPositionMs: number;
  durationMs: number | null;
  payload: Record<string, unknown>;
}): number | null {
  const explicitPosition = parseFiniteNumber(input.payload.positionMs);

  if (explicitPosition !== null) {
    return clampPlaybackPosition(explicitPosition, input.durationMs);
  }

  const explicitDelta = parseFiniteNumber(input.payload.deltaMs);

  if (explicitDelta !== null) {
    return clampPlaybackPosition(input.currentPositionMs + explicitDelta, input.durationMs);
  }

  return null;
}

function clampPlaybackPosition(value: number, durationMs: number | null): number {
  const flooredValue = Math.max(0, Math.round(value));

  if (typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0) {
    return Math.min(flooredValue, durationMs);
  }

  return flooredValue;
}

function parseFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clampCatalogLimit(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 10;
  }

  return Math.max(1, Math.min(50, Math.round(value)));
}

function formatPlaybackPosition(positionMs: number): string {
  const totalSeconds = Math.max(0, Math.round(positionMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
