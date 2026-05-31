# AGENTS.md - ClawTV Repo Contract

## Source of truth
- Durable ClawTV repo on `snizserver`: `/Volumes/LaCie_6big/briansnyder/repos/ClawTV`.
- Live server on `snizserver`: `http://127.0.0.1:4390/` locally; Tailscale Serve exposes `/ClawTV` on `https://snizserver.barred-komodo.ts.net/ClawTV/` and the approved Funnel exception at `https://snizserver.barred-komodo.ts.net:8443/ClawTV/`.
- LaunchAgent on `snizserver`: `/Users/briansnyder/Library/LaunchAgents/com.clawtv.server.plist`, running `/Volumes/LaCie_6big/briansnyder/repos/ClawTV/scripts/runtime/launch_server.mjs`.
- First log surfaces on `snizserver`: `/Volumes/LaCie_6big/briansnyder/logs/ClawTV/server.stdout.log` and `/Volumes/LaCie_6big/briansnyder/logs/ClawTV/server.stderr.log`.

## Storage posture
- On `snizserver`, durable repo and worktree storage belongs under `/Volumes/LaCie_6big/briansnyder/repos`.
- `snizserver` internal storage is a runtime surface only. Do not recreate ClawTV repo copies under `/Users/briansnyder/GitHubProjects`, `/Users/briansnyder/repos`, or other internal-storage paths.
- Do not use symlinks, shims, or compatibility mirrors to bridge retired internal-storage repo paths. Fix references at the source.

## Working posture
- For live ClawTV investigation or breakfix work, verify the deployed repo and live service on `snizserver` first.
- Before calling any ClawTV repo or deploy surface ready, report repo path, branch, `HEAD` SHA, upstream state, and whether `git status --short --branch` is clean.
- If the deployed repo on `snizserver` is dirty, off-main, detached, or otherwise ambiguous, treat that as a dirty-state investigation before mutation or restart work.
- Keep Kay/Jay identity distinctions straight: Kay is the default ClawTV voice persona unless Brian explicitly asks for Jay-specific parity work.
