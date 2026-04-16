import type { SyncMode } from "@clawtv/contracts";
import type {
  CatalogCollectionRecord,
  CatalogLibraryRecord,
  CatalogMediaItemTagRecord,
  CatalogMediaItemRecord,
  CatalogSyncPayload
} from "@clawtv/db";

export interface PlexSyncOptions {
  baseUrl: string;
  token: string;
  mode: SyncMode;
  library?: string;
  lastSuccessfulSyncAt?: string | null;
}

interface PlexSection {
  key: string;
  title: string;
  type: string;
  refreshing: boolean;
}

interface PlexMediaContainerResponse {
  MediaContainer?: {
    Directory?: Array<Record<string, unknown>>;
    Metadata?: Array<Record<string, unknown>>;
  };
}

export async function syncPlexCatalog(options: PlexSyncOptions): Promise<CatalogSyncPayload> {
  const sections = await listPlexSections(options);

  const libraries: CatalogLibraryRecord[] = [];
  const mediaItemsById = new Map<string, CatalogMediaItemRecord>();
  const collectionsById = new Map<string, CatalogCollectionRecord>();
  const tagsByKey = new Map<string, CatalogMediaItemTagRecord>();

  for (const section of sections) {
    const libraryId = `plex-library-${section.key}`;
    libraries.push({
      id: libraryId,
      plexLibraryKey: section.key,
      name: section.title,
      type: section.type,
      updatedAt: new Date().toISOString()
    });

    const rawItems = isIncrementalSync(options)
      ? await fetchIncrementalSectionItems({
        options,
        section,
        libraryId,
        mediaItemsById
      })
      : await fetchFullSectionItems({
        options,
        section,
        libraryId,
        mediaItemsById
      });

    const collectionsResponse = await plexFetch<PlexMediaContainerResponse>(options, `library/sections/${section.key}/collections`);
    const rawCollections = collectionsResponse.MediaContainer?.Metadata ?? [];

    rawCollections.forEach((rawCollection) => {
      const mapped = mapCollection(section, libraryId, rawCollection);

      if (mapped) {
        collectionsById.set(mapped.id, mapped);
      }
    });

    if (section.type === "show") {
      const networkTags = await fetchShowNetworkTags({
        options,
        section
      });

      networkTags.forEach((tag) => {
        if (mediaItemsById.has(tag.mediaItemId)) {
          tagsByKey.set(`${tag.mediaItemId}|${tag.tagType}|${tag.tag}`, tag);
        }
      });
    }
  }

  return {
    libraries,
    mediaItems: [...mediaItemsById.values()],
    collections: [...collectionsById.values()],
    tags: [...tagsByKey.values()]
  };
}

function mapSection(rawSection: Record<string, unknown>): PlexSection | null {
  if (typeof rawSection.key !== "string" || typeof rawSection.title !== "string" || typeof rawSection.type !== "string") {
    return null;
  }

  return {
    key: rawSection.key,
    title: rawSection.title,
    type: rawSection.type,
    refreshing: asBoolean(rawSection.refreshing)
  };
}

export async function triggerPlexLibraryScan(options: PlexSyncOptions): Promise<PlexSection[]> {
  const sections = await listPlexSections(options);

  for (const section of sections) {
    const url = buildPlexRequestUrl(options, `library/sections/${section.key}/refresh`);
    const response = await fetch(url, {
      headers: {
        Accept: "application/json"
      }
    });

    if (!response.ok) {
      throw new Error(`Plex request failed with status ${response.status} for ${url.pathname}`);
    }
  }

  return sections;
}

export async function waitForPlexLibraryScan(options: PlexSyncOptions, input?: {
  timeoutMs?: number;
  pollIntervalMs?: number;
}): Promise<PlexSection[]> {
  const timeoutMs = input?.timeoutMs ?? 30_000;
  const pollIntervalMs = input?.pollIntervalMs ?? 1_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    const sections = await listPlexSections(options);

    if (sections.every((section) => !section.refreshing)) {
      return sections;
    }

    await sleep(pollIntervalMs);
  }

  throw new Error(`Timed out waiting for Plex library scan after ${timeoutMs}ms.`);
}

async function listPlexSections(options: PlexSyncOptions): Promise<PlexSection[]> {
  const sectionsResponse = await plexFetch<PlexMediaContainerResponse>(options, "library/sections");
  const allSections = (sectionsResponse.MediaContainer?.Directory ?? [])
    .map(mapSection)
    .filter((section): section is PlexSection => Boolean(section));

  return options.library
    ? allSections.filter((section) => section.title.toLowerCase() === options.library?.toLowerCase())
    : allSections;
}

async function fetchFullSectionItems(input: {
  options: PlexSyncOptions;
  section: PlexSection;
  libraryId: string;
  mediaItemsById: Map<string, CatalogMediaItemRecord>;
}): Promise<Array<Record<string, unknown>>> {
  const itemsResponse = await plexFetch<PlexMediaContainerResponse>(
    input.options,
    `library/sections/${input.section.key}/all`
  );
  const rawItems = itemsResponse.MediaContainer?.Metadata ?? [];

  rawItems.forEach((rawItem) => {
    const mapped = mapMediaItem(input.libraryId, rawItem, input.options);

    if (mapped) {
      input.mediaItemsById.set(mapped.id, mapped);
    }
  });

  if (input.section.type === "show") {
    await hydrateShowSectionChildren({
      options: input.options,
      libraryId: input.libraryId,
      rawShows: rawItems,
      mediaItemsById: input.mediaItemsById
    });
  }

  return rawItems;
}

async function fetchIncrementalSectionItems(input: {
  options: PlexSyncOptions;
  section: PlexSection;
  libraryId: string;
  mediaItemsById: Map<string, CatalogMediaItemRecord>;
}): Promise<Array<Record<string, unknown>>> {
  const recentPath = `library/sections/${input.section.key}/recentlyAdded?X-Plex-Container-Start=0&X-Plex-Container-Size=200`;
  const itemsResponse = await plexFetch<PlexMediaContainerResponse>(
    input.options,
    recentPath
  );
  const rawItems = (itemsResponse.MediaContainer?.Metadata ?? []).filter((rawItem) => {
    const since = input.options.lastSuccessfulSyncAt;

    if (!since) {
      return true;
    }

    const cutoffMs = Date.parse(since);
    const updatedAt = asUnixTimestamp(rawItem.updatedAt);
    const addedAt = asUnixTimestamp(rawItem.addedAt);
    const candidateMs = Date.parse(updatedAt ?? addedAt ?? "");

    return Number.isFinite(candidateMs) && candidateMs >= cutoffMs;
  });

  if (input.section.type !== "show") {
    rawItems.forEach((rawItem) => {
      const mapped = mapMediaItem(input.libraryId, rawItem, input.options);

      if (mapped) {
        input.mediaItemsById.set(mapped.id, mapped);
      }
    });

    return rawItems;
  }

  const hydratedShowIds = new Set<string>();
  const hydratedSeasonIds = new Set<string>();
  const sectionItems: Array<Record<string, unknown>> = [];

  for (const rawItem of rawItems) {
    const mapped = mapMediaItem(input.libraryId, rawItem, input.options);

    if (mapped) {
      input.mediaItemsById.set(mapped.id, mapped);
      sectionItems.push(rawItem);
    }

    const itemType = asString(rawItem.type);
    const ratingKey = asString(rawItem.ratingKey);
    const parentRatingKey = asString(rawItem.parentRatingKey);
    const grandparentRatingKey = asString(rawItem.grandparentRatingKey);

    if (itemType === "show" && ratingKey && !hydratedShowIds.has(ratingKey)) {
      hydratedShowIds.add(ratingKey);
      const showMetadata = await fetchMetadataItem(input.options, ratingKey);

      if (showMetadata) {
        const mappedShow = mapMediaItem(input.libraryId, showMetadata, input.options);

        if (mappedShow) {
          input.mediaItemsById.set(mappedShow.id, mappedShow);
        }

        await hydrateShowSectionChildren({
          options: input.options,
          libraryId: input.libraryId,
          rawShows: [showMetadata],
          mediaItemsById: input.mediaItemsById
        });
      }
      continue;
    }

    if (parentRatingKey && !hydratedSeasonIds.has(parentRatingKey)) {
      hydratedSeasonIds.add(parentRatingKey);
      const seasonMetadata = await fetchMetadataItem(input.options, parentRatingKey);

      if (seasonMetadata) {
        const mappedSeason = mapMediaItem(input.libraryId, seasonMetadata, input.options);

        if (mappedSeason) {
          input.mediaItemsById.set(mappedSeason.id, mappedSeason);
        }

        const seasonChildren = await plexFetch<PlexMediaContainerResponse>(
          input.options,
          `library/metadata/${parentRatingKey}/children`
        );
        const rawEpisodes = [
          ...(seasonChildren.MediaContainer?.Directory ?? []),
          ...(seasonChildren.MediaContainer?.Metadata ?? [])
        ];

        rawEpisodes.forEach((rawEpisode) => {
          const mappedEpisode = mapMediaItem(input.libraryId, rawEpisode, input.options);

          if (mappedEpisode) {
            input.mediaItemsById.set(mappedEpisode.id, mappedEpisode);
          }
        });
      }
    }

    const showRatingKey = itemType === "show" ? ratingKey : grandparentRatingKey ?? parentRatingKey;

    if (showRatingKey && !hydratedShowIds.has(showRatingKey)) {
      hydratedShowIds.add(showRatingKey);
      const showMetadata = await fetchMetadataItem(input.options, showRatingKey);

      if (showMetadata) {
        const mappedShow = mapMediaItem(input.libraryId, showMetadata, input.options);

        if (mappedShow) {
          input.mediaItemsById.set(mappedShow.id, mappedShow);
        }
      }
    }
  }

  return sectionItems;
}

async function fetchShowNetworkTags(input: {
  options: PlexSyncOptions;
  section: PlexSection;
}): Promise<CatalogMediaItemTagRecord[]> {
  const networksResponse = await plexFetch<PlexMediaContainerResponse>(
    input.options,
    `library/sections/${input.section.key}/network`
  );
  const rawNetworks = networksResponse.MediaContainer?.Directory ?? [];
  const tags: CatalogMediaItemTagRecord[] = [];

  for (const rawNetwork of rawNetworks) {
    const network = asString(rawNetwork.title) ?? asString(rawNetwork.tag);
    const networkKey = asString(rawNetwork.key);

    if (!network) {
      continue;
    }

    const showsResponse = await plexFetch<PlexMediaContainerResponse>(
      input.options,
      `library/sections/${input.section.key}/all?network=${encodeURIComponent(network)}`
    );
    const rawShows = showsResponse.MediaContainer?.Metadata ?? [];

    rawShows.forEach((rawShow) => {
      const mediaItemId = buildMediaItemId(asString(rawShow.ratingKey));

      if (!mediaItemId) {
        return;
      }

      tags.push({
        mediaItemId,
        tagType: "network",
        tagKey: networkKey,
        tag: network
      });
    });
  }

  return tags;
}

async function fetchMetadataItem(
  options: PlexSyncOptions,
  ratingKey: string
): Promise<Record<string, unknown> | null> {
  const metadataResponse = await plexFetch<PlexMediaContainerResponse>(options, `library/metadata/${ratingKey}`);
  return (metadataResponse.MediaContainer?.Metadata ?? [])[0] ?? null;
}

async function hydrateShowSectionChildren(input: {
  options: PlexSyncOptions;
  libraryId: string,
  rawShows: Array<Record<string, unknown>>;
  mediaItemsById: Map<string, CatalogMediaItemRecord>;
}): Promise<void> {
  for (const rawShow of input.rawShows) {
    if (rawShow.type !== "show") {
      continue;
    }

    const showRatingKey = asString(rawShow.ratingKey);

    if (!showRatingKey) {
      continue;
    }

    const showChildren = await plexFetch<PlexMediaContainerResponse>(
      input.options,
      `library/metadata/${showRatingKey}/children`
    );
    const rawChildren = [
      ...(showChildren.MediaContainer?.Directory ?? []),
      ...(showChildren.MediaContainer?.Metadata ?? [])
    ];

    for (const rawChild of rawChildren) {
      const mappedChild = mapMediaItem(input.libraryId, rawChild, input.options);

      if (!mappedChild) {
        continue;
      }

      input.mediaItemsById.set(mappedChild.id, mappedChild);

      if (mappedChild.mediaType !== "season") {
        continue;
      }

      const seasonRatingKey = asString(rawChild.ratingKey);

      if (!seasonRatingKey) {
        continue;
      }

      const seasonChildren = await plexFetch<PlexMediaContainerResponse>(
        input.options,
        `library/metadata/${seasonRatingKey}/children`
      );
      const rawEpisodes = [
        ...(seasonChildren.MediaContainer?.Directory ?? []),
        ...(seasonChildren.MediaContainer?.Metadata ?? [])
      ];

      rawEpisodes.forEach((rawEpisode) => {
        const mappedEpisode = mapMediaItem(input.libraryId, rawEpisode, input.options);

        if (mappedEpisode) {
          input.mediaItemsById.set(mappedEpisode.id, mappedEpisode);
        }
      });
    }
  }
}

function isIncrementalSync(options: PlexSyncOptions): boolean {
  return options.mode === "incremental-sync" && Boolean(options.lastSuccessfulSyncAt);
}

function mapMediaItem(
  libraryId: string,
  rawItem: Record<string, unknown>,
  options: PlexSyncOptions
): CatalogMediaItemRecord | null {
  const ratingKey = asString(rawItem.ratingKey);
  const mediaType = asMediaType(rawItem.type);
  const title = asString(rawItem.title);

  if (!ratingKey || !mediaType || !title) {
    return null;
  }

  const id = `plex-item-${ratingKey}`;
  const thumb = asString(rawItem.thumb);
  const art = asString(rawItem.art);
  const addedAtSeconds = asNumber(rawItem.addedAt);
  const updatedAtSeconds = asNumber(rawItem.updatedAt);

  return {
    id,
    plexRatingKey: ratingKey,
    libraryId,
    mediaType,
    title,
    sortTitle: asNullableString(rawItem.titleSort),
    summary: asNullableString(rawItem.summary),
    originallyAvailableAt: asNullableString(rawItem.originallyAvailableAt),
    year: asNullableNumber(rawItem.year),
    durationMs: asNullableNumber(rawItem.duration),
    posterUrl: buildPlexAssetUrl(options.baseUrl, thumb, options.token),
    thumbUrl: buildPlexAssetUrl(options.baseUrl, art, options.token),
    addedAt: addedAtSeconds ? new Date(addedAtSeconds * 1000).toISOString() : null,
    updatedAt: updatedAtSeconds ? new Date(updatedAtSeconds * 1000).toISOString() : new Date().toISOString(),
    viewCount: asNullableNumber(rawItem.viewCount),
    lastViewedAt: asUnixTimestamp(rawItem.lastViewedAt),
    viewOffsetMs: asNullableNumber(rawItem.viewOffset),
    userRating: asNullableNumber(rawItem.userRating),
    audienceRating: asNullableNumber(rawItem.audienceRating),
    criticRating: asNullableNumber(rawItem.rating),
    showId: mediaType === "season"
      ? buildMediaItemId(asString(rawItem.parentRatingKey))
      : mediaType === "episode"
        ? buildMediaItemId(asString(rawItem.grandparentRatingKey))
        : null,
    seasonId: mediaType === "episode" ? buildMediaItemId(asString(rawItem.parentRatingKey)) : null,
    seasonNumber: mediaType === "season"
      ? asNullableNumber(rawItem.index)
      : mediaType === "episode"
        ? asNullableNumber(rawItem.parentIndex)
        : null,
    episodeNumber: mediaType === "episode" ? asNullableNumber(rawItem.index) : null,
    airDate: mediaType === "episode" ? asNullableString(rawItem.originallyAvailableAt) : null
  };
}

function mapCollection(
  section: PlexSection,
  libraryId: string,
  rawCollection: Record<string, unknown>
): CatalogCollectionRecord | null {
  const ratingKey = asString(rawCollection.ratingKey);
  const title = asString(rawCollection.title);

  if (!ratingKey || !title) {
    return null;
  }

  const children = Array.isArray(rawCollection.Metadata)
    ? rawCollection.Metadata
    : [];

  return {
    id: `plex-collection-${ratingKey}`,
    plexCollectionKey: ratingKey,
    libraryId,
    title,
    updatedAt: new Date().toISOString(),
    mediaItemIds: children
      .map((item) => buildMediaItemId(asString((item as Record<string, unknown>).ratingKey)))
      .filter((value): value is string => Boolean(value))
  };
}

async function plexFetch<T>(options: PlexSyncOptions, path: string): Promise<T> {
  const url = buildPlexRequestUrl(options, path);
  const redactedUrl = redactPlexToken(url);
  const maxAttempts = 4;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: "application/json"
        }
      });

      if (!response.ok) {
        throw new Error(`Plex request failed with status ${response.status} for ${url.pathname}`);
      }

      return response.json() as Promise<T>;
    } catch (error) {
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      lastError = new Error(`Plex fetch failed for ${redactedUrl}: ${detail}`);

      if (attempt < maxAttempts) {
        await sleep(attempt * 250);
        continue;
      }
    }
  }

  throw lastError ?? new Error(`Plex fetch failed for ${redactedUrl}`);
}

function buildPlexRequestUrl(options: PlexSyncOptions, path: string): URL {
  const url = new URL(path.replace(/^\/+/u, ""), ensureTrailingSlash(options.baseUrl));
  url.searchParams.set("X-Plex-Token", options.token);
  return url;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function redactPlexToken(url: URL): string {
  const redacted = new URL(url.toString());

  if (redacted.searchParams.has("X-Plex-Token")) {
    redacted.searchParams.set("X-Plex-Token", "[redacted]");
  }

  return redacted.toString();
}

function buildPlexAssetUrl(baseUrl: string, assetPath: string | null, token: string): string | null {
  if (!assetPath) {
    return null;
  }

  const url = new URL(assetPath.replace(/^\/+/u, ""), ensureTrailingSlash(baseUrl));
  url.searchParams.set("X-Plex-Token", token);
  return url.toString();
}

function buildMediaItemId(ratingKey: string | null): string | null {
  return ratingKey ? `plex-item-${ratingKey}` : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "string" && value.length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function asBoolean(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return value !== 0;
  }

  if (typeof value === "string") {
    return value === "1" || value.toLowerCase() === "true";
  }

  return false;
}

function asNullableNumber(value: unknown): number | null {
  return asNumber(value);
}

function asUnixTimestamp(value: unknown): string | null {
  const seconds = asNumber(value);
  return seconds ? new Date(seconds * 1000).toISOString() : null;
}

function asMediaType(value: unknown): CatalogMediaItemRecord["mediaType"] | null {
  return value === "show" || value === "season" || value === "episode" || value === "movie"
    ? value
    : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
