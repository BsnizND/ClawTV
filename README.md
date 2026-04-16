# ClawTV

ClawTV is a self-hosted, agent-first TV playback system for Android TV devices such as NVIDIA Shield.

It is built for a very specific kind of experience: you should be able to turn on the TV, land in a simple fullscreen receiver, and use an agentic control layer to put something on without digging through app menus. That makes it interesting not just as a home theater tool, but as an accessibility project for low-vision people, seniors, and anyone who wants less menu hunting between intent and playback.

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
- automatic periodic incremental sync plus a manual "check for new content" path
- server-proxied HLS playback
- playback state persistence
- transport controls like pause, resume, seek, next, stop, and refresh
- catalog browsing with `search`, `list-shows`, `list-collections`, and `recently-added`
- a first-pass voice API with configurable assistant identity, OpenClaw handoff support, and server-served cue packs
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
export CLAWTV_PLEX_SYNC_INTERVAL_MINUTES=15
export CLAWTV_PLEX_REFRESH_TIMEOUT_SECONDS=60
export CLAWTV_VOICE_ENABLED=true
export CLAWTV_VOICE_BACKEND=openclaw
export CLAWTV_VOICE_ASSISTANT_NAME=Assistant
export CLAWTV_VOICE_ASSISTANT_ID=main
export CLAWTV_VOICE_PROCESSING_TEXT="Looking into it."
export CLAWTV_VOICE_ACKNOWLEDGEMENT_TEXT="Got you."
export CLAWTV_VOICE_UNAVAILABLE_TEXT="Voice chat is not available right now."
export CLAWTV_VOICE_PROCESSING_VARIANTS="Looking into it.|Give me a second.|Working on it."
export CLAWTV_VOICE_ACKNOWLEDGEMENT_VARIANTS="Okay.|Got it.|On it."
export CLAWTV_VOICE_UNAVAILABLE_VARIANTS="Voice chat is not available right now.|I can't help with that right now.|Try again in a moment."
export CLAWTV_VOICE_AUDIO_PACK=default
export CLAWTV_OPENCLAW_AGENT_ID=your-assistant-id
export CLAWTV_OPENCLAW_THINKING=minimal
export CLAWTV_OPENCLAW_TIMEOUT_SECONDS=90
export ELEVENLABS_API_KEY=your-elevenlabs-api-key
export ELEVENLABS_VOICE_ID=your-elevenlabs-voice-id
export ELEVENLABS_MODEL_ID=eleven_flash_v2_5
export ELEVENLABS_CUE_VOICE_ID=
export ELEVENLABS_CUE_MODEL_ID=eleven_flash_v2_5
export ELEVENLABS_VOICE_SETTINGS_JSON='{"stability":0.42,"similarity_boost":0.78,"style":0.28,"use_speaker_boost":true}'
export ELEVENLABS_CUE_VOICE_SETTINGS_JSON='{"stability":0.46,"similarity_boost":0.8,"style":0.24,"use_speaker_boost":true}'
export ELEVENLABS_CACHE_VERSION=
export ELEVENLABS_CUE_CACHE_VERSION=
```

## CLI Examples

```bash
pnpm --filter @clawtv/cli dev now-playing
pnpm --filter @clawtv/cli dev now-playing-summary
pnpm --filter @clawtv/cli dev voice-config
pnpm --filter @clawtv/cli dev voice-turn --text "how long is left in this?"
pnpm --filter @clawtv/cli dev check-new-content
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
- answer "what's left?" questions about the currently playing movie or episode
- exercise the same voice API the Android TV receiver now uses
- browse the synced library
- search titles or series
- play, shuffle, pause, resume, seek, skip, refresh, and stop

## Android TV

The Android TV app under `apps/android-tv` is intentionally thin:

- it polls the ClawTV server for playback state
- it plays the assigned HLS stream with native `Media3`
- it captures first-pass mic transcripts on-device and hands them to the ClawTV voice API
- it does not own queue logic or library browsing

## Voice

The repo now has a generic, configurable voice path instead of a hard-coded assistant identity.

- Android TV captures first-pass STT with `SpeechRecognizer`
- the receiver loads assistant config from `GET /api/voice/config`
- voice turns post to `POST /api/voice/turn`
- with `CLAWTV_VOICE_BACKEND=openclaw`, the server hands voice turns to an OpenClaw agent and validates the returned ClawTV command
- when ElevenLabs credentials are configured, both cue audio and reply audio can be cached and streamed back to the TV instead of relying on client TTS
- when live replies are using client TTS, cue audio URLs stay empty so the same device voice is used for snippets too
- cue snippets inherit the live reply voice by default; only set `ELEVENLABS_CUE_*` overrides when you intentionally want a different cue voice
- cue cache keys now auto-refresh from the running server build, so a rebuilt deployment regenerates snippets without a manual bump; `ELEVENLABS_CACHE_VERSION` and `ELEVENLABS_CUE_CACHE_VERSION` are optional overrides only

The rollout plan for the full live assistant loop is in [docs/voice-roadmap.md](docs/voice-roadmap.md).

## Docs

- [Technical Architecture](docs/technical-architecture.md)
- [Deployment Notes](docs/deployment.md)
- [Voice Roadmap](docs/voice-roadmap.md)
