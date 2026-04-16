export type SessionType = "tv";
export type SessionConnectionStatus = "connected" | "disconnected";
export type ClientPlaybackState = "booting" | "idle" | "loading" | "playing" | "paused" | "error";
export type CommandName = "play" | "play-latest" | "shuffle" | "pause" | "resume" | "seek" | "refresh" | "next" | "stop";
export type SyncMode = "full-sync" | "incremental-sync" | "single-item-refresh";
export type SyncStatus = "success" | "failed" | "running";
export type MediaType = "show" | "season" | "episode" | "movie";
export type CatalogMediaTypeFilter = MediaType | "any";
export type PlaybackClientMode = "idle" | "native-hls" | "hls.js" | "unsupported";
export type PlaybackAutoplayStatus = "unknown" | "started" | "blocked" | "failed";
export type ReceiverCommandType = "refresh";
export type VoiceReplyMode = "client-tts" | "server-audio" | "none";
export type VoiceSttMode = "shield" | "server";
export type VoiceBackendMode = "mock" | "openclaw";
export type RecommendationStrategy = "default" | "random" | "highly-rated";

export interface SessionSummary {
  id: string;
  sessionName: string;
  sessionType: SessionType;
  clientId: string;
  claimed: boolean;
  active: boolean;
  lastSeenAt: string;
  status: SessionConnectionStatus;
  playbackState?: ClientPlaybackState;
}

export interface CatalogStatus {
  librariesIndexed: number;
  mediaItemsIndexed: number;
  lastSyncAt: string | null;
  lastSyncStatus: SyncStatus | null;
}

export interface ServerStatus {
  service: string;
  environment: string;
  basePath: string;
  activeSessionId: string | null;
  sessionCount: number;
  playbackState: ClientPlaybackState;
  lastCommandName: CommandName | null;
  lastCommandAt: string | null;
  catalog: CatalogStatus;
}

export interface MediaItemSummary {
  id: string;
  title: string;
  mediaType: MediaType;
  showTitle: string | null;
  summary?: string | null;
  year: number | null;
  originallyAvailableAt: string | null;
  seasonNumber?: number | null;
  episodeNumber?: number | null;
  viewCount?: number | null;
  lastViewedAt?: string | null;
  viewOffsetMs?: number | null;
  userRating?: number | null;
  audienceRating?: number | null;
  criticRating?: number | null;
}

export interface PlaybackMediaItem extends MediaItemSummary {
  plexRatingKey: string;
  summary: string | null;
  durationMs: number | null;
  posterUrl: string | null;
  thumbUrl: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  airDate: string | null;
}

export interface PlaybackContext {
  remainingMs: number | null;
  totalEpisodesInSeason: number | null;
  remainingEpisodesInSeason: number | null;
  totalSeasonsInShow: number | null;
  remainingSeasonsInShow: number | null;
}

export interface VoiceConfig {
  enabled: boolean;
  backend: VoiceBackendMode;
  assistantId: string;
  assistantName: string;
  greetingText: string;
  processingText: string;
  acknowledgementText: string;
  unavailableText: string;
  greetingAudioUrl: string | null;
  processingAudioUrl: string | null;
  acknowledgementAudioUrl: string | null;
  unavailableAudioUrl: string | null;
  sttMode: VoiceSttMode;
  replyMode: VoiceReplyMode;
}

export interface PlaybackSnapshot {
  sessionId: string | null;
  queueId: string | null;
  playbackState: ClientPlaybackState;
  playbackPositionMs: number;
  controlRevision: number;
  receiverCommand: ReceiverCommand | null;
  updatedAt: string | null;
  queueLength: number;
  currentQueuePosition: number | null;
  currentItem: PlaybackMediaItem | null;
  context: PlaybackContext | null;
  streamPath: string | null;
  diagnostics: PlaybackDiagnostics | null;
}

export interface ReceiverCommand {
  id: string;
  type: ReceiverCommandType;
  issuedAt: string;
}

export interface CommandResult {
  ok: boolean;
  requestId: string;
  commandName: CommandName;
  acceptedAt: string;
  playbackState: ClientPlaybackState;
  queueId: string | null;
  message: string;
  matchedItemCount: number;
  matchedItems: MediaItemSummary[];
}

export interface MediaLookupRequest {
  title?: string;
  series?: string;
  collection?: string;
  date?: string;
}

export interface CatalogSearchResponse {
  query: string;
  mediaType: CatalogMediaTypeFilter;
  items: MediaItemSummary[];
}

export interface CatalogShowSummary {
  id: string;
  title: string;
  episodeCount: number;
  latestAirDate: string | null;
}

export interface CatalogNetworkShowSummary extends CatalogShowSummary {
  networks: string[];
}

export interface CatalogShowListResponse {
  shows: CatalogShowSummary[];
}

export interface CatalogMovieSummary {
  id: string;
  title: string;
  year: number | null;
}

export interface CatalogMovieListResponse {
  movies: CatalogMovieSummary[];
}

export interface CatalogCollectionSummary {
  id: string;
  title: string;
  itemCount: number;
}

export interface CatalogCollectionListResponse {
  collections: CatalogCollectionSummary[];
}

export interface CatalogNetworkSummary {
  network: string;
  showCount: number;
  episodeCount: number;
}

export interface CatalogNetworkListResponse {
  networks: CatalogNetworkSummary[];
}

export interface CatalogNetworkShowsResponse {
  network: string;
  shows: CatalogNetworkShowSummary[];
}

export interface CatalogRecentResponse {
  mediaType: CatalogMediaTypeFilter;
  items: MediaItemSummary[];
}

export interface EpisodeRecommendation {
  item: MediaItemSummary;
  reason: string;
}

export interface CatalogRecommendationResponse {
  show: string;
  strategy: RecommendationStrategy;
  items: EpisodeRecommendation[];
}

export interface SyncRunSummary {
  id: string;
  mode: SyncMode;
  status: SyncStatus;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  librariesSynced: number;
  mediaItemsSynced: number;
  errorMessage: string | null;
}

export interface SyncRequest {
  mode: SyncMode;
  library?: string;
}

export interface CheckNewContentRequest {
  library?: string;
  limit?: number;
}

export interface CheckNewContentResponse {
  ok: boolean;
  scanTriggered: boolean;
  library: string | null;
  syncRun: SyncRunSummary;
  items: MediaItemSummary[];
}

export interface PlaybackStateUpdateRequest {
  state?: ClientPlaybackState;
  positionMs?: number;
  sessionId?: string;
  currentItemId?: string | null;
}

export interface SeekCommandRequest {
  deltaMs?: number;
  positionMs?: number;
}

export interface PlaybackDiagnostics {
  playbackMode: PlaybackClientMode;
  nativeHlsSupported: boolean;
  hlsJsSupported: boolean;
  autoplayStatus: PlaybackAutoplayStatus;
  lastEvent: string;
  errorMessage: string | null;
  updatedAt: string;
}

export interface PlaybackDiagnosticsUpdateRequest {
  playbackMode: PlaybackClientMode;
  nativeHlsSupported: boolean;
  hlsJsSupported: boolean;
  autoplayStatus: PlaybackAutoplayStatus;
  lastEvent: string;
  errorMessage?: string | null;
}

export interface VoiceTurnRequest {
  transcript: string;
  sessionId?: string;
  playbackState?: ClientPlaybackState;
  currentItemId?: string | null;
  currentItemTitle?: string | null;
  showTitle?: string | null;
}

export interface VoiceTurnResponse {
  ok: boolean;
  enabled: boolean;
  backend: VoiceBackendMode;
  assistantId: string;
  assistantName: string;
  transcript: string;
  greetingText: string;
  replyText: string;
  acknowledgementText: string | null;
  processingText: string | null;
  unavailableText: string;
  greetingAudioUrl: string | null;
  processingAudioUrl: string | null;
  acknowledgementAudioUrl: string | null;
  unavailableAudioUrl: string | null;
  replyAudioUrl: string | null;
  sttMode: VoiceSttMode;
  replyMode: VoiceReplyMode;
  expectsReply: boolean;
  resumePlayback: boolean;
  action: CommandName | "none";
  playback: PlaybackSnapshot;
}
