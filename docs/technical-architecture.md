# ClawTV Technical Architecture

## Purpose

This document turns the ClawTV product direction into an implementation shape for v1.

The core architectural rule is:

- OpenClaw decides intent
- the CLI submits commands
- the server owns playback state
- the TV client obeys the current assigned state and reports player telemetry

ClawTV is not a smart TV app with embedded decision-making. It is a server-controlled playback system with a very thin receiver client.

## V1 System Overview

ClawTV v1 has five main parts:

1. Plex sync process
2. ClawTV database
3. ClawTV server
4. ClawTV CLI
5. TV web client

An OpenClaw skill sits in front of the CLI and translates natural-language requests into structured commands.

## Source Of Truth

Each layer has one clear responsibility:

- Plex is the source of truth for what media exists and its library metadata
- The ClawTV database is the source of truth for ClawTV queryability and fast local resolution
- The ClawTV server is the source of truth for active sessions, queues, and playback state
- The TV client is only a renderer of server-owned state
- The TV client may report durable position, diagnostics, and handled receiver commands back to the server

This separation keeps the system debuggable and avoids putting business logic in the browser.

## High-Level Request Flow

1. A user speaks or types a request into an OpenClaw surface.
2. The OpenClaw skill resolves the natural-language request into a structured ClawTV command.
3. The skill invokes the local `clawtv` CLI.
4. The CLI sends the command to the ClawTV server.
5. The server resolves media from the local ClawTV database.
6. The server mutates queue and playback state.
7. The TV web client receives updated state and renders the result.

Example:

- User: "Play last night's Colbert."
- OpenClaw skill emits: `clawtv play-latest --series "The Late Show with Stephen Colbert"`
- CLI calls server API
- server resolves latest matching episode from synced metadata
- server sets active queue to that item
- TV client begins playback

## Component Architecture

### 1. Plex Sync

The Plex sync layer imports library metadata into a ClawTV-owned database.

Responsibilities:

- connect to Plex using supported APIs
- enumerate relevant libraries
- ingest series, seasons, episodes, movies, collections, and media parts
- normalize metadata into a queryable local schema
- periodically refresh records
- preserve enough source identifiers to trace every local record back to Plex

V1 rule:

- Prefer Plex API access over direct Plex database reads
- Keep sync one-way in v1
- Do not let ClawTV mutate Plex library state as part of core playback

### 2. ClawTV Database

The local database exists to make content resolution fast, stable, and independent from live Plex query latency during playback commands.

Recommended v1 storage choice:

- SQLite

Why:

- simple deployment on a small self-hosted machine
- easy local inspection
- good fit for one primary user and one active receiver
- works well with CLI and server processes

The schema should support:

- title lookup
- show-to-season-to-episode relationships
- air date queries
- collection membership
- tag and genre lookup
- direct mapping from logical media item to playable source

### 3. ClawTV Server

The server is the control plane and playback authority.

Responsibilities:

- expose HTTP and realtime APIs
- manage active TV sessions
- resolve commands into queue mutations
- assign playable media to a session
- track now playing, queue, playback state, and recent command history
- handle reconnects and stale clients

The server must be the only layer allowed to change playback state.

### 4. ClawTV CLI

The CLI is the stable command surface for both humans and OpenClaw.

Responsibilities:

- provide an operator-friendly interface
- expose the canonical command vocabulary
- submit validated commands to the server
- make local testing possible before OpenClaw integration is complete

The CLI should not contain business logic beyond argument parsing, basic validation, and formatting server responses.

### 5. TV Web Client

The TV client is a thin fullscreen receiver.

Responsibilities:

- register or reconnect as a TV session
- display idle, loading, now-playing, paused, and error states
- play assigned media URLs
- report player events back to the server

The TV client should not:

- browse the library
- resolve media
- own queue state
- make playback decisions

The TV client may:

- report playback position
- report diagnostics such as buffering, autoplay, and fatal HLS failures
- acknowledge one-shot receiver commands such as a forced refresh

That distinction matters:

- the client can describe what happened locally
- only the server and CLI are allowed to decide what should happen next

## Proposed Runtime Layout

Suggested logical modules:

- `apps/server`
- `apps/web`
- `apps/cli`
- `packages/core`
- `packages/db`
- `packages/plex-sync`
- `packages/contracts`

The exact folder layout can change, but the architecture should preserve the boundaries above.

## Data Model

The v1 schema should be intentionally small.

### Core Tables

`libraries`

- id
- plex_library_key
- name
- type
- updated_at

`media_items`

- id
- plex_rating_key
- library_id
- media_type
- title
- sort_title
- summary
- originally_available_at
- year
- duration_ms
- poster_url
- thumb_url
- added_at
- updated_at

`shows`

- media_item_id

`seasons`

- media_item_id
- show_id
- season_number

`episodes`

- media_item_id
- show_id
- season_id
- episode_number
- air_date

`movies`

- media_item_id

`collections`

- id
- plex_collection_key
- library_id
- title

`collection_items`

- collection_id
- media_item_id

`tags`

- id
- name
- tag_type

`media_item_tags`

- media_item_id
- tag_id

`media_sources`

- id
- media_item_id
- plex_media_id
- plex_part_id
- file_path
- container
- video_codec
- audio_codec
- width
- height
- duration_ms
- bitrate
- playable_mode

`sync_runs`

- id
- started_at
- finished_at
- status
- details_json

### Playback Tables

`sessions`

- id
- session_name
- session_type
- client_id
- last_seen_at
- status

`queues`

- id
- session_id
- created_at
- created_by
- mode

`queue_items`

- id
- queue_id
- media_item_id
- position
- origin_reason

`playback_state`

- session_id
- queue_id
- current_queue_item_id
- player_state
- playback_position_ms
- updated_at

`command_log`

- id
- session_id
- source
- command_name
- payload_json
- created_at

## Media Resolution Strategy

V1 should support only a few deterministic query classes.

### Exact Play

Examples:

- play "The Matrix"
- play "Bluey"

Resolution:

- exact title match first
- fallback to strong fuzzy title match
- if ambiguous, return candidates instead of guessing

### Latest Episode

Examples:

- play latest Colbert
- play last night's Colbert

Resolution:

- resolve series
- filter episodes by air date
- choose latest eligible episode

### Shuffle Group

Examples:

- shuffle network shows
- shuffle The Office

Resolution:

- resolve a show, collection, tag, or saved group
- build queue in randomized order

### Basic Transport

Examples:

- pause
- resume
- next
- stop

Resolution:

- mutate current session playback state directly

## Topic Search

Requests like "play the John Oliver about Medicare" are compelling, but should not be a required v1 success path.

Plex metadata alone may not be enough for reliable topical resolution. That capability likely depends on:

- subtitle ingestion
- transcript indexing
- semantic embeddings
- external enrichment pipelines

The architecture should leave room for that later, but the first database schema and server contract should not assume it exists.

## Sync Pipeline

Recommended v1 sync flow:

1. Authenticate to Plex.
2. Discover configured libraries.
3. Fetch metadata for supported item types.
4. Normalize and upsert into SQLite.
5. Upsert media source details for playable files.
6. Record sync run summary.

Sync modes:

- `full-sync`
- `incremental-sync`
- `single-item-refresh`

Recommended initial policy:

- one manual full sync command
- one periodic incremental sync job

## Server API Shape

The server should expose both request-response APIs and a realtime session channel.

### HTTP API

Suggested endpoints:

- `GET /health`
- `GET /api/status`
- `GET /api/sessions`
- `POST /api/sessions/:id/claim`
- `POST /api/commands/play`
- `POST /api/commands/play-latest`
- `POST /api/commands/shuffle`
- `POST /api/commands/pause`
- `POST /api/commands/resume`
- `POST /api/commands/next`
- `POST /api/commands/stop`

### Realtime Channel

Recommended:

- WebSocket or Server-Sent Events for session state delivery

Messages from server to client:

- session assigned
- idle state
- queue updated
- playback instruction
- pause instruction
- resume instruction
- error state

Messages from client to server:

- hello
- heartbeat
- player ready
- playback started
- playback progress
- playback ended
- playback error

## Command Contract

The CLI and OpenClaw skill should share the same command vocabulary.

Example commands:

- `clawtv status`
- `clawtv play --title "<title>"`
- `clawtv play-latest --series "<series>"`
- `clawtv play-date --series "<series>" --date yesterday`
- `clawtv shuffle --collection "<collection>"`
- `clawtv shuffle --show "<show>"`
- `clawtv pause`
- `clawtv resume`
- `clawtv next`
- `clawtv stop`

This creates one canonical control plane no matter whether the request came from a person, a script, or OpenClaw.

## OpenClaw Skill Role

The OpenClaw skill should be an adapter, not the playback engine.

Responsibilities:

- accept natural-language requests
- map them onto the supported CLI contract
- ask for clarification only when resolution is unsafe
- report success, failure, or ambiguity back to the user

The skill should not:

- bypass the CLI and mutate state directly
- keep its own shadow queue
- decide client behavior independently of the server

## TV Session Model

V1 should assume one primary TV receiver, but the protocol should still be session-based.

Why:

- it keeps the architecture extensible
- it makes reconnects explicit
- it avoids hardcoding a one-screen assumption into every command path

Suggested session fields:

- session id
- display name
- current client id
- last seen timestamp
- claimed flag
- active flag

Operational rule:

- commands target the active claimed TV session unless the caller specifies another

## Client State Model

The TV client can be represented as a small finite state machine:

- `booting`
- `idle`
- `loading`
- `playing`
- `paused`
- `error`

Transitions should always be driven by server instructions or confirmed player events.

Example:

- client connects -> `booting`
- session assigned with no queue -> `idle`
- play instruction received -> `loading`
- media starts -> `playing`
- pause command received -> `paused`
- media ends with more queue -> `loading`
- media ends with empty queue -> `idle`

## Playback Strategy

The default playback path should be as simple as possible.

Preferred v1 order:

1. Direct browser playback from a server-served media URL if formats are compatible
2. Remux or proxy only when needed
3. Add transcoding only if compatibility makes it unavoidable

This keeps the first version smaller and easier to debug.

## Failure Handling

The system should fail clearly, not mysteriously.

Minimum v1 failure cases:

- requested title not found
- multiple plausible matches
- no active TV session
- media file unavailable
- browser playback failure
- sync data stale or missing

For each case, the server should produce a structured error and the client should fall back to a safe visible state.

## Observability

The first version should include plain operational visibility.

Recommended:

- structured server logs
- sync-run logs
- command logs
- session connection logs
- recent playback event history

Helpful operator commands:

- `clawtv status`
- `clawtv sessions`
- `clawtv queue`
- `clawtv sync status`
- `clawtv logs tail`

## Security And Access

V1 can stay simple, but should not be anonymous by accident.

Recommended baseline:

- server bound to trusted local network or reverse-proxied intentionally
- CLI authenticated via local token or trusted-host assumption
- TV session claim uses a lightweight shared token or bootstrap code

## Recommended V1 Build Order

1. SQLite schema and sync prototype from Plex
2. Server session model and status API
3. CLI contract with manual play and stop commands
4. Thin TV web client with idle and playback states
5. OpenClaw skill integration
6. Shuffle and latest-episode query support

## Explicit Non-Goals

These should stay out of the first implementation:

- rich on-TV browsing
- recommendation engine sophistication
- semantic topic search
- native Android TV app
- generalized multi-user household logic

## Design Guardrails

- The browser never chooses content
- The CLI is the canonical command surface
- The server is the sole playback authority
- Plex feeds the catalog, but ClawTV owns local queryability
- Natural language enters through OpenClaw, not through the TV
