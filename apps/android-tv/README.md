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
- it captures first-pass voice transcripts with Android `SpeechRecognizer`
- it fetches assistant config from the ClawTV server before voice turns
- it can play server-served cue clips and reply audio in addition to local fallback prompts
- it shows a branded idle/loading/error overlay when nothing is actively playing

## Server URL

The app defaults to a neutral local-network receiver hostname:

- `http://clawtv.local:4390/ClawTV/`

For real deployments, pass an explicit server origin at build time.

You can override that at build time:

```bash
gradle -p apps/android-tv assembleDebug -PclawtvReceiverUrl=http://your-server:8787/ClawTV/
```

## Voice Defaults

The receiver can be built with generic voice defaults that are later overridden by the server:

```bash
gradle -p apps/android-tv assembleDebug \
  -PclawtvReceiverUrl=http://your-server:8787/ClawTV/ \
  -PclawtvReceiverFallbackUrls=https://your-tailnet-host/ClawTV/,http://your-lan-host:4390/ClawTV/ \
  -PclawtvVoiceAssistantName=Assistant \
  -PclawtvVoiceAssistantId=default-assistant \
  -PclawtvVoiceProcessingText="Looking into it." \
  -PclawtvVoiceAcknowledgementText="Got it." \
  -PclawtvVoiceUnavailableText="Voice chat is not available right now."
```

Server-provided voice config can include cue audio URLs for processing, acknowledgement, and unavailable states, so the TV can feel responsive before any dynamic reply finishes.
The receiver also remembers the last working receiver origin at runtime and can fail over across the configured receiver candidates, so LAN and Tailscale/HTTPS targets can coexist without rebuilding for every network change.

## Notes

- the first Android TV scaffold started as a `WebView` shell
- real Shield testing showed that native `Media3` playback is the reliable path for HLS on this project
- the app is still intentionally thin: it does not browse media, own queue logic, or become a second control surface
- the current voice path can already hand freeform turns to OpenClaw when the server is configured for it
- dynamic server reply audio is available when ElevenLabs credentials are configured on the server
