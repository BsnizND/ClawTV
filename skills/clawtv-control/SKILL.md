---
name: clawtv-control
description: Control ClawTV playback and inspect the synced library through the ClawTV wrapper CLI. Use for now playing, live TV tuning, search, recent additions, play, play-latest, shuffle, transport controls, and check-new-content.
---

# ClawTV Control

Use this skill when you need authoritative ClawTV state or need ClawTV to do something.

This skill is only for ClawTV playback, live TV, and synced-library visibility. It does not add media, browse the web, or manage Sonarr/Radarr.

## Normal Path

Run the wrapper directly and summarize the result in plain language:

```bash
python3 /Users/briansnyder/.openclaw/skills/clawtv-control/scripts/control_clawtv.py <command> [flags]
```

Do not read repo files to rediscover the command surface unless the wrapper itself fails.

If the request is ambiguous, ask one short follow-up question before sending a playback or live-TV command.

## Use These Commands

- `now-playing` or `now-playing-summary` for what is currently on and how much is left
- `live-tv-channels` to see what ClawTV can tune
- `live-tv --provider youtube-tv --channel "<name>"` to switch live TV
- `status` for general server state
- `search --query "<text>" [--type movie|show|season|episode|collection]`
- `list-shows` or `list-collections`
- `recently-added [--type movie|show|episode]`
- `check-new-content [--library "<name>"] [--limit N]` when the user just added something to Plex and wants ClawTV to notice now
- `play --title "<title>"`
- `play-latest --series "<series>"`
- `shuffle --show "<show>"` or `shuffle --collection "<collection>"`
- `pause`, `resume`, `next`, `stop`, `refresh`
- `seek --by 30s`, `seek --back 2m`, or `seek --to 12:34`

## Notes

- Never call the `voice-turn` wrapper command from inside an active ClawTV voice handoff. That would recurse back into the same path.
- Prefer the supplied wrapper output over guessing.
- `check-new-content` is more expensive than a normal lookup because it triggers a Plex scan and sync.
- If the user is only browsing what is already synced, prefer `recently-added`, `search`, `list-shows`, or `list-collections`.
- Keep the reply focused on outcome, not raw JSON, unless the user asked for the raw result.
