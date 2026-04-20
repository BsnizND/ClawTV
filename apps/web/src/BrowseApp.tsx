import { useEffect, useRef, useState } from "react";

import type {
  CatalogLatestResponse,
  CatalogMediaListResponse,
  CatalogMovieListResponse,
  CatalogMovieSummary,
  CatalogRecentResponse,
  CatalogShowListResponse,
  CommandResult
} from "@clawtv/contracts";

import { resolveApiUrl } from "./api";

const pageSize = 6;
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

type MediaFamily = "movie" | "tv";
type BrowseMode = "latest" | "recent" | "alphabet";
type Screen =
  | { name: "home" }
  | { name: "family"; family: MediaFamily }
  | { name: "letters"; family: MediaFamily }
  | { name: "titles"; family: MediaFamily; mode: BrowseMode; letter?: string; page: number }
  | { name: "seasons"; showId: string; showTitle: string; page: number }
  | { name: "episodes"; showId: string; showTitle: string; seasonId: string; seasonTitle: string; page: number };

interface TitleCard {
  id: string;
  title: string;
  kind: "item" | "show" | "season";
}

export function BrowseApp() {
  const [screen, setScreen] = useState<Screen>({ name: "home" });
  const [titles, setTitles] = useState<TitleCard[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playingTitle, setPlayingTitle] = useState<string | null>(null);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const listKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isListScreen(screen)) {
      setTitles([]);
      setLoading(false);
      setLoadingMore(false);
      setHasMore(false);
      setError(null);
      listKeyRef.current = null;
      return;
    }

    let cancelled = false;
    const currentListKey = getListKey(screen);
    const append = listKeyRef.current === currentListKey && screen.page > 0;

    setError(null);
    setHasMore(false);

    if (append) {
      setLoadingMore(true);
    } else {
      setTitles([]);
      setLoading(true);
      setLoadingMore(false);
      setPlayingTitle(null);
    }

    void loadTitles(screen)
      .then((nextTitles) => {
        if (!cancelled) {
          setTitles((currentTitles) => append ? mergeTitleCards(currentTitles, nextTitles) : nextTitles);
          setHasMore(nextTitles.length >= pageSize);
          listKeyRef.current = currentListKey;
        }
      })
      .catch((loadError) => {
        if (!cancelled) {
          if (!append) {
            setTitles([]);
          }
          setError(loadError instanceof Error ? loadError.message : "Could not load titles.");
        }
      })
      .finally(() => {
        if (!cancelled) {
          if (append) {
            setLoadingMore(false);
          } else {
            setLoading(false);
          }
        }
      });

    return () => {
      cancelled = true;
    };
  }, [screen]);

  useEffect(() => {
    if (!isListScreen(screen) || loading || loadingMore || !hasMore) {
      return;
    }

    const node = loadMoreRef.current;
    if (!node) {
      return;
    }

    const currentListKey = getListKey(screen);
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) {
        return;
      }

      observer.disconnect();
      setScreen((currentScreen) => {
        if (!isListScreen(currentScreen) || getListKey(currentScreen) !== currentListKey) {
          return currentScreen;
        }

        return {
          ...currentScreen,
          page: currentScreen.page + 1
        };
      });
    }, {
      rootMargin: "320px 0px"
    });

    observer.observe(node);
    return () => observer.disconnect();
  }, [screen, loading, loadingMore, hasMore, titles.length]);

  async function handleCardSelection(card: TitleCard) {
    setError(null);
    setPlayingTitle(null);

    if (card.kind === "show") {
      setScreen({
        name: "seasons",
        showId: card.id,
        showTitle: card.title,
        page: 0
      });
      return;
    }

    if (card.kind === "season") {
      if (screen.name !== "seasons") {
        setError("This season is missing its show context.");
        return;
      }

      setScreen({
        name: "episodes",
        showId: screen.showId,
        showTitle: screen.showTitle,
        seasonId: card.id,
        seasonTitle: card.title,
        page: 0
      });
      return;
    }

    try {
      const result = await postJson<CommandResult>("api/commands/play", { mediaItemId: card.id });

      if (!result.ok) {
        throw new Error(result.message || "Could not start playback.");
      }

      setPlayingTitle(card.title);
    } catch (playError) {
      setError(playError instanceof Error ? playError.message : "Could not start playback.");
    }
  }

  function goBack() {
    setError(null);
    setPlayingTitle(null);

    if (screen.name === "home") {
      return;
    }

    if (screen.name === "family") {
      setScreen({ name: "home" });
      return;
    }

    if (screen.name === "letters") {
      setScreen({ name: "family", family: screen.family });
      return;
    }

    if (screen.name === "seasons") {
      setScreen({ name: "titles", family: "tv", mode: "alphabet", letter: screen.showTitle[0]?.toUpperCase() ?? "A", page: 0 });
      return;
    }

    if (screen.name === "episodes") {
      setScreen({
        name: "seasons",
        showId: screen.showId,
        showTitle: screen.showTitle,
        page: 0
      });
      return;
    }

    if (screen.mode === "latest" || screen.mode === "recent") {
      setScreen({ name: "family", family: screen.family });
      return;
    }

    setScreen({ name: "letters", family: screen.family });
  }

  return (
    <main className="lv-shell">
      <section className={`lv-stage${isChoiceScreen(screen) ? " lv-stage-choice" : ""}`}>
        {screen.name !== "home" ? <button type="button" className="lv-back-button" onClick={goBack}>Back</button> : null}

        {error ? <p className="lv-message lv-message-error">{error}</p> : null}
        {playingTitle ? <p className="lv-message">Starting {playingTitle} on TV.</p> : null}

        {screen.name === "home" ? (
          <section className="lv-split-grid">
            <ActionButton
              label="Movies"
              icon="film"
              split
              onClick={() => setScreen({ name: "family", family: "movie" })}
            />
            <ActionButton
              label="TV"
              icon="tv"
              split
              onClick={() => setScreen({ name: "family", family: "tv" })}
            />
          </section>
        ) : null}

        {screen.name === "family" ? (
          <section className="lv-grid lv-family-grid">
            <ActionButton
              label={screen.family === "movie" ? "Latest Movies" : "Latest Episodes"}
              split
              onClick={() => setScreen({ name: "titles", family: screen.family, mode: "latest", page: 0 })}
            />
            <ActionButton
              label={screen.family === "movie" ? "Recently Added Movies" : "Recently Added Episodes"}
              split
              onClick={() => setScreen({ name: "titles", family: screen.family, mode: "recent", page: 0 })}
            />
            <ActionButton
              label="A-Z"
              split
              onClick={() => setScreen({ name: "letters", family: screen.family })}
            />
          </section>
        ) : null}

        {screen.name === "letters" ? (
          <section className="lv-grid lv-grid-letters">
            {alphabet.map((letter) => (
              <ActionButton
                key={letter}
                label={letter}
                onClick={() => setScreen({ name: "titles", family: screen.family, mode: "alphabet", letter, page: 0 })}
              />
            ))}
          </section>
        ) : null}

        {isListScreen(screen) ? (
          <section className="lv-list-screen">
            <h1 className="lv-heading">{headingFor(screen)}</h1>
            {loading ? <p className="lv-message">Loading.</p> : null}
            {!loading && titles.length === 0 && !error ? <p className="lv-message">No titles here.</p> : null}

            <div className="lv-list">
              {titles.map((card) => (
                <button
                  key={card.id}
                  type="button"
                  className="lv-title-button"
                  onClick={() => {
                    void handleCardSelection(card);
                  }}
                >
                  {card.title}
                </button>
              ))}
            </div>
            {loadingMore ? <p className="lv-message lv-message-secondary">Loading more.</p> : null}
            {hasMore ? <div ref={loadMoreRef} className="lv-load-more-sentinel" aria-hidden="true" /> : null}
          </section>
        ) : null}
      </section>
    </main>
  );
}

function ActionButton(input: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  split?: boolean;
  icon?: "film" | "tv";
}) {
  return (
    <button
      type="button"
      className={`lv-action-button${input.split ? " lv-action-button-split" : ""}`}
      onClick={input.onClick}
      disabled={input.disabled}
    >
      {input.icon ? (
        <span className="lv-icon-wrap" aria-hidden="true">
          {input.icon === "film" ? <FilmIcon /> : <TvIcon />}
        </span>
      ) : null}
      {input.label}
    </button>
  );
}

function headingFor(screen: Exclude<Screen, { name: "home" } | { name: "family" } | { name: "letters" }>): string;
function headingFor(screen: Screen): string {
  if (screen.name === "home") {
    return "";
  }

  if (screen.name === "family") {
    return screen.family === "movie" ? "Movies" : "TV";
  }

  if (screen.name === "letters") {
    return "Choose A Letter";
  }

  if (screen.name === "seasons") {
    return `${screen.showTitle} Seasons`;
  }

  if (screen.name === "episodes") {
    return `${screen.showTitle} ${screen.seasonTitle}`;
  }

  if (screen.mode === "latest") {
    return screen.family === "movie" ? "Latest Movies" : "Latest Episodes";
  }

  if (screen.mode === "recent") {
    return screen.family === "movie" ? "Recently Added Movies" : "Recently Added Episodes";
  }

  return screen.letter ?? "Titles";
}

async function loadTitles(screen: Extract<Screen, { name: "titles" }> | Extract<Screen, { name: "seasons" }> | Extract<Screen, { name: "episodes" }>): Promise<TitleCard[]> {
  const offset = screen.page * pageSize;

  if (screen.name === "seasons") {
    const response = await getJson<CatalogMediaListResponse>(withSearchParams("api/catalog/show-seasons", {
      showId: screen.showId,
      limit: String(pageSize),
      offset: String(offset)
    }));

    return response.items.map((season: CatalogMediaListResponse["items"][number]) => ({
      id: season.id,
      title: formatSeasonTitle(season.title, season.seasonNumber ?? null),
      kind: "season"
    }));
  }

  if (screen.name === "episodes") {
    const response = await getJson<CatalogMediaListResponse>(withSearchParams("api/catalog/season-episodes", {
      seasonId: screen.seasonId,
      limit: String(pageSize),
      offset: String(offset)
    }));

    return response.items.map((episode: CatalogMediaListResponse["items"][number]) => ({
      id: episode.id,
      title: formatEpisodeTitle(episode.title, episode.seasonNumber ?? null, episode.episodeNumber ?? null),
      kind: "item"
    }));
  }

  if (screen.mode === "latest") {
    const response = await getJson<CatalogLatestResponse>(withSearchParams("api/catalog/latest", {
      type: screen.family === "movie" ? "movie" : "episode",
      limit: String((screen.page + 1) * pageSize)
    }));

    return response.items.slice(offset, offset + pageSize).map((item: CatalogLatestResponse["items"][number]) => ({
      id: item.id,
      title: screen.family === "movie"
        ? item.title
        : formatShowItemTitle(item.showTitle, item.title),
      kind: "item"
    }));
  }

  if (screen.family === "movie" && screen.mode === "recent") {
    const response = await getJson<CatalogRecentResponse>(withSearchParams("api/catalog/recently-added", {
      type: "movie",
      limit: String((screen.page + 1) * pageSize)
    }));

    return response.items.slice(offset, offset + pageSize).map((item: CatalogRecentResponse["items"][number]) => ({
      id: item.id,
      title: item.title,
      kind: "item"
    }));
  }

  if (screen.family === "tv" && screen.mode === "recent") {
    const response = await getJson<CatalogRecentResponse>(withSearchParams("api/catalog/recently-added", {
      type: "episode",
      limit: String((screen.page + 1) * pageSize)
    }));

    return response.items.slice(offset, offset + pageSize).map((item: CatalogRecentResponse["items"][number]) => ({
      id: item.id,
      title: formatShowItemTitle(item.showTitle, item.title),
      kind: "item"
    }));
  }

  if (screen.family === "movie") {
    const response = await getJson<CatalogMovieListResponse>(withSearchParams("api/catalog/movies", {
      startsWith: screen.letter,
      limit: String(pageSize),
      offset: String(offset)
    }));

    return response.movies.map((movie: CatalogMovieSummary) => ({
      id: movie.id,
      title: movie.title,
      kind: "item"
    }));
  }

  const response = await getJson<CatalogShowListResponse>(withSearchParams("api/catalog/shows", {
    startsWith: screen.letter,
    limit: String(pageSize),
    offset: String(offset)
  }));

  return response.shows.map((show: CatalogShowListResponse["shows"][number]) => ({
    id: show.id,
    title: show.title,
    kind: "show"
  }));
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(resolveApiUrl(path));

  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`);
  }

  return parseJsonResponse<T>(response);
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(resolveApiUrl(path), {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`);
  }

  return parseJsonResponse<T>(response);
}

function withSearchParams(path: string, params: Record<string, string | undefined>): string {
  const url = new URL(resolveApiUrl(path));

  Object.entries(params).forEach(([key, value]) => {
    if (value) {
      url.searchParams.set(key, value);
    }
  });

  if (!import.meta.env.VITE_CLAWTV_API_ORIGIN) {
    return `${url.pathname}${url.search}`;
  }

  return url.toString();
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const contentType = response.headers.get("content-type") ?? "";

  if (!contentType.includes("application/json")) {
    throw new Error("This screen is not connected to the ClawTV server API yet.");
  }

  return response.json() as Promise<T>;
}

function isChoiceScreen(screen: Screen): boolean {
  return screen.name === "home" || screen.name === "family";
}

function isListScreen(screen: Screen): screen is Extract<Screen, { name: "titles" }> | Extract<Screen, { name: "seasons" }> | Extract<Screen, { name: "episodes" }> {
  return screen.name === "titles" || screen.name === "seasons" || screen.name === "episodes";
}

function getListKey(screen: Extract<Screen, { name: "titles" }> | Extract<Screen, { name: "seasons" }> | Extract<Screen, { name: "episodes" }>): string {
  if (screen.name === "titles") {
    return `titles:${screen.family}:${screen.mode}:${screen.letter ?? ""}`;
  }

  if (screen.name === "seasons") {
    return `seasons:${screen.showId}`;
  }

  return `episodes:${screen.seasonId}`;
}

function mergeTitleCards(currentTitles: TitleCard[], nextTitles: TitleCard[]): TitleCard[] {
  const seenIds = new Set(currentTitles.map((title) => title.id));
  const appendedTitles = nextTitles.filter((title) => !seenIds.has(title.id));
  return currentTitles.concat(appendedTitles);
}

function formatShowItemTitle(showTitle: string | null, title: string): string {
  return showTitle ? `${showTitle} - ${title}` : title;
}

function formatSeasonTitle(title: string, seasonNumber: number | null): string {
  if (typeof seasonNumber === "number") {
    return `Season ${seasonNumber}`;
  }

  return title;
}

function formatEpisodeTitle(title: string, seasonNumber: number | null, episodeNumber: number | null): string {
  if (typeof seasonNumber === "number" && typeof episodeNumber === "number") {
    return `S${String(seasonNumber).padStart(2, "0")}E${String(episodeNumber).padStart(2, "0")} - ${title}`;
  }

  return title;
}

function FilmIcon() {
  return (
    <svg viewBox="0 0 64 64" className="lv-icon" role="presentation">
      <rect x="10" y="12" width="44" height="40" rx="4" />
      <line x1="22" y1="12" x2="22" y2="52" />
      <line x1="42" y1="12" x2="42" y2="52" />
      <circle cx="16" cy="20" r="2.5" />
      <circle cx="16" cy="32" r="2.5" />
      <circle cx="16" cy="44" r="2.5" />
      <circle cx="48" cy="20" r="2.5" />
      <circle cx="48" cy="32" r="2.5" />
      <circle cx="48" cy="44" r="2.5" />
    </svg>
  );
}

function TvIcon() {
  return (
    <svg viewBox="0 0 64 64" className="lv-icon" role="presentation">
      <rect x="10" y="16" width="44" height="30" rx="4" />
      <line x1="24" y1="54" x2="40" y2="54" />
      <line x1="32" y1="46" x2="32" y2="54" />
      <line x1="24" y1="10" x2="32" y2="16" />
      <line x1="40" y1="10" x2="32" y2="16" />
    </svg>
  );
}
