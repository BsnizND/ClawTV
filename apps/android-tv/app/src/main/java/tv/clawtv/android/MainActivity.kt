package tv.clawtv.android

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.media.MediaPlayer
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.util.Locale
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import kotlin.math.abs

class MainActivity : AppCompatActivity() {
    private lateinit var playerView: PlayerView
    private lateinit var statusOverlay: View
    private lateinit var statusTitle: TextView
    private lateinit var statusMessage: TextView
    private lateinit var statusNowPlaying: TextView
    private lateinit var voiceOverlay: View
    private lateinit var voiceTitle: TextView
    private lateinit var voiceMessage: TextView
    private lateinit var voiceTranscript: TextView
    private lateinit var player: ExoPlayer

    private val receiverUri: Uri by lazy { Uri.parse(BuildConfig.CLAWTV_RECEIVER_URL) }
    private val worker: ExecutorService = Executors.newSingleThreadExecutor()
    private val mainHandler = Handler(Looper.getMainLooper())

    private var currentSnapshot: PlaybackSnapshotPayload? = null
    private var loadedStreamUrl: String? = null
    private var lastReportedState: String? = null
    private var speechRecognizer: SpeechRecognizer? = null
    private var textToSpeech: TextToSpeech? = null
    private var voicePromptPlayer: MediaPlayer? = null
    private var textToSpeechReady = false
    private var pendingUtteranceId: String? = null
    private var pendingUtteranceAction: (() -> Unit)? = null
    private var voiceModeActive = false
    private var shouldResumeAfterVoice = false
    private var voiceDismissResumePlayback = false
    private var latestTranscript: String? = null
    private var destroyed = false

    private val pollRunnable = object : Runnable {
        override fun run() {
            pollPlaybackSnapshot()
            mainHandler.postDelayed(this, POLL_INTERVAL_MS)
        }
    }

    private val positionSyncRunnable = object : Runnable {
        override fun run() {
            syncPositionOnly()
            mainHandler.postDelayed(this, POSITION_SYNC_INTERVAL_MS)
        }
    }

    private val finishVoiceModeRunnable = Runnable {
        finishVoiceMode(voiceDismissResumePlayback)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setContentView(R.layout.activity_main)

        playerView = findViewById(R.id.player_view)
        statusOverlay = findViewById(R.id.status_overlay)
        statusTitle = findViewById(R.id.status_title)
        statusMessage = findViewById(R.id.status_message)
        statusNowPlaying = findViewById(R.id.status_now_playing)
        voiceOverlay = findViewById(R.id.voice_overlay)
        voiceTitle = findViewById(R.id.voice_title)
        voiceMessage = findViewById(R.id.voice_message)
        voiceTranscript = findViewById(R.id.voice_transcript)

        player = ExoPlayer.Builder(this).build().also { exoPlayer ->
            exoPlayer.addListener(object : Player.Listener {
                override fun onPlaybackStateChanged(playbackState: Int) {
                    when (playbackState) {
                        Player.STATE_BUFFERING -> {
                            showOverlay(
                                title = getString(R.string.status_buffering_title),
                                message = getString(R.string.status_buffering_message),
                                visible = true
                            )
                            reportPlaybackState("loading")
                        }

                        Player.STATE_READY -> {
                            if (exoPlayer.playWhenReady) {
                                showOverlay(visible = false)
                                reportPlaybackState("playing")
                            } else {
                                showOverlay(
                                    title = getString(R.string.status_paused_title),
                                    message = getString(R.string.status_paused_message),
                                    visible = true
                                )
                                reportPlaybackState("paused")
                            }
                        }

                        Player.STATE_ENDED -> {
                            showOverlay(
                                title = getString(R.string.status_finished_title),
                                message = getString(R.string.status_finished_message),
                                visible = true
                            )
                            reportPlaybackState("idle")
                        }
                    }
                }

                override fun onIsPlayingChanged(isPlaying: Boolean) {
                    if (isPlaying) {
                        showOverlay(visible = false)
                        reportPlaybackState("playing")
                    }
                }

                override fun onPlayerError(error: PlaybackException) {
                    showOverlay(
                        title = getString(R.string.status_error_title),
                        message = error.localizedMessage ?: getString(R.string.status_error_message),
                        visible = true
                    )
                    reportPlaybackState("error", force = true)
                }
            })
        }

        playerView.player = player
        playerView.useController = false
        initializeTextToSpeech()

        showOverlay(
            title = getString(R.string.status_loading_title),
            message = getString(R.string.status_loading_message),
            visible = true
        )
    }

    override fun onResume() {
        super.onResume()
        enterImmersiveMode()
        player.playWhenReady = true
        mainHandler.post(pollRunnable)
        mainHandler.post(positionSyncRunnable)
    }

    override fun onPause() {
        mainHandler.removeCallbacks(pollRunnable)
        mainHandler.removeCallbacks(positionSyncRunnable)
        syncPositionOnly()
        super.onPause()
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)

        if (requestCode != REQUEST_RECORD_AUDIO_PERMISSION || !voiceModeActive) {
            return
        }

        val granted = grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED
        if (granted) {
            beginVoiceGreeting()
            return
        }

        showVoiceOverlay(
            title = getString(R.string.voice_title_error),
            message = getString(R.string.voice_message_permission)
        )
        scheduleVoiceDismiss(resumePlayback = shouldResumeAfterVoice, delayMs = 2500L)
    }

    override fun onDestroy() {
        destroyed = true
        mainHandler.removeCallbacksAndMessages(null)
        speechRecognizer?.destroy()
        voicePromptPlayer?.release()
        textToSpeech?.stop()
        textToSpeech?.shutdown()
        player.release()
        worker.shutdownNow()
        super.onDestroy()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) {
            enterImmersiveMode()
        }
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.keyCode == KeyEvent.KEYCODE_BACK && voiceModeActive) {
            if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) {
                cancelVoiceMode()
            }
            return true
        }

        if (isVoiceKey(event.keyCode)) {
            if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) {
                startVoiceMode()
            }
            return true
        }

        if (!isTransportKey(event.keyCode)) {
            return super.dispatchKeyEvent(event)
        }

        if (voiceModeActive) {
            return true
        }

        if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) {
            handleTransportKey(event.keyCode)
        }

        return true
    }

    private fun pollPlaybackSnapshot() {
        worker.execute {
            val result = runCatching {
                val response = requestJson("api/playback/current")
                parsePlaybackSnapshot(response)
            }

            if (destroyed) {
                return@execute
            }

            result.onFailure { error ->
                Log.e(TAG, "Failed to fetch playback snapshot from ${BuildConfig.CLAWTV_RECEIVER_URL}", error)
                val errorMessage = error.localizedMessage ?: error.javaClass.simpleName
                runOnUiThread {
                    showOverlay(
                        title = getString(R.string.status_loading_title),
                        message = "Unable to reach ClawTV at ${BuildConfig.CLAWTV_RECEIVER_URL}\n$errorMessage",
                        visible = true
                    )
                }
            }

            val snapshot = result.getOrNull() ?: return@execute

            runOnUiThread {
                applySnapshot(snapshot)
            }
        }
    }

    private fun isTransportKey(keyCode: Int): Boolean {
        return keyCode == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE
            || keyCode == KeyEvent.KEYCODE_MEDIA_PLAY
            || keyCode == KeyEvent.KEYCODE_MEDIA_PAUSE
            || keyCode == KeyEvent.KEYCODE_MEDIA_FAST_FORWARD
            || keyCode == KeyEvent.KEYCODE_MEDIA_REWIND
            || keyCode == KeyEvent.KEYCODE_MEDIA_NEXT
            || keyCode == KeyEvent.KEYCODE_MEDIA_STOP
            || keyCode == KeyEvent.KEYCODE_DPAD_LEFT
            || keyCode == KeyEvent.KEYCODE_DPAD_RIGHT
    }

    private fun isVoiceKey(keyCode: Int): Boolean {
        return keyCode == KeyEvent.KEYCODE_SEARCH
            || keyCode == KeyEvent.KEYCODE_ASSIST
            || keyCode == KeyEvent.KEYCODE_VOICE_ASSIST
    }

    private fun handleTransportKey(keyCode: Int) {
        when (keyCode) {
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE -> {
                val commandName = if (currentSnapshot?.playbackState == "playing" || currentSnapshot?.playbackState == "loading") {
                    "pause"
                } else {
                    "resume"
                }
                sendCommand(commandName)
            }

            KeyEvent.KEYCODE_MEDIA_PLAY -> sendCommand("resume")
            KeyEvent.KEYCODE_MEDIA_PAUSE -> sendCommand("pause")
            KeyEvent.KEYCODE_MEDIA_FAST_FORWARD,
            KeyEvent.KEYCODE_DPAD_RIGHT -> sendCommand("seek", JSONObject().apply {
                put("deltaMs", SEEK_FORWARD_MS)
            })

            KeyEvent.KEYCODE_MEDIA_REWIND,
            KeyEvent.KEYCODE_DPAD_LEFT -> sendCommand("seek", JSONObject().apply {
                put("deltaMs", -SEEK_BACK_MS)
            })

            KeyEvent.KEYCODE_MEDIA_NEXT -> sendCommand("next")
            KeyEvent.KEYCODE_MEDIA_STOP -> sendCommand("stop")
        }
    }

    private fun startVoiceMode() {
        if (voiceModeActive) {
            return
        }

        voiceModeActive = true
        latestTranscript = null
        mainHandler.removeCallbacks(finishVoiceModeRunnable)
        showVoiceOverlay(
            title = getString(R.string.voice_title_waking),
            message = getString(R.string.voice_message_waking)
        )

        pausePlaybackForVoiceMode()

        if (!ensureRecordAudioPermission()) {
            return
        }

        beginVoiceGreeting()
    }

    private fun cancelVoiceMode() {
        speechRecognizer?.cancel()
        stopVoicePromptPlayback()
        textToSpeech?.stop()
        finishVoiceMode(shouldResumeAfterVoice)
    }

    private fun pausePlaybackForVoiceMode() {
        val playbackState = currentSnapshot?.playbackState
        shouldResumeAfterVoice = playbackState == "playing" || playbackState == "loading"
        player.playWhenReady = false
        if (player.isPlaying) {
            player.pause()
        }

        if (shouldResumeAfterVoice) {
            sendCommand("pause")
        }
    }

    private fun ensureRecordAudioPermission(): Boolean {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            return true
        }

        showVoiceOverlay(
            title = getString(R.string.voice_title_error),
            message = getString(R.string.voice_message_permission)
        )
        ActivityCompat.requestPermissions(
            this,
            arrayOf(Manifest.permission.RECORD_AUDIO),
            REQUEST_RECORD_AUDIO_PERMISSION
        )
        return false
    }

    private fun beginVoiceGreeting() {
        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            showVoiceOverlay(
                title = getString(R.string.voice_title_error),
                message = getString(R.string.voice_message_unavailable)
            )
            scheduleVoiceDismiss(resumePlayback = shouldResumeAfterVoice, delayMs = 2500L)
            return
        }

        val playedGreeting = playBundledVoiceClip(
            clipResId = R.raw.kay_greeting,
            onComplete = { startSpeechListening() }
        )

        val spokeGreeting = playedGreeting || speakPhrase(
            text = "Hey, what's up?",
            onComplete = { startSpeechListening() }
        )

        if (!spokeGreeting) {
            showVoiceOverlay(
                title = getString(R.string.voice_title_waking),
                message = getString(R.string.voice_message_tts_unavailable)
            )
            mainHandler.postDelayed({ startSpeechListening() }, 400L)
        }
    }

    private fun startSpeechListening() {
        if (!voiceModeActive || destroyed) {
            return
        }

        val recognizer = getOrCreateSpeechRecognizer() ?: run {
            showVoiceOverlay(
                title = getString(R.string.voice_title_error),
                message = getString(R.string.voice_message_unavailable)
            )
            scheduleVoiceDismiss(resumePlayback = shouldResumeAfterVoice, delayMs = 2500L)
            return
        }

        latestTranscript = null
        showVoiceOverlay(
            title = getString(R.string.voice_title_listening),
            message = getString(R.string.voice_message_listening)
        )

        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.US.toLanguageTag())
            putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, false)
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
            putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, packageName)
        }

        recognizer.cancel()
        recognizer.startListening(intent)
    }

    private fun getOrCreateSpeechRecognizer(): SpeechRecognizer? {
        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            return null
        }

        if (speechRecognizer == null) {
            speechRecognizer = SpeechRecognizer.createSpeechRecognizer(this).also { recognizer ->
                recognizer.setRecognitionListener(object : RecognitionListener {
                    override fun onReadyForSpeech(params: Bundle?) {
                        showVoiceOverlay(
                            title = getString(R.string.voice_title_listening),
                            message = getString(R.string.voice_message_listening),
                            transcript = latestTranscript
                        )
                    }

                    override fun onBeginningOfSpeech() = Unit

                    override fun onRmsChanged(rmsdB: Float) = Unit

                    override fun onBufferReceived(buffer: ByteArray?) = Unit

                    override fun onEndOfSpeech() {
                        showVoiceOverlay(
                            title = getString(R.string.voice_title_processing),
                            message = getString(R.string.voice_message_processing),
                            transcript = latestTranscript
                        )
                    }

                    override fun onError(error: Int) {
                        showVoiceOverlay(
                            title = getString(R.string.voice_title_error),
                            message = recognitionErrorMessage(error),
                            transcript = latestTranscript
                        )
                        scheduleVoiceDismiss(resumePlayback = shouldResumeAfterVoice, delayMs = 2500L)
                    }

                    override fun onResults(results: Bundle?) {
                        val transcript = extractTranscript(results)
                        latestTranscript = transcript
                        showVoiceOverlay(
                            title = getString(R.string.voice_title_processing),
                            message = getString(R.string.voice_message_processing),
                            transcript = transcript
                        )

                        val playedAck = playBundledVoiceClip(
                            clipResId = R.raw.kay_ack,
                            onComplete = { finishVoiceMode(shouldResumeAfterVoice) }
                        )

                        val spokeAck = playedAck || speakPhrase(
                            text = "Got it.",
                            onComplete = { finishVoiceMode(shouldResumeAfterVoice) }
                        )

                        if (!spokeAck) {
                            scheduleVoiceDismiss(resumePlayback = shouldResumeAfterVoice, delayMs = 1600L)
                        }
                    }

                    override fun onPartialResults(partialResults: Bundle?) {
                        latestTranscript = extractTranscript(partialResults)
                        showVoiceOverlay(
                            title = getString(R.string.voice_title_listening),
                            message = getString(R.string.voice_message_listening),
                            transcript = latestTranscript
                        )
                    }

                    override fun onEvent(eventType: Int, params: Bundle?) = Unit
                })
            }
        }

        return speechRecognizer
    }

    private fun initializeTextToSpeech() {
        textToSpeech = TextToSpeech(applicationContext) { status ->
            if (status != TextToSpeech.SUCCESS) {
                Log.w(TAG, "TextToSpeech initialization failed with status=$status")
                textToSpeechReady = false
                return@TextToSpeech
            }

            textToSpeechReady = true
            textToSpeech?.language = Locale.US
            textToSpeech?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                override fun onStart(utteranceId: String?) = Unit

                override fun onDone(utteranceId: String?) {
                    if (utteranceId == null || utteranceId != pendingUtteranceId) {
                        return
                    }

                    val action = pendingUtteranceAction
                    pendingUtteranceId = null
                    pendingUtteranceAction = null
                    mainHandler.post {
                        action?.invoke()
                    }
                }

                @Deprecated("Deprecated in Java")
                override fun onError(utteranceId: String?) {
                    if (utteranceId == null || utteranceId != pendingUtteranceId) {
                        return
                    }

                    val action = pendingUtteranceAction
                    pendingUtteranceId = null
                    pendingUtteranceAction = null
                    mainHandler.post {
                        action?.invoke()
                    }
                }
            })
        }
    }

    private fun playBundledVoiceClip(clipResId: Int, onComplete: () -> Unit): Boolean {
        return runCatching {
            stopVoicePromptPlayback()
            val mediaPlayer = MediaPlayer.create(this, clipResId) ?: return false
            voicePromptPlayer = mediaPlayer
            mediaPlayer.setOnCompletionListener { completedPlayer ->
                completedPlayer.release()
                if (voicePromptPlayer === completedPlayer) {
                    voicePromptPlayer = null
                }
                onComplete()
            }
            mediaPlayer.setOnErrorListener { failedPlayer, _, _ ->
                failedPlayer.release()
                if (voicePromptPlayer === failedPlayer) {
                    voicePromptPlayer = null
                }
                onComplete()
                true
            }
            mediaPlayer.start()
            true
        }.getOrElse {
            Log.w(TAG, "Bundled voice clip playback failed for resId=$clipResId", it)
            false
        }
    }

    private fun stopVoicePromptPlayback() {
        voicePromptPlayer?.runCatching {
            stop()
        }
        voicePromptPlayer?.release()
        voicePromptPlayer = null
    }

    private fun speakPhrase(text: String, onComplete: () -> Unit): Boolean {
        val engine = textToSpeech
        if (!textToSpeechReady || engine == null) {
            return false
        }

        val utteranceId = "clawtv-voice-${System.currentTimeMillis()}"
        pendingUtteranceId = utteranceId
        pendingUtteranceAction = onComplete
        val result = engine.speak(text, TextToSpeech.QUEUE_FLUSH, null, utteranceId)
        if (result == TextToSpeech.ERROR) {
            pendingUtteranceId = null
            pendingUtteranceAction = null
            return false
        }
        return true
    }

    private fun extractTranscript(results: Bundle?): String? {
        val heard = results
            ?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
            ?.firstOrNull()
            ?.trim()

        return heard?.takeIf { it.isNotEmpty() }
    }

    private fun recognitionErrorMessage(error: Int): String {
        return when (error) {
            SpeechRecognizer.ERROR_AUDIO -> "The Shield microphone audio could not be captured."
            SpeechRecognizer.ERROR_CLIENT -> "ClawTV voice listening was interrupted before Kay could hear you."
            SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> getString(R.string.voice_message_permission)
            SpeechRecognizer.ERROR_NETWORK,
            SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "Speech recognition could not reach its service."
            SpeechRecognizer.ERROR_NO_MATCH -> "Kay did not catch any speech this time."
            SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "Speech recognition is already busy. Try the mic button again."
            SpeechRecognizer.ERROR_SERVER -> "The speech recognition service returned an error."
            SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "No speech was heard before the listen window closed."
            else -> "Voice capture hit an unexpected error."
        }
    }

    private fun scheduleVoiceDismiss(resumePlayback: Boolean, delayMs: Long) {
        voiceDismissResumePlayback = resumePlayback
        mainHandler.removeCallbacks(finishVoiceModeRunnable)
        mainHandler.postDelayed(finishVoiceModeRunnable, delayMs)
    }

    private fun finishVoiceMode(resumePlayback: Boolean) {
        mainHandler.removeCallbacks(finishVoiceModeRunnable)
        pendingUtteranceId = null
        pendingUtteranceAction = null
        stopVoicePromptPlayback()
        voiceModeActive = false
        voiceDismissResumePlayback = false
        latestTranscript = null
        hideVoiceOverlay()
        if (resumePlayback) {
            sendCommand("resume")
        }
        shouldResumeAfterVoice = false
    }

    private fun sendCommand(commandName: String, body: JSONObject = JSONObject()) {
        worker.execute {
            val result = runCatching {
                postJson("api/commands/$commandName", body)
                parsePlaybackSnapshot(requestJson("api/playback/current"))
            }

            if (destroyed) {
                return@execute
            }

            result.onFailure { error ->
                Log.e(TAG, "Failed to send command $commandName", error)
                val errorMessage = error.localizedMessage ?: error.javaClass.simpleName
                runOnUiThread {
                    showOverlay(
                        title = getString(R.string.status_error_title),
                        message = "Command failed: $commandName\n$errorMessage",
                        visible = true
                    )
                }
            }

            val snapshot = result.getOrNull() ?: return@execute

            runOnUiThread {
                applySnapshot(snapshot)
            }
        }
    }

    private fun applySnapshot(snapshot: PlaybackSnapshotPayload) {
        currentSnapshot = snapshot

        if (snapshot.receiverCommandId != null) {
            acknowledgeReceiverCommand(snapshot.receiverCommandId, snapshot.sessionId)
        }

        val nowPlaying = listOfNotNull(snapshot.showTitle, snapshot.title).joinToString(" - ")
        statusNowPlaying.text = nowPlaying

        val streamUrl = snapshot.streamUrl
        if (streamUrl == null) {
            loadedStreamUrl = null
            player.stop()
            showOverlay(
                title = getString(R.string.status_idle_title),
                message = getString(R.string.status_idle_message),
                visible = true
            )
            return
        }

        if (loadedStreamUrl != streamUrl) {
            loadedStreamUrl = streamUrl
            lastReportedState = null
            player.setMediaItem(MediaItem.fromUri(streamUrl))
            player.prepare()
            if (snapshot.playbackPositionMs > 0) {
                player.seekTo(snapshot.playbackPositionMs.toLong())
            }
        } else if (snapshot.controlRevisionChanged && snapshot.playbackPositionMs > 0) {
            val driftMs = abs(player.currentPosition - snapshot.playbackPositionMs.toLong())
            if (driftMs > RESYNC_DRIFT_MS) {
                player.seekTo(snapshot.playbackPositionMs.toLong())
            }
        }

        when (snapshot.playbackState) {
            "paused" -> {
                player.playWhenReady = false
                if (player.isPlaying) {
                    player.pause()
                }
                showOverlay(
                    title = getString(R.string.status_paused_title),
                    message = getString(R.string.status_paused_message),
                    visible = true
                )
            }

            "playing", "loading" -> {
                player.playWhenReady = true
                if (snapshot.playbackState == "loading") {
                    showOverlay(
                        title = getString(R.string.status_buffering_title),
                        message = getString(R.string.status_buffering_message),
                        visible = true
                    )
                }
            }

            else -> {
                player.playWhenReady = false
            }
        }
    }

    private fun reportPlaybackState(state: String, force: Boolean = false) {
        val snapshot = currentSnapshot ?: return
        val body = JSONObject().apply {
            put("state", state)
            put("positionMs", player.currentPosition)
            put("sessionId", snapshot.sessionId)
        }

        if (!force && lastReportedState == state) {
            return
        }

        lastReportedState = state

        worker.execute {
            runCatching {
                postJson("api/playback/state", body)
            }
        }
    }

    private fun syncPositionOnly() {
        val snapshot = currentSnapshot ?: return
        val body = JSONObject().apply {
            put("positionMs", player.currentPosition)
            put("sessionId", snapshot.sessionId)
        }

        worker.execute {
            runCatching {
                postJson("api/playback/state", body)
            }
        }
    }

    private fun acknowledgeReceiverCommand(commandId: String, sessionId: String?) {
        worker.execute {
            runCatching {
                postJson(
                    "api/playback/receiver-command/ack",
                    JSONObject().apply {
                        put("commandId", commandId)
                        put("sessionId", sessionId)
                    }
                )
            }
        }
    }

    private fun requestJson(path: String): JSONObject {
        val connection = openConnection(path, "GET")
        connection.connect()
        connection.inputStream.use { stream ->
            val body = BufferedReader(InputStreamReader(stream)).readText()
            return JSONObject(body)
        }
    }

    private fun postJson(path: String, body: JSONObject): JSONObject {
        val connection = openConnection(path, "POST")
        connection.doOutput = true
        OutputStreamWriter(connection.outputStream).use { writer ->
            writer.write(body.toString())
        }

        connection.inputStream.use { stream ->
            val responseBody = BufferedReader(InputStreamReader(stream)).readText()
            return JSONObject(responseBody)
        }
    }

    private fun openConnection(path: String, method: String): HttpURLConnection {
        val url = URL(resolveApiUrl(path))
        return (url.openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 5_000
            readTimeout = 5_000
            setRequestProperty("Content-Type", "application/json")
            setRequestProperty("Accept", "application/json")
        }
    }

    private fun resolveApiUrl(path: String): String {
        return URL(URL(receiverUri.toString()), path).toString()
    }

    private fun resolveStreamUrl(streamPath: String, currentItemId: String): String {
        val resolved = Uri.parse(URL(URL(receiverUri.toString()), streamPath).toString())
        return resolved.buildUpon()
            .appendQueryParameter("currentItemId", currentItemId)
            .build()
            .toString()
    }

    private fun parsePlaybackSnapshot(payload: JSONObject): PlaybackSnapshotPayload {
        val currentItem = payload.optJSONObject("currentItem")
        val receiverCommand = payload.optJSONObject("receiverCommand")
        val playbackState = payload.optString("playbackState", "idle")
        val controlRevision = payload.optInt("controlRevision", 0)
        val itemId = currentItem?.optString("id")?.takeIf { it.isNotEmpty() }
        val streamPath = payload.optString("streamPath").takeIf { it.isNotEmpty() }

        return PlaybackSnapshotPayload(
            sessionId = payload.optString("sessionId").takeIf { it.isNotEmpty() },
            playbackState = playbackState,
            playbackPositionMs = payload.optInt("playbackPositionMs", 0),
            controlRevision = controlRevision,
            controlRevisionChanged = currentSnapshot?.controlRevision != controlRevision,
            title = currentItem?.optString("title")?.takeIf { it.isNotEmpty() },
            showTitle = currentItem?.optString("showTitle")?.takeIf { it.isNotEmpty() },
            receiverCommandId = receiverCommand?.optString("id")?.takeIf { it.isNotEmpty() },
            streamUrl = if (itemId != null && streamPath != null) resolveStreamUrl(streamPath, itemId) else null
        )
    }

    private fun enterImmersiveMode() {
        val controller = WindowInsetsControllerCompat(window, window.decorView)
        controller.hide(WindowInsetsCompat.Type.systemBars())
        controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
    }

    private fun showVoiceOverlay(
        title: String,
        message: String,
        transcript: String? = null
    ) {
        voiceOverlay.visibility = View.VISIBLE
        voiceTitle.text = title
        voiceMessage.text = message
        voiceTranscript.text = transcript?.let { "${getString(R.string.voice_transcript_prefix)} $it" } ?: ""
    }

    private fun hideVoiceOverlay() {
        voiceOverlay.visibility = View.GONE
        voiceTitle.text = getString(R.string.voice_title_idle)
        voiceMessage.text = getString(R.string.voice_message_idle)
        voiceTranscript.text = ""
    }

    private fun showOverlay(
        title: String = "",
        message: String = "",
        visible: Boolean
    ) {
        statusOverlay.visibility = if (visible) View.VISIBLE else View.GONE
        statusTitle.text = title
        statusMessage.text = message
        if (!visible) {
            statusNowPlaying.text = currentSnapshot?.let { listOfNotNull(it.showTitle, it.title).joinToString(" - ") } ?: ""
        }
    }

    companion object {
        private const val TAG = "ClawTvMainActivity"
        private const val REQUEST_RECORD_AUDIO_PERMISSION = 1001
        private const val POLL_INTERVAL_MS = 2_000L
        private const val POSITION_SYNC_INTERVAL_MS = 5_000L
        private const val RESYNC_DRIFT_MS = 5_000L
        private const val SEEK_BACK_MS = 10_000
        private const val SEEK_FORWARD_MS = 30_000
    }
}

private data class PlaybackSnapshotPayload(
    val sessionId: String?,
    val playbackState: String,
    val playbackPositionMs: Int,
    val controlRevision: Int,
    val controlRevisionChanged: Boolean,
    val title: String?,
    val showTitle: String?,
    val receiverCommandId: String?,
    val streamUrl: String?
)
