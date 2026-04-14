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
- `CLAWTV_SERVER_ORIGIN=http://localhost:8787/ClawTV/`
- `PLEX_BASE_URL=http://127.0.0.1:32400/`
- default server port: `8787` for development

For voice-enabled deployments, the intended ClawTV persona is Kay:

- `CLAWTV_VOICE_BACKEND=openclaw`
- `CLAWTV_VOICE_ASSISTANT_NAME=Kay`
- `CLAWTV_VOICE_ASSISTANT_ID=kay`
- `CLAWTV_OPENCLAW_AGENT_ID=kay`

If the OpenClaw handoff is unavailable, the runtime should fail clearly instead of silently falling back to mock or dummy behavior.

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

The launchd service runs built output from the repo, not TypeScript sources directly. After pulling new code onto a deployed checkout, rebuild with `pnpm build` before restarting the service.

## Deployment Advice

- keep `PLEX_TOKEN` outside the repo
- keep `CLAWTV_DATA_DIR` outside the repo for long-lived deployments
- front the app with a reverse proxy or tunnel only after the local runtime is healthy
- treat the receiver as a client of the server, not a source of playback truth
