# ClawTV Android TV App Plan

## Summary

The Android TV app should remain a thin receiver for ClawTV rather than a second control plane.

That means:

- the server owns queue, playback state, and commands
- the TV app owns fullscreen playback behavior on Android TV
- browsing and control logic stay outside the TV client

## Current Approach

The current Android TV scaffold uses a native `Media3` playback shell.

It:

- polls the ClawTV server for playback state
- attaches the assigned HLS stream
- reports playback state and position back to the server
- shows idle, loading, paused, and error overlays

## Why This Shape

- it preserves the server-controlled architecture
- it keeps the TV client debuggable
- it avoids rebuilding library browsing and command UX on the television
- it works better on real Android TV hardware than a browser-only wrapper for this project

## Risks To Validate

1. HLS playback stability on real Android TV devices
2. resume behavior after sleep or app relaunch
3. autoplay and media-session constraints
4. keeping the client appliance-like while still exposing enough status

## Near-Term Work

### Phase 1

- keep the native receiver shell stable
- verify playback and idle behavior on real hardware
- make the app configurable for different server origins

### Phase 2

- improve reconnect and error overlays
- tighten status reporting back to the server
- validate long-running playback behavior

### Phase 3

- add only the minimum platform-specific polish needed for reliability
- avoid expanding into a browsing app unless the product direction changes
