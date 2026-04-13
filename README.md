# ClawTV

ClawTV is a self-hosted TV playback system for turning a media library into a curated channel.

The project is built around one simple idea: the screen should stay thin, while scheduling, queueing, and transport control live in a server and CLI that can also be driven by an agent.

## Why This Exists

Most TV and streaming interfaces are optimized for browsing, menus, and manual choice. ClawTV explores a different model:

- the display acts like a receiver, not a dashboard
- playback state is owned by the server
- a human or agent can decide what should play next
- the result should feel closer to a channel than an app launcher

The long-term goal is a system that works well for ambient playback, low-friction living room use, and accessibility-oriented control surfaces.

## What The Repo Contains

- `apps/server`: HTTP control plane and playback authority
- `apps/web`: fullscreen receiver client
- `apps/android-tv`: thin native Android TV receiver
- `apps/cli`: operator and automation command surface
- `packages/contracts`: shared API and state types
- `packages/core`: shared helpers
- `packages/db`: SQLite-backed state and catalog queries
- `packages/plex-sync`: Plex metadata ingestion
- `skills/clawtv-control`: installable OpenClaw skill for ClawTV control

## Current Model

ClawTV follows a deliberate split:

- the server owns queue, playback state, playback position, and catalog-backed resolution
- the receiver only plays the assigned item and reports local state
- the CLI is the stable control surface for humans, scripts, and agent skills

That keeps the playback system debuggable and avoids putting business logic in the client.

## Current Capabilities

- SQLite-backed session, queue, and playback state
- Plex-backed catalog sync for shows, episodes, movies, and collections
- server-proxied HLS playback
- transport controls: `pause`, `resume`, `seek`, `next`, `stop`, `refresh`
- catalog browse/query commands: `search`, `list-shows`, `list-collections`, `recently-added`
- a thin Android TV receiver using native `Media3` playback
- an OpenClaw skill that wraps the CLI

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

It wraps the CLI so an OpenClaw agent can:

- inspect current playback and server status
- browse the synced library
- search for titles or series
- play, shuffle, pause, resume, seek, skip, refresh, and stop

## Android TV

The Android TV app under `apps/android-tv` is intentionally thin:

- it polls the ClawTV server for playback state
- it plays the assigned HLS stream with native `Media3`
- it stays focused on receiver behavior rather than library browsing or control logic

## Docs

- [Product Spec](docs/product-spec.md)
- [Technical Architecture](docs/technical-architecture.md)
- [Deployment Notes](docs/deployment.md)
- [Android TV App Plan](docs/android-tv-app-plan.md)
