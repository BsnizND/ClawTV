---
name: clawtv-control
description: Control ClawTV playback through the repo CLI. Use when an OpenClaw agent needs to check what is on TV, browse the catalog, search titles or series, list shows or collections, inspect recent additions, play something by title, play the latest episode of a series, shuffle a show or collection, send transport controls like pause, resume, seek, next, refresh, or stop, or exercise the ClawTV voice API.
---

# ClawTV Control

Use this skill when an agent needs to control the TV through ClawTV's existing CLI.

This skill is only for ClawTV playback and status control. It does not fetch new media, search the web, or manage Sonarr/Radarr. If the user wants something that is not already in the library, use the appropriate ARR workflow separately.

## Trigger Conditions

Use this skill for requests like:
- What's on TV right now?
- How long is left in this movie or episode?
- How many more episodes are there in this season after this one?
- How many more seasons are there in this show after this one?
- What shows do you have?
- What collections exist?
- Search for something in the library.
- What was added recently?
- Play a movie or episode by title.
- Play the latest episode of a show.
- Shuffle a show or collection.
- Pause, resume, stop, skip, refresh, or seek playback.
- Inspect ClawTV voice config or run a voice turn through the server.

## Workflow

1. Map the request to the nearest ClawTV CLI command.
2. Run the wrapper script:

```bash
python3 /path/to/skills/clawtv-control/scripts/control_clawtv.py <command> [flags]
```

3. Read the returned JSON or text summary, depending on the command.
4. Report the outcome in plain language.

If the user request is ambiguous, ask one short follow-up question before sending a playback command.

## Commands

Check current playback:

```bash
python3 /path/to/skills/clawtv-control/scripts/control_clawtv.py now-playing
```

Check the current playback summary and "what's left" context:

```bash
python3 /path/to/skills/clawtv-control/scripts/control_clawtv.py now-playing-summary
```

Check general server status:

```bash
python3 /path/to/skills/clawtv-control/scripts/control_clawtv.py status
```

Search the catalog:

```bash
python3 /path/to/skills/clawtv-control/scripts/control_clawtv.py search --query "john oliver"
python3 /path/to/skills/clawtv-control/scripts/control_clawtv.py search --query "medicare" --type episode
```

List shows or collections:

```bash
python3 /path/to/skills/clawtv-control/scripts/control_clawtv.py list-shows --limit 20
python3 /path/to/skills/clawtv-control/scripts/control_clawtv.py list-collections --limit 20
```

Inspect recent additions:

```bash
python3 /path/to/skills/clawtv-control/scripts/control_clawtv.py recently-added --limit 10
python3 /path/to/skills/clawtv-control/scripts/control_clawtv.py recently-added --type movie --limit 10
```

Inspect voice config:

```bash
python3 /path/to/skills/clawtv-control/scripts/control_clawtv.py voice-config
```

Run a voice turn through the ClawTV server:

```bash
python3 /path/to/skills/clawtv-control/scripts/control_clawtv.py voice-turn --text "how long is left in this?"
python3 /path/to/skills/clawtv-control/scripts/control_clawtv.py voice-turn --text "pause" --playback-state playing
```

Play by title:

```bash
python3 /path/to/skills/clawtv-control/scripts/control_clawtv.py play --title "The Matrix"
```

Play the latest episode in a series:

```bash
python3 /path/to/skills/clawtv-control/scripts/control_clawtv.py play-latest --series "Last Week Tonight with John Oliver"
```

Shuffle a show:

```bash
python3 /path/to/skills/clawtv-control/scripts/control_clawtv.py shuffle --show "Bluey"
```

Shuffle a collection:

```bash
python3 /path/to/skills/clawtv-control/scripts/control_clawtv.py shuffle --collection "HGTV"
```

Transport controls:

```bash
python3 /path/to/skills/clawtv-control/scripts/control_clawtv.py pause
python3 /path/to/skills/clawtv-control/scripts/control_clawtv.py resume
python3 /path/to/skills/clawtv-control/scripts/control_clawtv.py next
python3 /path/to/skills/clawtv-control/scripts/control_clawtv.py stop
python3 /path/to/skills/clawtv-control/scripts/control_clawtv.py refresh
```

Seek controls:

```bash
python3 /path/to/skills/clawtv-control/scripts/control_clawtv.py seek --by 30s
python3 /path/to/skills/clawtv-control/scripts/control_clawtv.py seek --back 2m
python3 /path/to/skills/clawtv-control/scripts/control_clawtv.py seek --to 12:34
```

## Defaults

The wrapper script defaults to:
- the repo checkout that contains the script itself
- `CLAWTV_SERVER_ORIGIN` when it is set
- otherwise, auto-detection of a local ClawTV runtime, preferring the deployed port before the dev port

Override them when needed:
- `CLAWTV_REPO_ROOT`
- `CLAWTV_SERVER_ORIGIN`

Or pass explicit flags:

```bash
python3 /path/to/skills/clawtv-control/scripts/control_clawtv.py --repo-root /some/checkout --server-origin http://host:4390/ClawTV/ now-playing
```

## Notes

- Prefer `now-playing-summary` when the user is asking how much runtime, how many episodes, or how many seasons are left for the current item.
- Prefer `voice-turn` when you want to exercise or debug the same server-side voice intent handling the Android TV receiver will use.
- When `CLAWTV_VOICE_BACKEND=openclaw` is configured on the server, `voice-turn` exercises the live OpenClaw handoff path too.
- Prefer `now-playing` or `status` first when the user is asking what is currently happening and raw JSON is useful.
- Prefer `search`, `list-shows`, `list-collections`, or `recently-added` when the user is exploring what ClawTV already has.
- Prefer `play-latest` when the user asks for "last night's" or "latest" episode of a series.
- Use `shuffle --show` or `shuffle --collection` only when the user clearly asked for a shuffle-style experience.
- Keep the response focused on the outcome, not the raw command syntax, unless the user asked for it.
