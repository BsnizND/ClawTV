# ClawTV

ClawTV is a self-hosted, agent-first TV playback system for Android TV devices such as NVIDIA Shield.

It is built for a very specific kind of experience: you should be able to turn on the TV, land in a simple fullscreen receiver, and use an agentic control layer to put something on without digging through app menus. That makes it interesting not just as a home theater tool, but as an accessibility project for low-vision viewers and low-friction viewing.

## Why This Is Interesting

Most TV software assumes the viewer will browse visually, manage apps, and make choices with a remote. ClawTV explores the opposite model:

- the TV screen stays simple
- playback state lives on the server
- control happens through an agent-first command layer
- the receiver behaves more like a channel endpoint than a content browser

That makes the project useful for:

- low-vision viewing where menu-heavy UIs are a bad fit
- ambient or curated playback
- agent-driven control of a personal media library
- Android TV / Shield setups where you want a thin receiver instead of another giant app

## What It Does

ClawTV combines four pieces:

- a server that owns queue, playback state, session state, and media resolution
- a thin fullscreen receiver for web and Android TV
- a CLI for human and automation control
- an installable OpenClaw skill that wraps the CLI

Today it supports:

- Plex-backed catalog sync
- server-proxied HLS playback
- playback state persistence
- transport controls like pause, resume, seek, next, stop, and refresh
- catalog browsing with `search`, `list-shows`, `list-collections`, and `recently-added`
- a native Android TV receiver using `Media3`

## Architecture In One Sentence

ClawTV is an agentic control layer for watching movies and TV on Android TV: the agent decides what goes on screen, the server owns playback state, and the receiver just plays it.

## Quick Start

```bash
pnpm install
pnpm build
pnpm dev:server
pnpm dev:web
pnpm --filter @clawtv/cli dev status
```

Useful environment variables:

```bash
export CLAWTV_BASE_PATH=/ClawTV
export CLAWTV_SERVER_ORIGIN=http://localhost:8787/ClawTV/
export CLAWTV_DATA_DIR=./data
export PLEX_BASE_URL=http://127.0.0.1:32400/
export PLEX_TOKEN=your-plex-token
```

## CLI Examples

```bash
pnpm --filter @clawtv/cli dev now-playing
pnpm --filter @clawtv/cli dev search --query "john oliver" --type episode
pnpm --filter @clawtv/cli dev list-shows --limit 20
pnpm --filter @clawtv/cli dev recently-added --type movie --limit 10
pnpm --filter @clawtv/cli dev play --title "The Matrix"
pnpm --filter @clawtv/cli dev play-latest --series "Last Week Tonight with John Oliver"
pnpm --filter @clawtv/cli dev shuffle --show "Bluey"
pnpm --filter @clawtv/cli dev pause
pnpm --filter @clawtv/cli dev resume
pnpm --filter @clawtv/cli dev seek --by -4m
pnpm --filter @clawtv/cli dev stop
```

## OpenClaw Skill

The repo ships an installable skill under `skills/clawtv-control`.

That skill gives an OpenClaw agent a stable way to:

- inspect current playback and server status
- browse the synced library
- search titles or series
- play, shuffle, pause, resume, seek, skip, refresh, and stop

## Android TV

The Android TV app under `apps/android-tv` is intentionally thin:

- it polls the ClawTV server for playback state
- it plays the assigned HLS stream with native `Media3`
- it does not own queue logic or library browsing

## Docs

- [Technical Architecture](docs/technical-architecture.md)
- [Deployment Notes](docs/deployment.md)
