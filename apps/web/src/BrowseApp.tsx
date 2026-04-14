import { useEffect, useState } from "react";

import type {
  CatalogMovieListResponse,
  CatalogMovieSummary,
  CatalogRecentResponse,
  CatalogShowListResponse,
  CommandResult
} from "@clawtv/contracts";

const apiOrigin = import.meta.env.VITE_CLAWTV_API_ORIGIN;
const pageSize = 6;
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

type MediaFamily = "movie" | "tv";
type BrowseMode = "recent" | "alphabet";
type Screen =
  | { name: "home" }
  | { name: "family"; family: MediaFamily }
  | { name: "letters"; family: MediaFamily }
  | { name: "titles"; family: MediaFamily; mode: BrowseMode; letter?: string; page: number };

interface TitleCard {
  id: string;
  title: string;
  kind: "item" | "show";
}

export function BrowseApp() {
  const [screen, setScreen] = useState<Screen>({ name: "home" });
  const [titles, setTitles] = useState<TitleCard[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playingTitle, setPlayingTitle] = useState<string | null>(null);

  useEffect(() => {
    if (screen.name !== "titles") {
      setTitles([]);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    setPlayingTitle(null);

    void loadTitles(screen)
      .then((nextTitles) => {
        if (!cancelled) {
          setTitles(nextTitles);
        }
      })
      .catch((loadError) => {
        if (!cancelled) {
          setTitles([]);
          setError(loadError instanceof Error ? loadError.message : "Could not load titles.");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [screen]);

  async function startPlayback(card: TitleCard) {
    setError(null);
    setPlayingTitle(null);

    try {
      const result = card.kind === "show"
        ? await postJson<CommandResult>("api/commands/play-latest", { series: card.title })
        : await postJson<CommandResult>("api/commands/play", { mediaItemId: card.id });

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

    if (screen.mode === "recent") {
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
          <section className="lv-split-grid">
            <ActionButton
              label={screen.family === "movie" ? "New Additions" : "Latest Episodes"}
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

        {screen.name === "titles" ? (
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
                    void startPlayback(card);
                  }}
                >
                  {card.title}
                </button>
              ))}
            </div>

            <div className="lv-pagination">
              <ActionButton
                label="Previous"
                onClick={() => setScreen({ ...screen, page: Math.max(0, screen.page - 1) })}
                disabled={screen.page === 0 || loading}
              />
              <ActionButton
                label="Next"
                onClick={() => setScreen({ ...screen, page: screen.page + 1 })}
                disabled={loading || titles.length < pageSize}
              />
            </div>
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

  if (screen.mode === "recent") {
    return screen.family === "movie" ? "New Additions" : "Latest Episodes";
  }

  return screen.letter ?? "Titles";
}

async function loadTitles(screen: Extract<Screen, { name: "titles" }>): Promise<TitleCard[]> {
  const offset = screen.page * pageSize;

  if (screen.family === "movie" && screen.mode === "recent") {
    const response = await getJson<CatalogRecentResponse>(withSearchParams("api/catalog/recently-added", {
      type: "movie",
      limit: String((screen.page + 1) * pageSize)
    }));

    return response.items.slice(offset, offset + pageSize).map((item) => ({
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

    return response.items.slice(offset, offset + pageSize).map((item) => ({
      id: item.id,
      title: item.showTitle ? `${item.showTitle} - ${item.title}` : item.title,
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

  return response.shows.map((show) => ({
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

function resolveApiUrl(path: string): string {
  const normalizedPath = path.replace(/^\/+/u, "");

  if (apiOrigin) {
    return new URL(normalizedPath, apiOrigin).toString();
  }

  return new URL(normalizedPath, window.location.href).toString();
}

function withSearchParams(path: string, params: Record<string, string | undefined>): string {
  const url = new URL(resolveApiUrl(path));

  Object.entries(params).forEach(([key, value]) => {
    if (value) {
      url.searchParams.set(key, value);
    }
  });

  if (!apiOrigin) {
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
