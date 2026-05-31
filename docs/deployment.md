# ClawTV Deployment Notes

## Expected Runtime Shape

ClawTV is designed as a self-hosted service that runs close to the media server it integrates with.

Typical deployment pieces:

- ClawTV server
- Plex or another metadata source
- a fullscreen receiver client
- a CLI or agent-facing control surface

The server serves the app and API under `/ClawTV` by default.

## Current Runtime Defaults

- `CLAWTV_BASE_PATH=/ClawTV`
- deployed local server: `http://127.0.0.1:4390/`
- deployed tailnet route: `https://snizserver.barred-komodo.ts.net/ClawTV/`
- approved Funnel exception: `https://snizserver.barred-komodo.ts.net:8443/ClawTV/`
- `PLEX_BASE_URL=http://127.0.0.1:32400/`
- deployed server port: `4390`; development can override `PORT` as needed
- LaunchAgent: `/Users/briansnyder/Library/LaunchAgents/com.clawtv.server.plist`
- deployed program path: `/Volumes/LaCie_6big/briansnyder/repos/ClawTV/scripts/runtime/launch_server.mjs`
- logs: `/Volumes/LaCie_6big/briansnyder/logs/ClawTV/server.stdout.log` and `/Volumes/LaCie_6big/briansnyder/logs/ClawTV/server.stderr.log`
- voice persona: `CLAWTV_VOICE_ASSISTANT_NAME=Kay`
- current OpenClaw voice route: `CLAWTV_VOICE_ASSISTANT_ID=jay-handoff-worker` and `CLAWTV_OPENCLAW_AGENT_ID=jay-handoff-worker`; this keeps Kay as the TV persona while using the existing Worker lane instead of a separate Kay agent registration
- configure `CLAWTV_ANDROID_TV_ADB_TARGETS` with tailnet-first and LAN-fallback Shield targets when you need live TV launches to survive network changes

## Local Data

By default, local development state lives under `data/clawtv.sqlite`.

For deployed environments, set `CLAWTV_DATA_DIR` explicitly so the database and runtime state live in a stable application data directory.

## macOS launchd Install

The repo includes a macOS-friendly install path:

```bash
pnpm install
pnpm build
pnpm install:runtime
```

That flow:

- installs dependencies
- builds the workspace
- writes a launch agent into `~/Library/LaunchAgents`
- creates an environment file if one does not already exist
- starts the ClawTV server with `launchctl`

## Deployment Advice

- keep `PLEX_TOKEN` outside the repo
- keep `CLAWTV_DATA_DIR` outside the repo for long-lived deployments
- front the app with a reverse proxy or tunnel only after the local runtime is healthy
- treat the receiver as a client of the server, not a source of playback truth

## Web Cache Rules

ClawTV's web shell is intentionally hostile to stale entry-point caching.

The operational rules are:

- `/ClawTV/`, `sw.js`, and `manifest.webmanifest` must be served with `cache-control: no-store, max-age=0`
- hashed build assets under `assets/` should stay aggressively cacheable with `immutable`
- do not reintroduce an app-shell service worker that caches HTML, the manifest, or unhashed entry files
- if an iPad or TV appears stuck on an older UI, check the live `cache-control` headers first before touching layout code

Why this is strict:

- stale shell caching can make a real deployment look "not live" on iPad even when the server and assets were rebuilt correctly
- this has already caused repeated false regressions during ClawTV rollout work

Verification commands:

```bash
curl -sD - -o /dev/null https://snizserver.barred-komodo.ts.net/ClawTV/
curl -sD - -o /dev/null https://snizserver.barred-komodo.ts.net/ClawTV/sw.js
curl -sD - -o /dev/null https://snizserver.barred-komodo.ts.net/ClawTV/manifest.webmanifest
curl -sD - -o /dev/null https://snizserver.barred-komodo.ts.net/ClawTV/assets/<hashed-file>.js
```

Expected shape:

- HTML / service worker / manifest: `cache-control: no-store, max-age=0`
- hashed JS/CSS assets: `cache-control: public, max-age=31536000, immutable`
