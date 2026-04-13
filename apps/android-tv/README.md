# ClawTV Android TV

This app is a thin native Android TV receiver for ClawTV.

## Current Goal

- stay immersive and appliance-like on Android TV
- keep queue, playback state, and command authority on the existing ClawTV server
- attach the current HLS stream with native `Media3` playback on real hardware

## Current Shape

- the app polls the ClawTV server for the current playback snapshot
- it plays the assigned HLS stream with `Media3` / ExoPlayer
- it reports playback state and position back to the server
- it shows a branded idle/loading/error overlay when nothing is actively playing

## Server URL

The app defaults to a local development receiver URL:

- `http://10.0.2.2:8787/ClawTV/`

For a physical device or non-emulator environment, pass an explicit server origin at build time.

You can override that at build time:

```bash
gradle -p apps/android-tv assembleDebug -PclawtvReceiverUrl=http://your-server:8787/ClawTV/
```

## Notes

- the first Android TV scaffold started as a `WebView` shell
- real Shield testing showed that native `Media3` playback is the reliable path for HLS on this project
- the app is still intentionally thin: it does not browse media, own queue logic, or become a second control surface
