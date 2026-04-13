# ClawTV Voice Roadmap

ClawTV now has the first real shape of a generic voice path:

- the Android TV receiver captures first-pass speech-to-text on the Shield
- the receiver fetches assistant config from the ClawTV server
- the receiver sends transcripts to `POST /api/voice/turn`
- the server can answer basic playback questions and execute simple playback intents

That gets the repo off the hard-coded assistant stub and gives us a stable contract for the full live version.

## Current State

What is implemented now:

- generic assistant config instead of Kay-specific copy
- Android TV build-time voice defaults
- server-side `GET /api/voice/config`
- server-side `POST /api/voice/turn`
- OpenClaw CLI handoff support for conversational turns
- server-served cue packs loaded from `assets/voice/<pack>/...`
- mock voice intent handling for:
  - what is playing
  - time left
  - more episodes in this season
  - more seasons after this one
  - pause
  - resume
  - next
  - stop
- CLI support for `voice-config` and `voice-turn`
- OpenClaw skill docs for the same voice API

What is not implemented yet:

- live validation of the ElevenLabs reply-audio path with production credentials
- live conversational session memory on the ClawTV server

## Phase 1

Goal: make the generic voice path stable and safe to iterate on.

- keep the Android TV app thin
- keep assistant identity configurable
- keep voice transport on the ClawTV server
- keep local STT on the Shield for low-latency first pass
- preserve playback state cleanly while voice mode is active

Exit criteria:

- Android TV voice overlay never references a hard-coded assistant name
- the receiver can survive voice API failures gracefully
- CLI and TV both hit the same voice endpoints

## Phase 2

Goal: wire the server to OpenClaw for real replies.

- add a server-side assistant transport layer
- pass current playback context with every voice turn
- define a structured action envelope for playback intents
- normalize assistant replies into the ClawTV voice response contract

Exit criteria:

- the server can route a transcript to the configured OpenClaw assistant
- the response can contain both user-facing text and structured playback actions
- the Android app does not need OpenClaw credentials or direct routing logic

## Phase 3

Goal: add real spoken replies.

- send reply text to ElevenLabs
- cache generated audio by turn id
- return a reply audio URL through the voice API
- fall back to client TTS when server audio fails or is unavailable

Exit criteria:

- dynamic spoken replies play on the TV
- repeated short replies do not require repeated TTS generation
- the TV still has a graceful fallback path when ElevenLabs is unavailable

## Phase 4

Goal: make the system feel instant.

- add a configurable greeting pack
- add a configurable processing pack
- add a configurable acknowledgment pack
- select variations randomly or round-robin to avoid repetition
- play pre-rendered clips immediately while the live assistant turn is in flight

Recommended canned phrases:

- greetings:
  - “Hey, what can I do for you?”
  - “Yeah?”
  - “What’s up?”
- processing:
  - “Looking into it.”
  - “One sec.”
  - “Let me check.”
- acknowledgements:
  - “Got it.”
  - “Okay.”
  - “Done.”
- recovery:
  - “I didn’t catch that.”
  - “Try that again.”
  - “Voice chat is not available right now.”

## Phase 5

Goal: support real conversation quality.

- keep a short-lived voice session history on the server
- support follow-ups like “how about the next one?” or “pause after this”
- add interruption handling while the assistant is speaking
- support ducking playback audio instead of always hard-pausing

Exit criteria:

- voice turns feel continuous instead of stateless
- follow-up questions can use the current playback context naturally
- playback and voice audio cooperate cleanly

## Proposed API Shape

Current endpoints:

- `GET /api/voice/config`
- `POST /api/voice/turn`

Likely next additions:

- `GET /api/voice/audio/:turnId`
- `GET /api/voice/history?limit=20`

The long-term `POST /api/voice/turn` response should support:

- assistant identity
- transcript accepted
- reply text
- reply audio URL
- reply mode
- structured playback action
- updated playback snapshot
- whether playback should resume after the turn

## Recommended Deployment Order

1. Promote the generic voice API and Android receiver changes.
2. Verify local Shield STT and server turn handling on the live ClawTV stack.
3. Add OpenClaw handoff behind the existing `voice/turn` contract.
4. Add ElevenLabs reply audio behind the same contract.
5. Add greeting/processing variation packs and caching.

This keeps the Android TV app stable while the server grows into the real live assistant loop.
