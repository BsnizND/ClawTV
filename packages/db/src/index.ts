import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  CatalogCollectionListResponse,
  CatalogCollectionSummary,
  CatalogMediaTypeFilter,
  CatalogMovieListResponse,
  CatalogMovieSummary,
  CatalogNetworkListResponse,
  CatalogNetworkShowsResponse,
  CatalogRecommendationResponse,
  CatalogRecentResponse,
  CatalogSearchResponse,
  CatalogShowListResponse,
  CatalogShowSummary,
  ClientPlaybackState,
  CommandName,
  CommandResult,
  EpisodeRecommendation,
  MediaItemSummary,
  PlaybackMediaItem,
  PlaybackSnapshot,
  RecommendationStrategy,
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
  viewCount: number | null;
  lastViewedAt: string | null;
  viewOffsetMs: number | null;
  userRating: number | null;
  audienceRating: number | null;
  criticRating: number | null;
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

export interface CatalogMediaItemTagRecord {
  mediaItemId: string;
  tagType: "network";
  tagKey: string | null;
  tag: string;
}

export interface CatalogSyncPayload {
  libraries: CatalogLibraryRecord[];
  mediaItems: CatalogMediaItemRecord[];
  collections: CatalogCollectionRecord[];
  tags: CatalogMediaItemTagRecord[];
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
  startedAt?: string;
  finishedAt?: string | null;
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
  view_count?: number | null;
  last_viewed_at?: string | null;
  view_offset_ms?: number | null;
  user_rating?: number | null;
  audience_rating?: number | null;
  critic_rating?: number | null;
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
  view_count: number | null;
  last_viewed_at: string | null;
  view_offset_ms: number | null;
  user_rating: number | null;
  audience_rating: number | null;
  critic_rating: number | null;
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

interface NetworkSummaryRow {
  network: string;
  show_count: number;
  episode_count: number;
}

interface NetworkShowSummaryRow extends ShowSummaryRow {
  networks: string | null;
}

interface MovieSummaryRow {
  id: string;
  title: string;
  year: number | null;
}

interface ResolvedShowRow {
  id: string;
  title: string;
}

export interface VoiceTurnLogInput {
  sessionId: string | null;
  transcript: string;
  rawReplyText: string | null;
  rawCommandName: string | null;
  rawPayload: Record<string, unknown> | null;
  rawExpectsReply: boolean | null;
  finalReplyText: string;
  finalCommandName: string;
  finalPayload: Record<string, unknown>;
  commandOk: boolean | null;
  commandMessage: string | null;
  matchedItemCount: number | null;
}

export interface CatalogNetworkContext {
  network: string;
  shows: Array<{
    id: string;
    title: string;
    episodeCount: number;
    latestAirDate: string | null;
  }>;
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
      durationMs: calculateDurationMs(row.started_at, row.finished_at),
      librariesSynced: row.libraries_synced,
      mediaItemsSynced: row.media_items_synced,
      errorMessage: row.error_message
    };
  }

  getLatestSuccessfulSyncRun(): SyncRunSummary | null {
    const row = this.db.prepare(`
      SELECT id, mode, status, started_at, finished_at, libraries_synced, media_items_synced, error_message
      FROM sync_runs
      WHERE status = 'success'
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
      durationMs: calculateDurationMs(row.started_at, row.finished_at),
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
        mi.view_count,
        mi.last_viewed_at,
        mi.view_offset_ms,
        mi.user_rating,
        mi.audience_rating,
        mi.critic_rating,
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
            viewCount: row.view_count,
            lastViewedAt: row.last_viewed_at,
            viewOffsetMs: row.view_offset_ms,
            userRating: row.user_rating,
            audienceRating: row.audience_rating,
            criticRating: row.critic_rating,
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
        mi.summary,
        mi.year,
        mi.originally_available_at,
        mi.view_count,
        mi.last_viewed_at,
        mi.view_offset_ms,
        mi.user_rating,
        mi.audience_rating,
        mi.critic_rating
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

  listShows(input?: {
    limit?: number;
    offset?: number;
    startsWith?: string | null;
  }): CatalogShowListResponse {
    const startsWith = normalizeStartsWithFilter(input?.startsWith);
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
      WHERE (:startsWith IS NULL OR upper(substr(show_mi.title, 1, 1)) = :startsWith)
      GROUP BY show_mi.id, show_mi.title
      ORDER BY show_mi.title ASC
      LIMIT :limit
      OFFSET :offset
    `).all({
      startsWith,
      limit: clampCatalogLimit(input?.limit),
      offset: clampCatalogOffset(input?.offset)
    }) as unknown as ShowSummaryRow[];

    return {
      shows: rows.map((row) => mapShowSummaryRow(row))
    };
  }

  listMovies(input?: {
    limit?: number;
    offset?: number;
    startsWith?: string | null;
  }): CatalogMovieListResponse {
    const startsWith = normalizeStartsWithFilter(input?.startsWith);
    const rows = this.db.prepare(`
      SELECT
        mi.id,
        mi.title,
        mi.year
      FROM movies m
      JOIN media_items mi ON mi.id = m.media_item_id
      WHERE (:startsWith IS NULL OR upper(substr(mi.title, 1, 1)) = :startsWith)
      ORDER BY mi.title ASC, COALESCE(mi.year, 0) DESC
      LIMIT :limit
      OFFSET :offset
    `).all({
      startsWith,
      limit: clampCatalogLimit(input?.limit),
      offset: clampCatalogOffset(input?.offset)
    }) as unknown as MovieSummaryRow[];

    return {
      movies: rows.map((row) => mapMovieSummaryRow(row))
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

  listNetworks(limit?: number): CatalogNetworkListResponse {
    const rows = this.db.prepare(`
      SELECT
        mit.tag AS network,
        COUNT(DISTINCT s.media_item_id) AS show_count,
        COUNT(e.media_item_id) AS episode_count
      FROM media_item_tags mit
      JOIN shows s ON s.media_item_id = mit.media_item_id
      LEFT JOIN episodes e ON e.show_id = s.media_item_id
      WHERE mit.tag_type = 'network'
      GROUP BY mit.tag
      ORDER BY mit.tag ASC
      LIMIT :limit
    `).all({
      limit: clampCatalogLimit(limit)
    }) as unknown as NetworkSummaryRow[];

    return {
      networks: rows.map((row) => ({
        network: row.network,
        showCount: row.show_count,
        episodeCount: row.episode_count
      }))
    };
  }

  listNetworkShows(network: string, limit?: number): CatalogNetworkShowsResponse {
    const resolvedNetwork = this.resolveNetworkName(network) ?? network.trim();
    const rows = this.db.prepare(`
      SELECT
        show_mi.id,
        show_mi.title,
        COUNT(e.media_item_id) AS episode_count,
        MAX(COALESCE(e.air_date, episode_mi.originally_available_at)) AS latest_air_date,
        GROUP_CONCAT(DISTINCT network_tags.tag) AS networks
      FROM media_item_tags target_network
      JOIN shows s ON s.media_item_id = target_network.media_item_id
      JOIN media_items show_mi ON show_mi.id = s.media_item_id
      LEFT JOIN media_item_tags network_tags
        ON network_tags.media_item_id = s.media_item_id
       AND network_tags.tag_type = 'network'
      LEFT JOIN episodes e ON e.show_id = s.media_item_id
      LEFT JOIN media_items episode_mi ON episode_mi.id = e.media_item_id
      WHERE target_network.tag_type = 'network'
        AND lower(target_network.tag) = lower(:network)
      GROUP BY show_mi.id, show_mi.title
      ORDER BY show_mi.title ASC
      LIMIT :limit
    `).all({
      network: resolvedNetwork,
      limit: clampCatalogLimit(limit)
    }) as unknown as NetworkShowSummaryRow[];

    return {
      network: resolvedNetwork,
      shows: rows.map((row) => ({
        ...mapShowSummaryRow(row),
        networks: row.networks?.split(",").filter(Boolean) ?? []
      }))
    };
  }

  findNetworkContextForTranscript(transcript: string): CatalogNetworkContext | null {
    const normalizedTranscript = normalizeSearchText(transcript);

    if (!normalizedTranscript) {
      return null;
    }

    const rows = this.db.prepare(`
      SELECT DISTINCT tag
      FROM media_item_tags
      WHERE tag_type = 'network'
      ORDER BY LENGTH(tag) DESC, tag ASC
    `).all() as unknown as Array<{ tag: string }>;
    const match = rows.find((row) => normalizedTranscript.includes(normalizeSearchText(row.tag)));

    if (!match) {
      return null;
    }

    const networkShows = this.listNetworkShows(match.tag, 8).shows;

    if (networkShows.length === 0) {
      return null;
    }

    return {
      network: match.tag,
      shows: networkShows.map((show) => ({
        id: show.id,
        title: show.title,
        episodeCount: show.episodeCount,
        latestAirDate: show.latestAirDate
      }))
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
        mi.originally_available_at,
        mi.view_count,
        mi.last_viewed_at,
        mi.view_offset_ms,
        mi.user_rating,
        mi.audience_rating,
        mi.critic_rating
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

  recommendEpisodes(input: {
    show: string;
    strategy?: RecommendationStrategy;
    limit?: number;
    unwatchedOnly?: boolean;
  }): CatalogRecommendationResponse {
    const show = input.show.trim();
    const strategy = input.strategy ?? "default";

    if (!show) {
      return {
        show,
        strategy,
        items: []
      };
    }

    const resolvedShow = this.resolveShow(show);
    if (!resolvedShow) {
      return {
        show,
        strategy,
        items: []
      };
    }

    const limit = clampCatalogLimit(input.limit ?? 3);
    const unwatchedOnly = Boolean(input.unwatchedOnly);
    const recentCutoff = new Date(Date.now() - 1000 * 60 * 60 * 24 * 120).toISOString();
    const rows = this.db.prepare(`
      SELECT
        episode_mi.id,
        episode_mi.title,
        episode_mi.media_type,
        show_mi.title AS show_title,
        episode_mi.year,
        episode_mi.originally_available_at,
        episode_mi.view_count,
        episode_mi.last_viewed_at,
        episode_mi.view_offset_ms,
        episode_mi.user_rating,
        episode_mi.audience_rating,
        episode_mi.critic_rating,
        season.season_number,
        e.episode_number,
        e.air_date
      FROM episodes e
      JOIN media_items episode_mi ON episode_mi.id = e.media_item_id
      JOIN media_items show_mi ON show_mi.id = e.show_id
      LEFT JOIN seasons season ON season.media_item_id = e.season_id
      WHERE e.show_id = :showId
        AND (:unwatchedOnly = 0 OR COALESCE(episode_mi.view_count, 0) = 0)
      ORDER BY season.season_number ASC, e.episode_number ASC, episode_mi.title ASC
    `).all({
      showId: resolvedShow.id,
      unwatchedOnly: unwatchedOnly ? 1 : 0
    }) as unknown as MediaRow[];

    const rankedRows = rows
      .map((row) => ({
        row,
        score: scoreRecommendationRow(row, {
          strategy,
          recentCutoff
        }),
        tieBreaker: strategy === "random" ? Math.random() : 0
      }))
      .sort((left, right) => {
        if (left.score !== right.score) {
          return right.score - left.score;
        }

        if (strategy === "random" && left.tieBreaker !== right.tieBreaker) {
          return left.tieBreaker - right.tieBreaker;
        }

        return compareRecommendationRows(left.row, right.row);
      })
      .slice(0, limit)
      .map((entry) => entry.row);

    return {
      show: resolvedShow.title,
      strategy,
      items: rankedRows.map((row) => ({
        item: mapMediaRow(row),
        reason: buildRecommendationReason(row, strategy)
      }))
    };
  }

  setClientPlaybackState(
    state: ClientPlaybackState | undefined,
    options?: {
      sessionId?: string | null;
      positionMs?: number | null;
      currentItemId?: string | null;
    }
  ): PlaybackSnapshot {
    const session = this.getTargetSession(options?.sessionId);

    if (!session) {
      return this.getPlaybackSnapshot(null);
    }

    const snapshot = this.getPlaybackSnapshot(session.id);
    const activeItemId = snapshot.currentItem?.id ?? null;
    if (options?.currentItemId !== undefined && options.currentItemId !== activeItemId) {
      this.db.prepare(`
        UPDATE sessions
        SET last_seen_at = :lastSeenAt
        WHERE id = :sessionId
      `).run({
        sessionId: session.id,
        lastSeenAt: new Date().toISOString()
      });

      return snapshot;
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
    const startedAt = syncRun.startedAt ?? new Date().toISOString();
    const finishedAt = syncRun.finishedAt ?? new Date().toISOString();

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
        finishedAt,
        librariesSynced: syncRun.librariesSynced,
        mediaItemsSynced: syncRun.mediaItemsSynced,
        errorMessage: syncRun.errorMessage ?? null,
        detailsJson: JSON.stringify({
          libraries: payload.libraries.length,
          mediaItems: payload.mediaItems.length,
          collections: payload.collections.length,
          tags: payload.tags.length
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
          updated_at,
          view_count,
          last_viewed_at,
          view_offset_ms,
          user_rating,
          audience_rating,
          critic_rating
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
          :updatedAt,
          :viewCount,
          :lastViewedAt,
          :viewOffsetMs,
          :userRating,
          :audienceRating,
          :criticRating
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
          updated_at = excluded.updated_at,
          view_count = excluded.view_count,
          last_viewed_at = excluded.last_viewed_at,
          view_offset_ms = excluded.view_offset_ms,
          user_rating = excluded.user_rating,
          audience_rating = excluded.audience_rating,
          critic_rating = excluded.critic_rating
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
      const deleteNetworkTags = this.db.prepare(`
        DELETE FROM media_item_tags
        WHERE tag_type = 'network'
          AND media_item_id = :mediaItemId
      `);
      const upsertMediaItemTag = this.db.prepare(`
        INSERT INTO media_item_tags (media_item_id, tag_type, tag_key, tag)
        VALUES (:mediaItemId, :tagType, :tagKey, :tag)
        ON CONFLICT(media_item_id, tag_type, tag) DO UPDATE SET
          tag_key = excluded.tag_key
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
          updatedAt: item.updatedAt,
          viewCount: item.viewCount,
          lastViewedAt: item.lastViewedAt,
          viewOffsetMs: item.viewOffsetMs,
          userRating: item.userRating,
          audienceRating: item.audienceRating,
          criticRating: item.criticRating
        });
      });

      payload.mediaItems.forEach((item) => {
        if (item.mediaType === "show") {
          upsertShow.run({ mediaItemId: item.id });
        }
      });

      payload.mediaItems.forEach((item) => {
        if (item.mediaType === "season") {
          upsertSeason.run({
            mediaItemId: item.id,
            showId: item.showId,
            seasonNumber: item.seasonNumber
          });
        }
      });

      payload.mediaItems.forEach((item) => {
        if (item.mediaType === "episode") {
          upsertEpisode.run({
            mediaItemId: item.id,
            showId: item.showId,
            seasonId: item.seasonId,
            episodeNumber: item.episodeNumber,
            airDate: item.airDate
          });
        }
      });

      payload.mediaItems.forEach((item) => {
        if (item.mediaType === "movie") {
          upsertMovie.run({ mediaItemId: item.id });
        }
      });

      if (syncRun.mode === "full-sync") {
        this.db.prepare(`
          DELETE FROM media_item_tags
          WHERE tag_type = 'network'
        `).run();
      } else {
        new Set(payload.mediaItems
          .filter((item) => item.mediaType === "show")
          .map((item) => item.id)
        ).forEach((mediaItemId) => {
          deleteNetworkTags.run({ mediaItemId });
        });
      }

      payload.tags.forEach((tag) => {
        upsertMediaItemTag.run({
          mediaItemId: tag.mediaItemId,
          tagType: tag.tagType,
          tagKey: tag.tagKey,
          tag: tag.tag
        });
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
    const finishedAt = syncRun.finishedAt ?? new Date().toISOString();
    const startedAt = syncRun.startedAt ?? finishedAt;

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
      startedAt,
      finishedAt,
      librariesSynced: syncRun.librariesSynced,
      mediaItemsSynced: syncRun.mediaItemsSynced,
      errorMessage: syncRun.errorMessage ?? null,
      detailsJson: JSON.stringify({ failed: true })
    });

    return this.getLatestSyncRun()!;
  }

  recordVoiceTurn(input: VoiceTurnLogInput): void {
    this.db.prepare(`
      INSERT INTO voice_turn_log (
        id,
        session_id,
        transcript,
        raw_reply_text,
        raw_command_name,
        raw_payload_json,
        raw_expects_reply,
        final_reply_text,
        final_command_name,
        final_payload_json,
        command_ok,
        command_message,
        matched_item_count,
        created_at
      ) VALUES (
        :id,
        :sessionId,
        :transcript,
        :rawReplyText,
        :rawCommandName,
        :rawPayloadJson,
        :rawExpectsReply,
        :finalReplyText,
        :finalCommandName,
        :finalPayloadJson,
        :commandOk,
        :commandMessage,
        :matchedItemCount,
        :createdAt
      )
    `).run({
      id: randomUUID(),
      sessionId: input.sessionId,
      transcript: input.transcript,
      rawReplyText: input.rawReplyText,
      rawCommandName: input.rawCommandName,
      rawPayloadJson: input.rawPayload ? JSON.stringify(input.rawPayload) : null,
      rawExpectsReply: typeof input.rawExpectsReply === "boolean" ? (input.rawExpectsReply ? 1 : 0) : null,
      finalReplyText: input.finalReplyText,
      finalCommandName: input.finalCommandName,
      finalPayloadJson: JSON.stringify(input.finalPayload),
      commandOk: typeof input.commandOk === "boolean" ? (input.commandOk ? 1 : 0) : null,
      commandMessage: input.commandMessage,
      matchedItemCount: input.matchedItemCount,
      createdAt: new Date().toISOString()
    });
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
    const existingSession = this.getActiveSessionRow();
    const sessionId = process.env.CLAWTV_DEFAULT_SESSION_ID?.trim() || "primary-tv";
    const sessionName = process.env.CLAWTV_DEFAULT_SESSION_NAME?.trim() || "Primary TV";
    const clientId = process.env.CLAWTV_DEFAULT_CLIENT_ID?.trim() || "tv-receiver";

    if (existingSession) {
      return;
    }

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
        :sessionId,
        :sessionName,
        'tv',
        :clientId,
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
    `).run({ now, sessionId, sessionName, clientId });

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
        :sessionId,
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
    `).run({ now, sessionId });
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
      const mediaItemId = String(payload.mediaItemId ?? "").trim();
      const title = String(payload.title ?? "").trim();

      if (mediaItemId) {
        return this.lookupMediaItemsByIds([mediaItemId]);
      }

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
        return this.expandPlayableMatches(exactMatches.map(mapMediaRow));
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

      const playableFuzzyMatches = this.expandPlayableMatches(fuzzyMatches.map(mapMediaRow));
      if (playableFuzzyMatches.length > 0) {
        return playableFuzzyMatches;
      }

      const summaryMatches = this.db.prepare(`
        SELECT
          mi.id,
          mi.title,
          mi.media_type,
          show_mi.title AS show_title,
          mi.summary,
          mi.year,
          mi.originally_available_at
        FROM media_items mi
        LEFT JOIN episodes e ON e.media_item_id = mi.id
        LEFT JOIN media_items show_mi ON show_mi.id = e.show_id
        WHERE mi.media_type = 'episode'
          AND (
            lower(COALESCE(mi.summary, '')) LIKE lower(:titlePattern)
            OR lower(COALESCE(show_mi.title, '')) LIKE lower(:titlePattern)
          )
        ORDER BY
          CASE
            WHEN lower(COALESCE(mi.summary, '')) = lower(:title) THEN 0
            WHEN lower(COALESCE(mi.summary, '')) LIKE lower(:titlePrefix) THEN 1
            ELSE 2
          END,
          COALESCE(mi.originally_available_at, '') DESC,
          mi.title ASC
        LIMIT 5
      `).all({
        title,
        titlePattern: `%${title}%`,
        titlePrefix: `${title}%`
      }) as unknown as MediaRow[];

      const playableSummaryMatches = this.expandPlayableMatches(summaryMatches.map(mapMediaRow));
      return playableSummaryMatches.length === 1 ? playableSummaryMatches : [];
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
      const network = String(payload.network ?? "").trim();
      const highlyRated = parseBooleanPayload(payload.highlyRated);
      const unwatchedOnly = parseBooleanPayload(payload.unwatchedOnly);
      const limit = clampShuffleLimit(parseFiniteNumber(payload.limit) ?? null);
      const recentCutoff = new Date(Date.now() - 1000 * 60 * 60 * 24 * 120).toISOString();

      if (show) {
        const matches = this.db.prepare(`
          SELECT
            episode_mi.id,
            episode_mi.title,
            episode_mi.media_type,
            show_mi.title AS show_title,
            episode_mi.year,
            episode_mi.originally_available_at,
            episode_mi.view_count,
            episode_mi.last_viewed_at,
            episode_mi.view_offset_ms,
            episode_mi.user_rating,
            episode_mi.audience_rating,
            episode_mi.critic_rating
          FROM episodes e
          JOIN media_items episode_mi ON episode_mi.id = e.media_item_id
          JOIN media_items show_mi ON show_mi.id = e.show_id
          WHERE lower(show_mi.title) = lower(:show)
             OR lower(show_mi.title) LIKE lower(:showPattern)
            AND (:unwatchedOnly = 0 OR COALESCE(episode_mi.view_count, 0) = 0)
          ORDER BY RANDOM()
          LIMIT :limit
        `).all({
          show,
          showPattern: `%${show}%`,
          unwatchedOnly: unwatchedOnly ? 1 : 0,
          limit
        }) as unknown as MediaRow[];

        const curatedMatches = matches
          .sort((left, right) => compareShuffleRows(left, right, {
            highlyRated,
            recentCutoff
          }))
          .slice(0, limit);

        return curatedMatches.map(mapMediaRow);
      }

      if (network) {
        return this.resolveNetworkShuffleItems({
          network,
          limit,
          highlyRated,
          unwatchedOnly,
          recentCutoff
        });
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

        if (matches.length > 0) {
          return matches.map(mapMediaRow);
        }

        return this.resolveNetworkShuffleItems({
          network: collection,
          limit,
          highlyRated,
          unwatchedOnly,
          recentCutoff
        });
      }
    }

    return [];
  }

  private resolveNetworkName(input: string): string | null {
    const network = input.trim();

    if (!network) {
      return null;
    }

    const exact = this.db.prepare(`
      SELECT tag
      FROM media_item_tags
      WHERE tag_type = 'network'
        AND lower(tag) = lower(:network)
      LIMIT 1
    `).get({ network }) as { tag: string } | undefined;

    if (exact) {
      return exact.tag;
    }

    const fuzzy = this.db.prepare(`
      SELECT tag
      FROM media_item_tags
      WHERE tag_type = 'network'
        AND lower(tag) LIKE lower(:networkPattern)
      ORDER BY LENGTH(tag) ASC
      LIMIT 1
    `).get({ networkPattern: `%${network}%` }) as { tag: string } | undefined;

    return fuzzy?.tag ?? null;
  }

  private resolveNetworkShuffleItems(input: {
    network: string;
    limit: number;
    highlyRated: boolean;
    unwatchedOnly: boolean;
    recentCutoff: string;
  }): MediaItemSummary[] {
    const network = this.resolveNetworkName(input.network);

    if (!network) {
      return [];
    }

    const matches = this.db.prepare(`
      SELECT
        episode_mi.id,
        episode_mi.title,
        episode_mi.media_type,
        show_mi.title AS show_title,
        episode_mi.year,
        episode_mi.originally_available_at,
        episode_mi.view_count,
        episode_mi.last_viewed_at,
        episode_mi.view_offset_ms,
        episode_mi.user_rating,
        episode_mi.audience_rating,
        episode_mi.critic_rating,
        season.season_number,
        e.episode_number
      FROM media_item_tags network_tag
      JOIN shows s ON s.media_item_id = network_tag.media_item_id
      JOIN episodes e ON e.show_id = s.media_item_id
      JOIN media_items episode_mi ON episode_mi.id = e.media_item_id
      JOIN media_items show_mi ON show_mi.id = e.show_id
      LEFT JOIN seasons season ON season.media_item_id = e.season_id
      WHERE network_tag.tag_type = 'network'
        AND lower(network_tag.tag) = lower(:network)
        AND (:unwatchedOnly = 0 OR COALESCE(episode_mi.view_count, 0) = 0)
      ORDER BY RANDOM()
      LIMIT :limit
    `).all({
      network,
      unwatchedOnly: input.unwatchedOnly ? 1 : 0,
      limit: input.limit
    }) as unknown as MediaRow[];

    const curatedMatches = matches
      .sort((left, right) => compareShuffleRows(left, right, {
        highlyRated: input.highlyRated,
        recentCutoff: input.recentCutoff
      }))
      .slice(0, input.limit);

    return curatedMatches.map(mapMediaRow);
  }

  private expandPlayableMatches(items: MediaItemSummary[]): MediaItemSummary[] {
    const playableItems = items.filter((item) => item.mediaType === "movie" || item.mediaType === "episode");

    if (playableItems.length > 0) {
      return playableItems;
    }

    for (const item of items) {
      if (item.mediaType === "show") {
        const firstEpisode = this.db.prepare(`
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
          LEFT JOIN seasons season ON season.media_item_id = e.season_id
          WHERE e.show_id = :showId
          ORDER BY
            COALESCE(season.season_number, 0) ASC,
            COALESCE(e.episode_number, 0) ASC,
            episode_mi.title ASC
          LIMIT 1
        `).all({ showId: item.id }) as unknown as MediaRow[];

        if (firstEpisode.length > 0) {
          return firstEpisode.map(mapMediaRow);
        }
      }

      if (item.mediaType === "season") {
        const firstEpisode = this.db.prepare(`
          SELECT
            episode_mi.id,
            episode_mi.title,
            episode_mi.media_type,
            show_mi.title AS show_title,
            episode_mi.year,
            episode_mi.originally_available_at
          FROM episodes e
          JOIN media_items episode_mi ON episode_mi.id = e.media_item_id
          LEFT JOIN seasons season ON season.media_item_id = :seasonId
          LEFT JOIN media_items show_mi ON show_mi.id = COALESCE(e.show_id, season.show_id)
          WHERE e.season_id = :seasonId
          ORDER BY
            COALESCE(e.episode_number, 0) ASC,
            episode_mi.title ASC
          LIMIT 1
        `).all({ seasonId: item.id }) as unknown as MediaRow[];

        if (firstEpisode.length > 0) {
          return firstEpisode.map(mapMediaRow);
        }
      }
    }

    return items;
  }

  private resolveShow(show: string): ResolvedShowRow | null {
    const row = this.db.prepare(`
      SELECT mi.id, mi.title
      FROM shows s
      JOIN media_items mi ON mi.id = s.media_item_id
      WHERE lower(mi.title) = lower(:show)
         OR lower(mi.title) LIKE lower(:showPattern)
      ORDER BY
        CASE WHEN lower(mi.title) = lower(:show) THEN 0 ELSE 1 END,
        mi.title ASC
      LIMIT 1
    `).get({
      show,
      showPattern: `%${show}%`
    }) as unknown as ResolvedShowRow | undefined;

    return row ?? null;
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
    summary: row.summary ?? null,
    year: row.year,
    originallyAvailableAt: row.originally_available_at,
    seasonNumber: row.season_number ?? null,
    episodeNumber: row.episode_number ?? null,
    viewCount: row.view_count ?? null,
    lastViewedAt: row.last_viewed_at ?? null,
    viewOffsetMs: row.view_offset_ms ?? null,
    userRating: row.user_rating ?? null,
    audienceRating: row.audience_rating ?? null,
    criticRating: row.critic_rating ?? null
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

function mapMovieSummaryRow(row: MovieSummaryRow): CatalogMovieSummary {
  return {
    id: row.id,
    title: row.title,
    year: row.year
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
    originallyAvailableAt: item.originallyAvailableAt,
    seasonNumber: item.seasonNumber ?? null,
    episodeNumber: item.episodeNumber ?? null,
    viewCount: item.viewCount ?? null,
    lastViewedAt: item.lastViewedAt ?? null,
    viewOffsetMs: item.viewOffsetMs ?? null,
    userRating: item.userRating ?? null,
    audienceRating: item.audienceRating ?? null,
    criticRating: item.criticRating ?? null
  };
}

function buildRecommendationReason(row: MediaRow, strategy: RecommendationStrategy): string {
  const rating = row.user_rating ?? row.audience_rating ?? row.critic_rating;
  const viewCount = row.view_count ?? 0;
  const daysSinceViewed = daysSinceIsoString(row.last_viewed_at);

  if (strategy === "random") {
    if (viewCount === 0) {
      return "Random pick, and you have not watched it yet.";
    }
    if (daysSinceViewed !== null && daysSinceViewed >= 180) {
      return "Random pick that has been out of rotation for a while.";
    }
    return "Random pick from the show.";
  }

  if (strategy === "highly-rated" && typeof rating === "number" && rating > 0) {
    if (viewCount === 0) {
      return `One of the strongest-rated episodes in the set (${formatRating(rating)}), and you have not watched it yet.`;
    }

    if (daysSinceViewed !== null && daysSinceViewed >= 180) {
      return `One of the strongest-rated episodes in the set (${formatRating(rating)}), and it has been a while since you watched it.`;
    }

    return `One of the strongest-rated episodes in the set (${formatRating(rating)}).`;
  }

  if (viewCount === 0) {
    return "A strong place to start that you have not watched yet.";
  }

  if (!row.last_viewed_at) {
    return "A solid episode pick from the show.";
  }

  if (daysSinceViewed !== null && daysSinceViewed >= 365) {
    return "A good fit based on what you have watched and what has been sitting a long while.";
  }

  return "A good fit based on what you have watched and what has been sitting a while.";
}

function scoreRecommendationRow(
  row: MediaRow,
  input: {
    strategy: RecommendationStrategy;
    recentCutoff: string;
  }
): number {
  const rating = row.user_rating ?? row.audience_rating ?? row.critic_rating ?? 0;
  const viewCount = row.view_count ?? 0;
  const daysSinceViewed = daysSinceIsoString(row.last_viewed_at);
  const staleBonus = !row.last_viewed_at
    ? 16
    : daysSinceViewed === null
      ? 0
      : daysSinceViewed >= 365
        ? 18
        : daysSinceViewed >= 180
          ? 12
          : daysSinceViewed >= 90
            ? 8
            : daysSinceViewed >= 30
              ? 4
              : -8;
  const unwatchedBonus = viewCount === 0 ? 26 : 0;
  const lightRotationBonus = viewCount > 0 ? Math.max(0, 10 - Math.min(viewCount, 10)) : 0;
  const seasonBias = -(((row.season_number ?? 1) - 1) * 0.6) - (((row.episode_number ?? 1) - 1) * 0.04);

  if (input.strategy === "random") {
    return unwatchedBonus + staleBonus + lightRotationBonus + Math.random() * 100;
  }

  if (input.strategy === "highly-rated") {
    return (rating * 11) + (unwatchedBonus * 0.6) + (staleBonus * 0.6) + (lightRotationBonus * 0.3) + seasonBias;
  }

  return (rating * 5) + unwatchedBonus + staleBonus + (lightRotationBonus * 1.5) + seasonBias;
}

function compareRecommendationRows(left: MediaRow, right: MediaRow): number {
  const leftSeason = left.season_number ?? Number.MAX_SAFE_INTEGER;
  const rightSeason = right.season_number ?? Number.MAX_SAFE_INTEGER;
  if (leftSeason !== rightSeason) {
    return leftSeason - rightSeason;
  }

  const leftEpisode = left.episode_number ?? Number.MAX_SAFE_INTEGER;
  const rightEpisode = right.episode_number ?? Number.MAX_SAFE_INTEGER;
  if (leftEpisode !== rightEpisode) {
    return leftEpisode - rightEpisode;
  }

  return left.title.localeCompare(right.title);
}

function daysSinceIsoString(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return null;
  }

  return Math.max(0, Math.floor((Date.now() - timestamp) / (1000 * 60 * 60 * 24)));
}

function compareShuffleRows(
  left: MediaRow,
  right: MediaRow,
  input: {
    highlyRated: boolean;
    recentCutoff: string;
  }
): number {
  const leftUnwatched = (left.view_count ?? 0) === 0 ? 0 : 1;
  const rightUnwatched = (right.view_count ?? 0) === 0 ? 0 : 1;
  if (leftUnwatched !== rightUnwatched) {
    return leftUnwatched - rightUnwatched;
  }

  const leftRecent = !left.last_viewed_at || left.last_viewed_at < input.recentCutoff ? 0 : 1;
  const rightRecent = !right.last_viewed_at || right.last_viewed_at < input.recentCutoff ? 0 : 1;
  if (leftRecent !== rightRecent) {
    return leftRecent - rightRecent;
  }

  if (input.highlyRated) {
    const leftRating = left.user_rating ?? left.audience_rating ?? left.critic_rating ?? 0;
    const rightRating = right.user_rating ?? right.audience_rating ?? right.critic_rating ?? 0;
    if (leftRating !== rightRating) {
      return rightRating - leftRating;
    }
  }

  return 0;
}

function formatRating(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
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

function parseBooleanPayload(value: unknown): boolean {
  return value === true
    || value === 1
    || value === "1"
    || value === "true"
    || value === "yes";
}

function clampShuffleLimit(value: number | null): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 12;
  }

  return Math.max(1, Math.min(24, Math.trunc(value)));
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

function clampCatalogOffset(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.round(value));
}

function normalizeStartsWithFilter(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toUpperCase() ?? "";

  if (!trimmed) {
    return null;
  }

  return /^[A-Z]$/u.test(trimmed) ? trimmed : null;
}

function normalizeSearchText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9+]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function calculateDurationMs(startedAt: string, finishedAt: string | null): number | null {
  if (!finishedAt) {
    return null;
  }

  const startedMs = Date.parse(startedAt);
  const finishedMs = Date.parse(finishedAt);

  if (!Number.isFinite(startedMs) || !Number.isFinite(finishedMs)) {
    return null;
  }

  return Math.max(0, finishedMs - startedMs);
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
