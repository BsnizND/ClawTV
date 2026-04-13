import { useEffect, useMemo, useRef, useState } from "react";
import Hls from "hls.js";

import type {
  ClientPlaybackState,
  PlaybackDiagnosticsUpdateRequest,
  PlaybackSnapshot
} from "@clawtv/contracts";
import { resolveRelativeUrl } from "@clawtv/core";

const apiOrigin = import.meta.env.VITE_CLAWTV_API_ORIGIN;
const handledReceiverCommandStorageKey = "clawtv:last-handled-receiver-command";
const refreshRecoveryGraceMs = 15000;

const fallbackPlayback: PlaybackSnapshot = {
  sessionId: "living-room-shield",
  queueId: null,
  playbackState: "idle",
  playbackPositionMs: 0,
  controlRevision: 0,
  receiverCommand: null,
  updatedAt: null,
  queueLength: 0,
  currentQueuePosition: null,
  currentItem: null,
  streamPath: null,
  diagnostics: null
};

export function App() {
  const [playback, setPlayback] = useState<PlaybackSnapshot>(fallbackPlayback);
  const [connected, setConnected] = useState(false);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [isLocallyBuffering, setIsLocallyBuffering] = useState(false);
  const [isLocallyPlaying, setIsLocallyPlaying] = useState(false);
  const [refreshRecoveryUntil, setRefreshRecoveryUntil] = useState(0);
  const [receiverRefreshNonce, setReceiverRefreshNonce] = useState(0);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const lastProgressSyncAtRef = useRef(0);
  const lastServerAlignedItemIdRef = useRef<string | null>(null);
  const lastAppliedControlRevisionRef = useRef<number | null>(null);
  const lastReportedPlaybackStateRef = useRef<ClientPlaybackState | null>(null);
  const autoplayRetryTimeoutRef = useRef<number | null>(null);
  const pendingSeekSecondsRef = useRef<number | null>(null);

  async function loadState() {
    const nextPlayback = await getJson<PlaybackSnapshot>("api/playback/current");
    setPlayback(nextPlayback);
    setConnected(true);
  }

  useEffect(() => {
    let cancelled = false;

    async function refresh() {
      try {
        const nextPlayback = await getJson<PlaybackSnapshot>("api/playback/current");

        if (!cancelled) {
          setPlayback(nextPlayback);
          setConnected(true);
        }
      } catch {
        if (!cancelled) {
          setPlayback(fallbackPlayback);
          setConnected(false);
        }
      }
    }

    void refresh();
    const intervalId = window.setInterval(() => {
      void refresh();
    }, 2000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    setPlayerError(null);
    setIsLocallyBuffering(false);
    setIsLocallyPlaying(false);
    lastProgressSyncAtRef.current = 0;
    lastServerAlignedItemIdRef.current = null;
    lastAppliedControlRevisionRef.current = null;
    lastReportedPlaybackStateRef.current = null;
    pendingSeekSecondsRef.current = null;
  }, [playback.currentItem?.id]);

  useEffect(() => {
    if (refreshRecoveryUntil <= 0) {
      return;
    }

    const remainingMs = refreshRecoveryUntil - Date.now();

    if (remainingMs <= 0) {
      clearRefreshRecoveryState(setRefreshRecoveryUntil);
      return;
    }

    const timeoutId = window.setTimeout(() => {
      clearRefreshRecoveryState(setRefreshRecoveryUntil);
    }, remainingMs + 50);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [refreshRecoveryUntil]);

  useEffect(() => {
    const receiverCommand = playback.receiverCommand;

    if (!receiverCommand || receiverCommand.type !== "refresh") {
      return;
    }

    try {
      flushPlaybackState();
      const lastHandledCommandId = window.localStorage.getItem(handledReceiverCommandStorageKey);

      if (lastHandledCommandId === receiverCommand.id) {
        sendJsonBeacon("api/playback/receiver-command/ack", {
          commandId: receiverCommand.id,
          sessionId: playback.sessionId ?? undefined
        });
        return;
      }

      window.localStorage.setItem(handledReceiverCommandStorageKey, receiverCommand.id);
      const recoveryUntil = Date.now() + refreshRecoveryGraceMs;
      pendingSeekSecondsRef.current = videoRef.current?.currentTime ?? null;
      setRefreshRecoveryUntil(recoveryUntil);
      setPlayerError(null);
      setIsLocallyPlaying(false);
      setIsLocallyBuffering(true);
    } catch {
      // Fall through and still attempt the soft refresh once.
    }

    sendJsonBeacon("api/playback/receiver-command/ack", {
      commandId: receiverCommand.id,
      sessionId: playback.sessionId ?? undefined
    });
    void loadState();
    setReceiverRefreshNonce((currentValue) => currentValue + 1);
  }, [playback.receiverCommand, playback.sessionId]);

  const streamUrl = useMemo(() => {
    if (!playback.streamPath || !playback.currentItem) {
      return null;
    }

    const url = apiOrigin
      ? new URL(playback.streamPath, apiOrigin)
      : new URL(playback.streamPath, window.location.href);

    url.searchParams.set("currentItemId", playback.currentItem.id);
    return url.toString();
  }, [playback.currentItem, playback.streamPath]);

  async function syncPlaybackPosition() {
    const video = videoRef.current;

    try {
      const nextPlayback = await postJson<PlaybackSnapshot>("api/playback/state", {
        positionMs: video ? Math.round(video.currentTime * 1000) : 0,
        sessionId: playback.sessionId ?? undefined
      });
      setPlayback(nextPlayback);
    } catch {
      // Keep playback locally responsive even if the server misses one client event.
    }
  }

  async function reportClientPlaybackState(
    state: ClientPlaybackState,
    options?: { force?: boolean }
  ) {
    const video = videoRef.current;
    const nextPositionMs = video ? Math.round(video.currentTime * 1000) : playback.playbackPositionMs;

    setPlayback((currentPlayback) => ({
      ...currentPlayback,
      playbackState: currentPlayback.currentItem ? state : "idle",
      playbackPositionMs: nextPositionMs
    }));

    if (!options?.force && lastReportedPlaybackStateRef.current === state) {
      return;
    }

    lastReportedPlaybackStateRef.current = state;

    try {
      const nextPlayback = await postJson<PlaybackSnapshot>("api/playback/state", {
        state,
        positionMs: nextPositionMs,
        sessionId: playback.sessionId ?? undefined
      });
      setPlayback(nextPlayback);
    } catch {
      // Keep the local UI responsive if one state sync misses the server.
    }
  }

  function flushPlaybackState() {
    const video = videoRef.current;

    if (!video || !playback.currentItem) {
      return;
    }

    sendJsonBeacon("api/playback/state", {
      positionMs: Math.round(video.currentTime * 1000),
      sessionId: playback.sessionId ?? undefined
    });
  }

  async function advanceQueue() {
    try {
      await postJson("api/commands/next", {});
      await loadState();
    } catch {
      setPlayerError("Could not advance to the next queued item.");
    }
  }

  async function reportDiagnostics(payload: PlaybackDiagnosticsUpdateRequest) {
    try {
      const response = await postJson<{ diagnostics: PlaybackSnapshot["diagnostics"] }>("api/playback/diagnostics", payload);
      setPlayback((currentPlayback) => ({
        ...currentPlayback,
        diagnostics: response.diagnostics
      }));
    } catch {
      // Diagnostics are best-effort only.
    }
  }

  function scheduleAutoplayRetry() {
    if (autoplayRetryTimeoutRef.current !== null) {
      window.clearTimeout(autoplayRetryTimeoutRef.current);
    }

    autoplayRetryTimeoutRef.current = window.setTimeout(() => {
      autoplayRetryTimeoutRef.current = null;
      const video = videoRef.current;

      if (!video || playback.playbackState === "paused") {
        return;
      }

      void video.play().catch(() => {
        scheduleAutoplayRetry();
      });
    }, 1500);
  }

  function clearAutoplayRetry() {
    if (autoplayRetryTimeoutRef.current !== null) {
      window.clearTimeout(autoplayRetryTimeoutRef.current);
      autoplayRetryTimeoutRef.current = null;
    }
  }

  function applyDesiredPlaybackPosition(force = false) {
    const video = videoRef.current;
    const currentItemId = playback.currentItem?.id ?? null;

    if (!video || !currentItemId) {
      return;
    }

    const fallbackResumePositionMs = pendingSeekSecondsRef.current !== null
      ? Math.round(pendingSeekSecondsRef.current * 1000)
      : 0;

    if (playback.playbackPositionMs <= 0) {
      if (fallbackResumePositionMs <= 0) {
        return;
      }

      const fallbackResumeSeconds = fallbackResumePositionMs / 1000;

      if (video.readyState >= 1) {
        video.currentTime = fallbackResumeSeconds;
        lastServerAlignedItemIdRef.current = currentItemId;
        lastAppliedControlRevisionRef.current = playback.controlRevision;
        pendingSeekSecondsRef.current = null;
        return;
      }

      pendingSeekSecondsRef.current = fallbackResumeSeconds;
      return;
    }

    const desiredPositionMs = Math.max(playback.playbackPositionMs, fallbackResumePositionMs);
    const serverTimeSeconds = desiredPositionMs / 1000;
    const shouldApplyExplicitControlSync = lastAppliedControlRevisionRef.current !== playback.controlRevision;
    const needsInitialAlignment = lastServerAlignedItemIdRef.current !== currentItemId;
    const driftSeconds = serverTimeSeconds - video.currentTime;
    const shouldJumpForward = driftSeconds > 5;
    const shouldResyncPausedPlayback = video.paused && Math.abs(driftSeconds) > 1;
    const shouldSeekNow = force || needsInitialAlignment || shouldApplyExplicitControlSync || shouldJumpForward || shouldResyncPausedPlayback;

    if (!shouldSeekNow) {
      return;
    }

    if (video.readyState >= 1) {
      video.currentTime = serverTimeSeconds;
      lastServerAlignedItemIdRef.current = currentItemId;
      lastAppliedControlRevisionRef.current = playback.controlRevision;
      pendingSeekSecondsRef.current = null;
      return;
    }

    pendingSeekSecondsRef.current = serverTimeSeconds;
  }

  function applyPendingSeek() {
    const video = videoRef.current;

    if (!video || pendingSeekSecondsRef.current === null || video.readyState < 1) {
      return;
    }

    video.currentTime = pendingSeekSecondsRef.current;
    lastServerAlignedItemIdRef.current = playback.currentItem?.id ?? null;
    lastAppliedControlRevisionRef.current = playback.controlRevision;
    pendingSeekSecondsRef.current = null;
  }

  useEffect(() => {
    const video = videoRef.current;

    if (!video) {
      return;
    }

    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    video.removeAttribute("src");
    video.load();

    if (!streamUrl) {
      void reportDiagnostics({
        playbackMode: "idle",
        nativeHlsSupported: video.canPlayType("application/vnd.apple.mpegurl") !== "",
        hlsJsSupported: Hls.isSupported(),
        autoplayStatus: "unknown",
        lastEvent: "idle",
        errorMessage: null
      });
      return;
    }

    const nativeHlsSupported = video.canPlayType("application/vnd.apple.mpegurl") !== "";
    const hlsJsSupported = Hls.isSupported();

    if (hlsJsSupported) {
      void reportDiagnostics({
        playbackMode: "hls.js",
        nativeHlsSupported,
        hlsJsSupported,
        autoplayStatus: "unknown",
        lastEvent: "hlsjs-selected",
        errorMessage: null
      });
      const hls = new Hls();
      hlsRef.current = hls;
      hls.loadSource(streamUrl);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (playback.playbackState !== "paused") {
          void video.play().catch(() => {
            setPlayerError(null);
            setIsLocallyBuffering(true);
            scheduleAutoplayRetry();

            void reportDiagnostics({
              playbackMode: "hls.js",
              nativeHlsSupported,
              hlsJsSupported,
              autoplayStatus: "blocked",
              lastEvent: "hlsjs-autoplay-blocked",
              errorMessage: "Autoplay was blocked by the browser."
            });
          });
        }
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) {
          return;
        }

        setPlayerError("This browser could not start the HLS playback session.");
        void reportDiagnostics({
          playbackMode: "hls.js",
          nativeHlsSupported,
          hlsJsSupported,
          autoplayStatus: "failed",
          lastEvent: `hlsjs-error-${data.type}`,
          errorMessage: data.error?.message ?? `Fatal hls.js error: ${data.type}`
        });
      });

      return () => {
        clearAutoplayRetry();
        hls.destroy();
        hlsRef.current = null;
      };
    }

    if (nativeHlsSupported) {
      void reportDiagnostics({
        playbackMode: "native-hls",
        nativeHlsSupported,
        hlsJsSupported,
        autoplayStatus: "unknown",
        lastEvent: "native-hls-selected",
        errorMessage: null
      });
      video.src = streamUrl;

      if (playback.playbackState !== "paused") {
        void video.play().catch(() => {
          setPlayerError(null);
          setIsLocallyBuffering(true);
          scheduleAutoplayRetry();

          void reportDiagnostics({
            playbackMode: "native-hls",
            nativeHlsSupported,
            hlsJsSupported,
            autoplayStatus: "blocked",
            lastEvent: "native-hls-autoplay-blocked",
            errorMessage: "Autoplay was blocked by the browser."
          });
        });
      }

      return;
    }

    setPlayerError("This browser does not support the ClawTV playback stream.");
    void reportDiagnostics({
      playbackMode: "unsupported",
      nativeHlsSupported,
      hlsJsSupported,
      autoplayStatus: "failed",
      lastEvent: "hls-unsupported",
      errorMessage: "Neither native HLS nor hls.js playback is supported in this browser."
    });
  }, [playback.playbackState, receiverRefreshNonce, refreshRecoveryUntil, streamUrl]);

  useEffect(() => {
    applyDesiredPlaybackPosition();
  }, [playback.controlRevision, playback.currentItem?.id, playback.playbackPositionMs, playback.playbackState]);

  useEffect(() => {
    const video = videoRef.current;

    if (!video || !playback.currentItem) {
      return;
    }

    if (playback.playbackState === "paused" && !video.paused) {
      clearAutoplayRetry();
      setIsLocallyBuffering(false);
      setIsLocallyPlaying(false);
      video.pause();
      return;
    }

    if ((playback.playbackState === "playing" || playback.playbackState === "loading") && video.paused) {
      void video.play().catch(() => {
        setPlayerError(null);
        setIsLocallyBuffering(true);
        scheduleAutoplayRetry();
      });
    }
  }, [playback.currentItem, playback.playbackState, refreshRecoveryUntil]);

  useEffect(() => {
    function handleVisibilityChange() {
      if (document.visibilityState === "hidden") {
        flushPlaybackState();
      }
    }

    window.addEventListener("pagehide", flushPlaybackState);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("pagehide", flushPlaybackState);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [playback.currentItem, playback.sessionId]);

  const showPlayer = Boolean(streamUrl && playback.currentItem);
  const isRefreshRecoveryActive = refreshRecoveryUntil > Date.now();
  const showBufferingOverlay = !playerError
    && playback.playbackState !== "paused"
    && (isLocallyBuffering || (!isLocallyPlaying && playback.playbackState === "loading"));
  const overlayLabel = !connected
    ? "Waiting For ClawTV"
    : playerError
      ? "Playback Needs Attention"
      : isRefreshRecoveryActive && !isLocallyPlaying
        ? "Reconnecting Playback"
      : showBufferingOverlay
        ? "Buffering"
      : playback.playbackState === "paused"
          ? "Paused"
          : null;
  const overlayMessage = playerError
    ?? (isRefreshRecoveryActive && !isLocallyPlaying ? "ClawTV is restoring the stream after the refresh." : null);

  if (showPlayer) {
    return (
      <main className="player-shell">
        <video
          key={`${playback.currentItem?.id ?? "idle"}:${receiverRefreshNonce}`}
          ref={videoRef}
          className="player-video-fullscreen"
          playsInline
          preload="auto"
          poster={playback.currentItem?.posterUrl ?? undefined}
          onCanPlay={() => {
            setPlayerError(null);
            clearAutoplayRetry();
            setIsLocallyBuffering(false);
            applyPendingSeek();
            void reportDiagnostics({
              playbackMode: playback.diagnostics?.playbackMode ?? "idle",
              nativeHlsSupported: Boolean(playback.diagnostics?.nativeHlsSupported),
              hlsJsSupported: Boolean(playback.diagnostics?.hlsJsSupported),
              autoplayStatus: "started",
              lastEvent: "can-play",
              errorMessage: null
            });
          }}
          onPlay={() => {
            setPlayerError(null);
            clearAutoplayRetry();
            setIsLocallyPlaying(true);
            setIsLocallyBuffering(false);
            void reportClientPlaybackState("playing");
            void reportDiagnostics({
              playbackMode: playback.diagnostics?.playbackMode ?? "idle",
              nativeHlsSupported: Boolean(playback.diagnostics?.nativeHlsSupported),
              hlsJsSupported: Boolean(playback.diagnostics?.hlsJsSupported),
              autoplayStatus: "started",
              lastEvent: "play",
              errorMessage: null
            });
          }}
          onPlaying={() => {
            setPlayerError(null);
            clearAutoplayRetry();
            applyPendingSeek();
            setIsLocallyPlaying(true);
            setIsLocallyBuffering(false);
            clearRefreshRecoveryState(setRefreshRecoveryUntil);
            void reportClientPlaybackState("playing", { force: true });
          }}
          onPause={() => {
            clearAutoplayRetry();
            setIsLocallyPlaying(false);
            setIsLocallyBuffering(false);
            if (videoRef.current?.ended) {
              return;
            }

            void reportClientPlaybackState("paused");
          }}
          onSeeked={() => {
            setIsLocallyBuffering(false);
            lastProgressSyncAtRef.current = 0;
            void syncPlaybackPosition();
          }}
          onSeeking={() => {
            setIsLocallyBuffering(true);
            void reportClientPlaybackState("loading");
          }}
          onWaiting={() => {
            setIsLocallyBuffering(true);
            setIsLocallyPlaying(false);
            void reportClientPlaybackState("loading");
          }}
          onTimeUpdate={() => {
            const video = videoRef.current;

            if (!video) {
              return;
            }

            const nextPositionMs = Math.round(video.currentTime * 1000);
            setPlayback((currentPlayback) => ({
              ...currentPlayback,
              playbackPositionMs: nextPositionMs
            }));

            if (Date.now() - lastProgressSyncAtRef.current >= 5000) {
              lastProgressSyncAtRef.current = Date.now();
              void syncPlaybackPosition();
            }
          }}
          onEnded={() => {
            clearAutoplayRetry();
            setIsLocallyPlaying(false);
            setIsLocallyBuffering(false);
            void advanceQueue();
          }}
          onError={() => {
            clearAutoplayRetry();
            setIsLocallyPlaying(false);
            setIsLocallyBuffering(false);
            setPlayerError("This browser could not start the current Plex stream.");
            void reportClientPlaybackState("error", { force: true });
          }}
        />

        {overlayLabel ? (
          <div className="player-status-overlay">
            <div className="player-status-card">
              <h1>{overlayLabel}</h1>
              {overlayMessage ? <p>{overlayMessage}</p> : null}
            </div>
          </div>
        ) : null}
      </main>
    );
  }

  return (
    <main className="splash-screen">
      <div className="splash-orb" />
      <section className="splash-card">
        <span className="splash-kicker">Ambient Television</span>
        <h1>ClawTV</h1>
        <p>
          Waiting for the server, CLI, or automation layer to queue the next item.
        </p>
        <div className="splash-status" data-connected={connected}>
          <span className="status-dot" />
          {connected ? "Receiver Ready" : "Waiting For Server"}
        </div>
      </section>
    </main>
  );
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(apiOrigin
    ? resolveRelativeUrl(apiOrigin, path)
    : path);

  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`);
  }

  return response.json() as Promise<T>;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(apiOrigin
    ? resolveRelativeUrl(apiOrigin, path)
    : path, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`);
  }

  return response.json() as Promise<T>;
}

function sendPlaybackStateBeacon(path: string, body: unknown): void {
  sendJsonBeacon(path, body);
}

function sendJsonBeacon(path: string, body: unknown): void {
  const target = apiOrigin
    ? resolveRelativeUrl(apiOrigin, path)
    : path;

  if (typeof navigator.sendBeacon === "function") {
    const payload = new Blob([JSON.stringify(body)], {
      type: "application/json"
    });
    navigator.sendBeacon(target, payload);
    return;
  }

  void fetch(target, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body),
    keepalive: true
  });
}

function clearRefreshRecoveryState(setRefreshRecoveryUntil: (value: number) => void): void {
  setRefreshRecoveryUntil(0);
}
