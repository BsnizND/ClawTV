# AGENTS.md - ClawTV Repo Contract

## Source of truth
- Durable ClawTV repo on `snizserver`: `/Volumes/LaCie_6big/briansnyder/repos/ClawTV`.
- Live service URL on `snizserver`: `http://127.0.0.1:4390/ClawTV/`.
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
