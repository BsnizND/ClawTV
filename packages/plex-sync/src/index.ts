import type { SyncMode } from "@clawtv/contracts";
import type {
  CatalogCollectionRecord,
  CatalogLibraryRecord,
  CatalogMediaItemRecord,
  CatalogSyncPayload
} from "@clawtv/db";

export interface PlexSyncOptions {
  baseUrl: string;
  token: string;
  mode: SyncMode;
  library?: string;
}

interface PlexSection {
  key: string;
  title: string;
  type: string;
}

interface PlexMediaContainerResponse {
  MediaContainer?: {
    Directory?: Array<Record<string, unknown>>;
    Metadata?: Array<Record<string, unknown>>;
  };
}

export async function syncPlexCatalog(options: PlexSyncOptions): Promise<CatalogSyncPayload> {
  const sectionsResponse = await plexFetch<PlexMediaContainerResponse>(options, "library/sections");
  const allSections = (sectionsResponse.MediaContainer?.Directory ?? [])
    .map(mapSection)
    .filter((section): section is PlexSection => Boolean(section));
  const sections = options.library
    ? allSections.filter((section) => section.title.toLowerCase() === options.library?.toLowerCase())
    : allSections;

  const libraries: CatalogLibraryRecord[] = [];
  const mediaItemsById = new Map<string, CatalogMediaItemRecord>();
  const collectionsById = new Map<string, CatalogCollectionRecord>();

  for (const section of sections) {
    const libraryId = `plex-library-${section.key}`;
    libraries.push({
      id: libraryId,
      plexLibraryKey: section.key,
      name: section.title,
      type: section.type,
      updatedAt: new Date().toISOString()
    });

    const itemsResponse = await plexFetch<PlexMediaContainerResponse>(options, `library/sections/${section.key}/all`);
    const rawItems = itemsResponse.MediaContainer?.Metadata ?? [];

    rawItems.forEach((rawItem) => {
      const mapped = mapMediaItem(libraryId, rawItem, options);

      if (mapped) {
        mediaItemsById.set(mapped.id, mapped);
      }
    });

    if (section.type === "show") {
      await hydrateShowSectionChildren({
        options,
        libraryId,
        rawShows: rawItems,
        mediaItemsById
      });
    }

    const collectionsResponse = await plexFetch<PlexMediaContainerResponse>(options, `library/sections/${section.key}/collections`);
    const rawCollections = collectionsResponse.MediaContainer?.Metadata ?? [];

    rawCollections.forEach((rawCollection) => {
      const mapped = mapCollection(section, libraryId, rawCollection);

      if (mapped) {
        collectionsById.set(mapped.id, mapped);
      }
    });
  }

  return {
    libraries,
    mediaItems: [...mediaItemsById.values()],
    collections: [...collectionsById.values()]
  };
}

function mapSection(rawSection: Record<string, unknown>): PlexSection | null {
  if (typeof rawSection.key !== "string" || typeof rawSection.title !== "string" || typeof rawSection.type !== "string") {
    return null;
  }

  return {
    key: rawSection.key,
    title: rawSection.title,
    type: rawSection.type
  };
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
  const url = new URL(path.replace(/^\/+/u, ""), ensureTrailingSlash(options.baseUrl));
  url.searchParams.set("X-Plex-Token", options.token);
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
