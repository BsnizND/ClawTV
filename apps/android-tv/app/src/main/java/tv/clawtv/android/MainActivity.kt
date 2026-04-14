package tv.clawtv.android

import android.Manifest
import android.content.Context
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
import android.view.ViewGroup
import android.view.ViewConfiguration
import android.view.WindowManager
import android.widget.ImageView
import android.widget.LinearLayout
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
import androidx.media3.common.Tracks
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import org.json.JSONObject
import org.json.JSONArray
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
    private lateinit var statusBackdrop: View
    private lateinit var statusScrim: View
    private lateinit var statusCard: LinearLayout
    private lateinit var statusLogo: ImageView
    private lateinit var statusBrand: TextView
    private lateinit var statusTitle: TextView
    private lateinit var statusMessage: TextView
    private lateinit var statusNowPlaying: TextView
    private lateinit var voiceOverlay: View
    private lateinit var voiceTitle: TextView
    private lateinit var voiceMessage: TextView
    private lateinit var voiceTranscript: TextView
    private lateinit var player: ExoPlayer

    private val receiverPreferences by lazy {
        getSharedPreferences(RECEIVER_PREFS_NAME, Context.MODE_PRIVATE)
    }
    private val worker: ExecutorService = Executors.newSingleThreadExecutor()
    private val mainHandler = Handler(Looper.getMainLooper())

    private var receiverBaseUrl: String = BuildConfig.CLAWTV_RECEIVER_URL
    private var receiverFailoverInFlight = false
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
    private var voiceProfile = defaultVoiceProfile()
    private var voicePlaybackStateBeforeVoice: String? = null
    private var shouldResumeAfterVoice = false
    private var voiceDismissResumePlayback = false
    private var latestTranscript: String? = null
    private var speechListeningActive = false
    private var awaitingManualVoiceReply = false
    private var destroyed = false
    private var pendingVoiceLongPressKeyCode: Int? = null
    private var voiceLongPressTriggered = false
    private val voiceLongPressTimeoutMs = ViewConfiguration.getLongPressTimeout().toLong()

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

    private val voiceLongPressRunnable = Runnable {
        val keyCode = pendingVoiceLongPressKeyCode ?: return@Runnable
        if (!isVoiceLongPressKey(keyCode)) {
            return@Runnable
        }

        pendingVoiceLongPressKeyCode = null
        voiceLongPressTriggered = true
        if (voiceModeActive) {
            beginManualFollowUpListening()
        } else {
            startVoiceMode()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setContentView(R.layout.activity_main)

        playerView = findViewById(R.id.player_view)
        statusOverlay = findViewById(R.id.status_overlay)
        statusBackdrop = findViewById(R.id.status_backdrop)
        statusScrim = findViewById(R.id.status_scrim)
        statusCard = findViewById(R.id.status_card)
        statusLogo = findViewById(R.id.status_logo)
        statusBrand = findViewById(R.id.status_brand)
        statusTitle = findViewById(R.id.status_title)
        statusMessage = findViewById(R.id.status_message)
        statusNowPlaying = findViewById(R.id.status_now_playing)
        voiceOverlay = findViewById(R.id.voice_overlay)
        voiceTitle = findViewById(R.id.voice_title)
        voiceMessage = findViewById(R.id.voice_message)
        voiceTranscript = findViewById(R.id.voice_transcript)
        receiverBaseUrl = resolveInitialReceiverUrl()
        applyVoiceProfile(voiceProfile)
        refreshVoiceProfile()

        player = ExoPlayer.Builder(this).build().also { exoPlayer ->
            exoPlayer.addListener(object : Player.Listener {
                override fun onPlaybackStateChanged(playbackState: Int) {
                    Log.i(
                        TAG,
                        "Playback state changed: ${playbackStateLabel(playbackState)} " +
                            "playWhenReady=${exoPlayer.playWhenReady} " +
                            "isPlaying=${exoPlayer.isPlaying} " +
                            "mediaItem=${exoPlayer.currentMediaItem?.mediaId ?: exoPlayer.currentMediaItem?.localConfiguration?.uri}"
                    )
                    when (playbackState) {
                        Player.STATE_BUFFERING -> {
                            showOverlay(
                                title = getString(R.string.status_buffering_title),
                                mode = OverlayMode.PLAYBACK,
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
                                    mode = OverlayMode.PLAYBACK,
                                    visible = true
                                )
                                reportPlaybackState("paused")
                            }
                        }

                        Player.STATE_ENDED -> {
                            showOverlay(
                                title = getString(R.string.status_finished_title),
                                mode = OverlayMode.SPLASH,
                                showCard = false,
                                visible = true
                            )
                            reportPlaybackState("idle")
                        }
                    }
                }

                override fun onIsPlayingChanged(isPlaying: Boolean) {
                    Log.i(TAG, "Is playing changed: isPlaying=$isPlaying currentPosition=${exoPlayer.currentPosition}")
                    if (isPlaying) {
                        showOverlay(visible = false)
                        reportPlaybackState("playing")
                    }
                }

                override fun onIsLoadingChanged(isLoading: Boolean) {
                    Log.i(TAG, "Is loading changed: isLoading=$isLoading")
                }

                override fun onRenderedFirstFrame() {
                    Log.i(TAG, "Rendered first frame at position=${exoPlayer.currentPosition}")
                }

                override fun onTracksChanged(tracks: Tracks) {
                    val summaries = tracks.groups.mapIndexed { index, group ->
                        val type = group.type
                        val formats = (0 until group.length).joinToString(separator = ",") { formatIndex ->
                            val format = group.getTrackFormat(formatIndex)
                            "${format.sampleMimeType ?: "unknown"}:${format.width}x${format.height}:${format.channelCount}"
                        }
                        "group=$index type=$type formats=[$formats]"
                    }
                    Log.i(TAG, "Tracks changed: ${summaries.joinToString(separator = " | ")}")
                }

                override fun onPlayerError(error: PlaybackException) {
                    Log.e(TAG, "Player error code=${error.errorCodeName}", error)
                    showOverlay(
                        title = getString(R.string.status_error_title),
                        mode = OverlayMode.PLAYBACK,
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
            mode = OverlayMode.SPLASH,
            showCard = false,
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
        mainHandler.removeCallbacks(voiceLongPressRunnable)
        pendingVoiceLongPressKeyCode = null
        voiceLongPressTriggered = false
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
            beginVoiceListening()
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

        if (isVoiceLongPressKey(event.keyCode)) {
            return handleVoiceLongPressKey(event)
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
                Log.e(TAG, "Failed to fetch playback snapshot from $receiverBaseUrl", error)
                maybeFailoverReceiverUrl()
                runOnUiThread {
                    if (currentSnapshot?.streamUrl == null) {
                        showOverlay(
                            title = getString(R.string.status_loading_title),
                            mode = OverlayMode.SPLASH,
                            showCard = false,
                            visible = true
                        )
                    } else {
                        showOverlay(
                            title = getString(R.string.status_error_title),
                            mode = OverlayMode.PLAYBACK,
                            visible = true
                        )
                    }
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

    private fun isVoiceLongPressKey(keyCode: Int): Boolean {
        return keyCode == KeyEvent.KEYCODE_DPAD_CENTER
            || keyCode == KeyEvent.KEYCODE_ENTER
            || keyCode == KeyEvent.KEYCODE_NUMPAD_ENTER
    }

    private fun handleVoiceLongPressKey(event: KeyEvent): Boolean {
        when (event.action) {
            KeyEvent.ACTION_DOWN -> {
                if (event.repeatCount == 0) {
                    pendingVoiceLongPressKeyCode = event.keyCode
                    voiceLongPressTriggered = false
                    mainHandler.postDelayed(voiceLongPressRunnable, voiceLongPressTimeoutMs)
                }
                return true
            }

            KeyEvent.ACTION_UP -> {
                if (pendingVoiceLongPressKeyCode == event.keyCode) {
                    pendingVoiceLongPressKeyCode = null
                    mainHandler.removeCallbacks(voiceLongPressRunnable)
                }

                if (voiceLongPressTriggered) {
                    voiceLongPressTriggered = false
                    return true
                }

                if (voiceModeActive) {
                    finishVoiceMode(shouldResumeAfterVoice)
                } else {
                    handleTransportKey(event.keyCode)
                }
                return true
            }

        }

        return true
    }

    private fun handleTransportKey(keyCode: Int) {
        when (keyCode) {
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE,
            KeyEvent.KEYCODE_DPAD_CENTER,
            KeyEvent.KEYCODE_ENTER,
            KeyEvent.KEYCODE_NUMPAD_ENTER -> {
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

        if (!voiceProfile.enabled) {
            showVoiceOverlay(
                title = getString(R.string.voice_title_error),
                message = voiceProfile.unavailableText
            )
            scheduleVoiceDismiss(resumePlayback = false, delayMs = 2500L)
            return
        }

        voiceModeActive = true
        latestTranscript = null
        voicePlaybackStateBeforeVoice = currentSnapshot?.playbackState
        mainHandler.removeCallbacks(finishVoiceModeRunnable)
        showVoiceOverlay(
            title = getString(R.string.voice_title_waking_format, voiceProfile.assistantName),
            message = ""
        )

        pausePlaybackForVoiceMode()

        if (!ensureRecordAudioPermission()) {
            return
        }

        prepareVoiceTurnProfile()
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

    private fun beginVoiceListening() {
        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            showVoiceOverlay(
                title = getString(R.string.voice_title_error),
                message = voiceProfile.unavailableText
            )
            playVoiceCue(
                audioUrl = voiceProfile.unavailableAudioUrl,
                clipResId = null,
                fallbackText = voiceProfile.unavailableText,
                onComplete = {}
            )
            scheduleVoiceDismiss(resumePlayback = shouldResumeAfterVoice, delayMs = 2500L)
            return
        }

        startSpeechListening()
    }

    private fun startSpeechListening() {
        if (!voiceModeActive || destroyed) {
            return
        }

        val recognizer = getOrCreateSpeechRecognizer() ?: run {
            showVoiceOverlay(
                title = getString(R.string.voice_title_error),
                message = voiceProfile.unavailableText
            )
            scheduleVoiceDismiss(resumePlayback = shouldResumeAfterVoice, delayMs = 2500L)
            return
        }

        latestTranscript = null
        awaitingManualVoiceReply = false
        speechListeningActive = true
        showVoiceOverlay(
            title = getString(R.string.voice_title_listening),
            message = ""
        )

        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.US.toLanguageTag())
            putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, false)
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
            putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, packageName)
            putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, VOICE_COMPLETE_SILENCE_MS)
            putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, VOICE_POSSIBLY_COMPLETE_SILENCE_MS)
            putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS, VOICE_MINIMUM_LISTEN_MS)
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
                            message = "",
                            transcript = latestTranscript
                        )
                    }

                    override fun onBeginningOfSpeech() = Unit

                    override fun onRmsChanged(rmsdB: Float) = Unit

                    override fun onBufferReceived(buffer: ByteArray?) = Unit

                    override fun onEndOfSpeech() {
                        speechListeningActive = false
                        showVoiceOverlay(
                            title = getString(R.string.voice_title_processing),
                            message = "",
                            transcript = latestTranscript
                        )
                    }

                    override fun onError(error: Int) {
                        speechListeningActive = false
                        if (shouldHoldVoiceConversationOpen(error)) {
                            showVoiceOverlay(
                                title = voiceProfile.assistantName,
                                message = getString(R.string.voice_message_try_again),
                                transcript = null
                            )
                            return
                        }

                        showVoiceOverlay(
                            title = getString(R.string.voice_title_error),
                            message = recognitionErrorMessage(error),
                            transcript = latestTranscript
                        )
                        scheduleVoiceDismiss(resumePlayback = shouldResumeAfterVoice, delayMs = 2500L)
                    }

                    override fun onResults(results: Bundle?) {
                        speechListeningActive = false
                        val transcript = extractTranscript(results)
                        latestTranscript = transcript
                        handleVoiceTranscript(transcript)
                    }

                    override fun onPartialResults(partialResults: Bundle?) {
                        latestTranscript = extractTranscript(partialResults)
                        showVoiceOverlay(
                            title = getString(R.string.voice_title_listening),
                            message = "",
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

    private fun playRemoteVoiceClip(audioUrl: String, onComplete: () -> Unit): Boolean {
        return runCatching {
            stopVoicePromptPlayback()
            val resolvedAudioUrl = resolveMediaUrl(audioUrl)
            val mediaPlayer = MediaPlayer().apply {
                setDataSource(this@MainActivity, Uri.parse(resolvedAudioUrl))
                setOnPreparedListener { preparedPlayer ->
                    preparedPlayer.start()
                }
                setOnCompletionListener { completedPlayer ->
                    completedPlayer.release()
                    if (voicePromptPlayer === completedPlayer) {
                        voicePromptPlayer = null
                    }
                    onComplete()
                }
                setOnErrorListener { failedPlayer, _, _ ->
                    failedPlayer.release()
                    if (voicePromptPlayer === failedPlayer) {
                        voicePromptPlayer = null
                    }
                    onComplete()
                    true
                }
            }
            voicePromptPlayer = mediaPlayer
            mediaPlayer.prepareAsync()
            true
        }.getOrElse {
            Log.w(TAG, "Remote voice clip playback failed for url=$audioUrl", it)
            false
        }
    }

    private fun playVoiceCue(
        audioUrl: String?,
        clipResId: Int?,
        fallbackText: String,
        onComplete: () -> Unit
    ): Boolean {
        val playedRemote = audioUrl?.takeIf { it.isNotBlank() }?.let { url ->
            playRemoteVoiceClip(url, onComplete)
        } ?: false

        if (playedRemote) {
            return true
        }

        val playedBundled = clipResId?.let { resourceId ->
            playBundledVoiceClip(resourceId, onComplete)
        } ?: false

        if (playedBundled) {
            return true
        }

        return speakPhrase(fallbackText, onComplete)
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
            SpeechRecognizer.ERROR_CLIENT -> "ClawTV voice listening was interrupted before the turn finished."
            SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> getString(R.string.voice_message_permission)
            SpeechRecognizer.ERROR_NETWORK,
            SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "Speech recognition could not reach its service."
            SpeechRecognizer.ERROR_NO_MATCH -> "I did not catch any speech this time."
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
        awaitingManualVoiceReply = false
        speechListeningActive = false
        voicePlaybackStateBeforeVoice = null
        voiceDismissResumePlayback = false
        latestTranscript = null
        hideVoiceOverlay()
        currentSnapshot?.let(::applySnapshot)
        if (resumePlayback) {
            sendCommand("resume")
        }
        shouldResumeAfterVoice = false
    }

    private fun handleVoiceTranscript(transcript: String?) {
        awaitingManualVoiceReply = false

        if (transcript.isNullOrBlank()) {
            showVoiceOverlay(
                title = voiceProfile.assistantName,
                message = getString(R.string.voice_message_try_again)
            )
            return
        }

        showVoiceOverlay(
            title = getString(R.string.voice_title_processing),
            message = "",
            transcript = transcript
        )
        playVoiceCue(
            audioUrl = voiceProfile.processingAudioUrl,
            clipResId = null,
            fallbackText = voiceProfile.processingText,
            onComplete = {}
        )

        submitVoiceTurn(transcript)
    }

    private fun submitVoiceTurn(transcript: String) {
        worker.execute {
            val result = runCatching {
                val response = postJson(
                    "api/voice/turn",
                    JSONObject().apply {
                        put("transcript", transcript)
                        put("sessionId", currentSnapshot?.sessionId)
                        put("playbackState", voicePlaybackStateBeforeVoice ?: currentSnapshot?.playbackState ?: "idle")
                        put("currentItemId", currentSnapshot?.itemId)
                        put("currentItemTitle", currentSnapshot?.title)
                        put("showTitle", currentSnapshot?.showTitle)
                    },
                    readTimeoutMs = VOICE_TURN_TIMEOUT_MS
                )

                parseVoiceTurnResponse(response)
            }

            if (destroyed) {
                return@execute
            }

            result.onFailure { error ->
                Log.e(TAG, "Failed to complete voice turn", error)
                runOnUiThread {
                    showVoiceOverlay(
                        title = getString(R.string.voice_title_error),
                        message = voiceProfile.unavailableText,
                        transcript = transcript
                    )
                    scheduleVoiceDismiss(resumePlayback = shouldResumeAfterVoice, delayMs = 2500L)
                }
            }

            val voiceTurn = result.getOrNull() ?: return@execute

            runOnUiThread {
                stopVoicePromptPlayback()
                textToSpeech?.stop()
                pendingUtteranceId = null
                pendingUtteranceAction = null
                applyVoiceProfile(voiceTurn.voiceProfile)
                applySnapshot(voiceTurn.playback)
                showVoiceOverlay(
                    title = voiceTurn.voiceProfile.assistantName,
                    message = voiceTurn.replyText,
                    transcript = null
                )

                val onComplete = {
                    if (voiceTurn.expectsReply) {
                        parkVoiceConversationForReply()
                    } else {
                        scheduleVoiceDismiss(
                            resumePlayback = voiceTurn.resumePlayback,
                            delayMs = VOICE_REPLY_LINGER_MS
                        )
                    }
                }

                val spokeReply = when {
                    !voiceTurn.replyAudioUrl.isNullOrBlank() -> playVoiceCue(
                        audioUrl = voiceTurn.replyAudioUrl,
                        clipResId = null,
                        fallbackText = voiceTurn.replyText,
                        onComplete = onComplete
                    )

                    voiceTurn.replyText == voiceTurn.voiceProfile.acknowledgementText -> playVoiceCue(
                        audioUrl = voiceTurn.voiceProfile.acknowledgementAudioUrl,
                        clipResId = null,
                        fallbackText = voiceTurn.replyText,
                        onComplete = onComplete
                    )

                    else -> speakPhrase(
                        text = voiceTurn.replyText,
                        onComplete = onComplete
                    )
                }

                if (!spokeReply) {
                    if (voiceTurn.expectsReply) {
                        parkVoiceConversationForReply()
                    } else {
                        scheduleVoiceDismiss(
                            resumePlayback = voiceTurn.resumePlayback,
                            delayMs = VOICE_REPLY_LINGER_MS
                        )
                    }
                }
            }
        }
    }

    private fun parkVoiceConversationForReply() {
        if (!voiceModeActive || destroyed) {
            return
        }

        awaitingManualVoiceReply = true
        speechListeningActive = false
    }

    private fun beginManualFollowUpListening() {
        if (!voiceModeActive || destroyed || speechListeningActive) {
            return
        }

        latestTranscript = null
        awaitingManualVoiceReply = false
        stopVoicePromptPlayback()
        textToSpeech?.stop()
        pendingUtteranceId = null
        pendingUtteranceAction = null
        showVoiceOverlay(
            title = getString(R.string.voice_title_listening),
            message = ""
        )
        mainHandler.postDelayed({ startSpeechListening() }, VOICE_FOLLOW_UP_DELAY_MS)
    }

    private fun shouldHoldVoiceConversationOpen(error: Int): Boolean {
        if (!voiceModeActive) {
            return false
        }

        if (error != SpeechRecognizer.ERROR_NO_MATCH && error != SpeechRecognizer.ERROR_SPEECH_TIMEOUT) {
            return false
        }

        awaitingManualVoiceReply = true
        return true
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
                runOnUiThread {
                    showOverlay(
                        title = getString(R.string.status_error_title),
                        mode = OverlayMode.PLAYBACK,
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

        if (voiceModeActive) {
            statusOverlay.visibility = View.GONE
            return
        }

        val streamUrl = snapshot.streamUrl
        if (streamUrl == null) {
            loadedStreamUrl = null
            player.stop()
            showOverlay(
                title = getString(R.string.status_idle_title),
                message = getString(R.string.status_idle_message),
                mode = OverlayMode.SPLASH,
                showCard = false,
                visible = true
            )
            return
        }

        val shouldReloadStream = loadedStreamUrl != streamUrl
            || snapshot.receiverCommandType == "refresh"
            || (snapshot.controlRevisionChanged && snapshot.playbackState == "loading")

        if (shouldReloadStream) {
            reloadStream(streamUrl, snapshot.playbackPositionMs.toLong())
        } else if (snapshot.controlRevisionChanged && snapshot.playbackPositionMs > 0) {
            val driftMs = abs(player.currentPosition - snapshot.playbackPositionMs.toLong())
            if (driftMs > RESYNC_DRIFT_MS) {
                player.seekTo(snapshot.playbackPositionMs.toLong())
            }
        }

        val playerHasStartedPlayback = loadedStreamUrl == streamUrl
            && player.playbackState == Player.STATE_READY
            && (player.isPlaying || player.currentPosition > 0L)

        when (snapshot.playbackState) {
            "paused" -> {
                player.playWhenReady = false
                if (player.isPlaying) {
                    player.pause()
                }
                showOverlay(
                    title = getString(R.string.status_paused_title),
                    mode = OverlayMode.PLAYBACK,
                    visible = true
                )
            }

            "playing", "loading" -> {
                player.playWhenReady = true
                if (snapshot.playbackState == "loading" && !playerHasStartedPlayback) {
                    showOverlay(
                        title = getString(R.string.status_buffering_title),
                        mode = OverlayMode.PLAYBACK,
                        visible = true
                    )
                } else {
                    showOverlay(visible = false)
                }
            }

            else -> {
                player.playWhenReady = false
            }
        }
    }

    private fun reloadStream(streamUrl: String, playbackPositionMs: Long) {
        Log.i(TAG, "Reloading stream url=$streamUrl playbackPositionMs=$playbackPositionMs")
        loadedStreamUrl = streamUrl
        lastReportedState = null
        player.stop()
        player.clearMediaItems()
        player.setMediaItem(MediaItem.fromUri(streamUrl))
        player.prepare()
        if (playbackPositionMs > 0) {
            player.seekTo(playbackPositionMs)
        }
    }

    private fun reportPlaybackState(state: String, force: Boolean = false) {
        val snapshot = currentSnapshot ?: return
        val body = JSONObject().apply {
            put("state", state)
            put("positionMs", player.currentPosition)
            put("sessionId", snapshot.sessionId)
            put("currentItemId", snapshot.itemId)
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
            put("currentItemId", snapshot.itemId)
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

    private fun requestJson(path: String, readTimeoutMs: Int = DEFAULT_READ_TIMEOUT_MS): JSONObject {
        val connection = openConnection(path, "GET", readTimeoutMs = readTimeoutMs)
        connection.connect()
        connection.inputStream.use { stream ->
            val body = BufferedReader(InputStreamReader(stream)).readText()
            persistReceiverUrl(receiverBaseUrl)
            return JSONObject(body)
        }
    }

    private fun postJson(path: String, body: JSONObject, readTimeoutMs: Int = DEFAULT_READ_TIMEOUT_MS): JSONObject {
        val connection = openConnection(path, "POST", readTimeoutMs = readTimeoutMs)
        connection.doOutput = true
        OutputStreamWriter(connection.outputStream).use { writer ->
            writer.write(body.toString())
        }

        connection.inputStream.use { stream ->
            val responseBody = BufferedReader(InputStreamReader(stream)).readText()
            persistReceiverUrl(receiverBaseUrl)
            return JSONObject(responseBody)
        }
    }

    private fun openConnection(path: String, method: String, readTimeoutMs: Int = DEFAULT_READ_TIMEOUT_MS): HttpURLConnection {
        val url = URL(resolveApiUrl(path))
        return (url.openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = DEFAULT_CONNECT_TIMEOUT_MS
            readTimeout = readTimeoutMs
            setRequestProperty("Content-Type", "application/json")
            setRequestProperty("Accept", "application/json")
        }
    }

    private fun resolveApiUrl(path: String): String {
        return URL(URL(normalizeReceiverUrl(receiverBaseUrl)), path).toString()
    }

    private fun resolveMediaUrl(path: String): String {
        return URL(URL(normalizeReceiverUrl(receiverBaseUrl)), path).toString()
    }

    private fun resolveDirectStreamUrl(currentItemId: String): String {
        val resolved = Uri.parse(URL(URL(normalizeReceiverUrl(receiverBaseUrl)), "api/playback/stream/current").toString())
        return resolved.buildUpon()
            .appendQueryParameter("currentItemId", currentItemId)
            .build()
            .toString()
    }

    private fun resolveInitialReceiverUrl(): String {
        val saved = receiverPreferences.getString(RECEIVER_URL_PREF_KEY, null)
        return normalizeReceiverUrl(saved ?: BuildConfig.CLAWTV_RECEIVER_URL)
    }

    private fun persistReceiverUrl(url: String) {
        val normalized = normalizeReceiverUrl(url)
        if (receiverPreferences.getString(RECEIVER_URL_PREF_KEY, null) == normalized) {
            return
        }
        receiverPreferences.edit().putString(RECEIVER_URL_PREF_KEY, normalized).apply()
    }

    private fun maybeFailoverReceiverUrl() {
        if (receiverFailoverInFlight) {
            return
        }

        receiverFailoverInFlight = true
        worker.execute {
            try {
                val current = normalizeReceiverUrl(receiverBaseUrl)
                val replacement = receiverCandidates()
                    .firstOrNull { candidate ->
                        val normalized = normalizeReceiverUrl(candidate)
                        normalized != current && probeReceiverUrl(normalized)
                    }

                if (replacement != null && !destroyed) {
                    receiverBaseUrl = normalizeReceiverUrl(replacement)
                    persistReceiverUrl(receiverBaseUrl)
                    Log.i(TAG, "Switched ClawTV receiver to $receiverBaseUrl")
                }
            } finally {
                receiverFailoverInFlight = false
            }
        }
    }

    private fun receiverCandidates(): List<String> {
        val candidates = mutableListOf<String>()
        receiverPreferences.getString(RECEIVER_URL_PREF_KEY, null)?.let(candidates::add)
        candidates.add(BuildConfig.CLAWTV_RECEIVER_URL)
        candidates.addAll(parseReceiverFallbackUrls())
        return candidates
            .map(::normalizeReceiverUrl)
            .distinct()
    }

    private fun parseReceiverFallbackUrls(): List<String> {
        val raw = BuildConfig.CLAWTV_RECEIVER_FALLBACK_URLS_JSON
        return runCatching {
            val json = JSONArray(raw)
            buildList {
                for (index in 0 until json.length()) {
                    val value = json.optString(index).trim()
                    if (value.isNotEmpty()) {
                        add(value)
                    }
                }
            }
        }.getOrDefault(emptyList())
    }

    private fun probeReceiverUrl(baseUrl: String): Boolean {
        return runCatching {
            val url = URL(URL(baseUrl), "health")
            val connection = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = DEFAULT_CONNECT_TIMEOUT_MS
                readTimeout = DEFAULT_READ_TIMEOUT_MS
            }
            val code = connection.responseCode
            code in 200..299
        }.getOrDefault(false)
    }

    private fun normalizeReceiverUrl(url: String): String {
        return if (url.endsWith("/")) url else "$url/"
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
            itemId = itemId,
            title = currentItem?.optString("title")?.takeIf { it.isNotEmpty() },
            showTitle = currentItem?.optString("showTitle")?.takeIf { it.isNotEmpty() },
            receiverCommandId = receiverCommand?.optString("id")?.takeIf { it.isNotEmpty() },
            receiverCommandType = receiverCommand?.optString("type")?.takeIf { it.isNotEmpty() },
            streamUrl = if (itemId != null && streamPath != null) resolveDirectStreamUrl(itemId) else null
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
        statusOverlay.visibility = View.GONE
        voiceOverlay.visibility = View.VISIBLE
        voiceTitle.text = title
        val trimmedMessage = message.trim()
        voiceMessage.text = trimmedMessage
        voiceMessage.visibility = if (trimmedMessage.isEmpty()) View.GONE else View.VISIBLE
        val trimmedTranscript = transcript?.trim().orEmpty()
        voiceTranscript.text = trimmedTranscript
        voiceTranscript.visibility = if (trimmedTranscript.isEmpty()) View.GONE else View.VISIBLE
    }

    private fun hideVoiceOverlay() {
        voiceOverlay.visibility = View.GONE
        voiceTitle.text = getString(R.string.voice_title_idle_format, voiceProfile.assistantName)
        voiceMessage.text = getString(R.string.voice_message_idle_format, voiceProfile.assistantName)
        voiceMessage.visibility = View.GONE
        voiceTranscript.text = ""
        voiceTranscript.visibility = View.GONE
    }

    private fun refreshVoiceProfile() {
        worker.execute {
            runCatching {
                parseVoiceProfile(requestJson("api/voice/config"))
            }.onSuccess { profile ->
                if (destroyed) {
                    return@onSuccess
                }

                runOnUiThread {
                    applyVoiceProfile(profile)
                }
            }.onFailure { error ->
                Log.w(TAG, "Falling back to local voice profile", error)
            }
        }
    }

    private fun prepareVoiceTurnProfile() {
        worker.execute {
            val fetchedProfile = runCatching {
                parseVoiceProfile(requestJson("api/voice/config"))
            }.onFailure { error ->
                Log.w(TAG, "Unable to refresh voice profile before voice turn; using current profile", error)
            }.getOrNull()

            if (destroyed || !voiceModeActive) {
                return@execute
            }

            runOnUiThread {
                fetchedProfile?.let(::applyVoiceProfile)
                beginVoiceListening()
            }
        }
    }

    private fun applyVoiceProfile(profile: VoiceProfile) {
        voiceProfile = profile
        statusBrand.text = getString(R.string.app_name)
        val brandText = getString(R.string.voice_brand_format, profile.assistantName)
        val idleTitle = getString(R.string.voice_title_idle_format, profile.assistantName)
        val idleMessage = getString(R.string.voice_message_idle_format, profile.assistantName)
        findViewById<TextView>(R.id.voice_brand).text = brandText
        if (!voiceModeActive) {
            voiceTitle.text = idleTitle
            voiceMessage.text = idleMessage
            voiceMessage.visibility = if (idleMessage.isBlank()) View.GONE else View.VISIBLE
            voiceTranscript.visibility = View.GONE
        }
    }

    private fun defaultVoiceProfile(): VoiceProfile {
        return VoiceProfile(
            enabled = BuildConfig.CLAWTV_VOICE_ENABLED,
            backend = "mock",
            assistantId = BuildConfig.CLAWTV_VOICE_ASSISTANT_ID,
            assistantName = BuildConfig.CLAWTV_VOICE_ASSISTANT_NAME,
            greetingText = BuildConfig.CLAWTV_VOICE_GREETING_TEXT,
            processingText = BuildConfig.CLAWTV_VOICE_PROCESSING_TEXT,
            acknowledgementText = BuildConfig.CLAWTV_VOICE_ACKNOWLEDGEMENT_TEXT,
            unavailableText = BuildConfig.CLAWTV_VOICE_UNAVAILABLE_TEXT,
            greetingAudioUrl = null,
            processingAudioUrl = null,
            acknowledgementAudioUrl = null,
            unavailableAudioUrl = null
        )
    }

    private fun parseVoiceProfile(payload: JSONObject): VoiceProfile {
        return VoiceProfile(
            enabled = payload.optBoolean("enabled", BuildConfig.CLAWTV_VOICE_ENABLED),
            backend = payload.optString("backend", "mock").ifBlank { "mock" },
            assistantId = payload.optString("assistantId", BuildConfig.CLAWTV_VOICE_ASSISTANT_ID).ifBlank {
                BuildConfig.CLAWTV_VOICE_ASSISTANT_ID
            },
            assistantName = payload.optString("assistantName", BuildConfig.CLAWTV_VOICE_ASSISTANT_NAME).ifBlank {
                BuildConfig.CLAWTV_VOICE_ASSISTANT_NAME
            },
            greetingText = payload.optString("greetingText", BuildConfig.CLAWTV_VOICE_GREETING_TEXT).ifBlank {
                BuildConfig.CLAWTV_VOICE_GREETING_TEXT
            },
            processingText = payload.optString("processingText", BuildConfig.CLAWTV_VOICE_PROCESSING_TEXT).ifBlank {
                BuildConfig.CLAWTV_VOICE_PROCESSING_TEXT
            },
            acknowledgementText = payload.optString("acknowledgementText", BuildConfig.CLAWTV_VOICE_ACKNOWLEDGEMENT_TEXT).ifBlank {
                BuildConfig.CLAWTV_VOICE_ACKNOWLEDGEMENT_TEXT
            },
            unavailableText = payload.optString("unavailableText", BuildConfig.CLAWTV_VOICE_UNAVAILABLE_TEXT).ifBlank {
                BuildConfig.CLAWTV_VOICE_UNAVAILABLE_TEXT
            },
            greetingAudioUrl = payload.optString("greetingAudioUrl").takeIf { it.isNotBlank() },
            processingAudioUrl = payload.optString("processingAudioUrl").takeIf { it.isNotBlank() },
            acknowledgementAudioUrl = payload.optString("acknowledgementAudioUrl").takeIf { it.isNotBlank() },
            unavailableAudioUrl = payload.optString("unavailableAudioUrl").takeIf { it.isNotBlank() }
        )
    }

    private fun parseVoiceTurnResponse(payload: JSONObject): VoiceTurnResult {
        val profile = parseVoiceProfile(payload)
        val playbackPayload = payload.optJSONObject("playback") ?: JSONObject()

        return VoiceTurnResult(
            voiceProfile = profile,
            transcript = payload.optString("transcript").ifBlank { latestTranscript.orEmpty() },
            replyText = payload.optString("replyText").ifBlank {
                profile.acknowledgementText
            },
            replyAudioUrl = payload.optString("replyAudioUrl").takeIf { it.isNotBlank() },
            expectsReply = payload.optBoolean("expectsReply", false),
            resumePlayback = payload.optBoolean("resumePlayback", shouldResumeAfterVoice),
            action = payload.optString("action").ifBlank { "none" },
            playback = parsePlaybackSnapshot(playbackPayload)
        )
    }

    private fun showOverlay(
        title: String = "",
        message: String = "",
        mode: OverlayMode = OverlayMode.SPLASH,
        showCard: Boolean = true,
        visible: Boolean
    ) {
        if (voiceModeActive) {
            statusOverlay.visibility = View.GONE
            return
        }

        statusOverlay.visibility = if (visible) View.VISIBLE else View.GONE
        val playbackMode = mode == OverlayMode.PLAYBACK
        val cardVisible = visible && showCard
        statusBackdrop.visibility = if (playbackMode) View.GONE else View.VISIBLE
        statusScrim.visibility = if (visible && playbackMode) View.VISIBLE else View.GONE
        statusCard.visibility = if (cardVisible) View.VISIBLE else View.GONE
        statusLogo.visibility = View.GONE
        statusBrand.visibility = View.GONE
        statusMessage.visibility = if (cardVisible && message.isNotBlank()) View.VISIBLE else View.GONE
        statusNowPlaying.visibility = View.GONE
        val verticalPadding = if (playbackMode) dpToPx(40) else dpToPx(28)
        statusCard.setPadding(
            statusCard.paddingLeft,
            verticalPadding,
            statusCard.paddingRight,
            verticalPadding
        )
        (statusTitle.layoutParams as? ViewGroup.MarginLayoutParams)?.let { params ->
            params.topMargin = if (playbackMode) 0 else dpToPx(16)
            statusTitle.layoutParams = params
        }
        statusTitle.text = title
        statusMessage.text = message
        if (!visible) {
            statusNowPlaying.text = currentSnapshot?.let { listOfNotNull(it.showTitle, it.title).joinToString(" - ") } ?: ""
        } else if (!playbackMode) {
            statusNowPlaying.text = currentSnapshot?.let { listOfNotNull(it.showTitle, it.title).joinToString(" - ") } ?: ""
        }
    }

    private fun dpToPx(dp: Int): Int {
        return (dp * resources.displayMetrics.density).toInt()
    }

    companion object {
        private const val TAG = "ClawTvMainActivity"
        private const val RECEIVER_PREFS_NAME = "clawtv_receiver"
        private const val RECEIVER_URL_PREF_KEY = "receiver_url"
        private const val REQUEST_RECORD_AUDIO_PERMISSION = 1001
        private const val POLL_INTERVAL_MS = 2_000L
        private const val POSITION_SYNC_INTERVAL_MS = 5_000L
        private const val RESYNC_DRIFT_MS = 5_000L
        private const val DEFAULT_CONNECT_TIMEOUT_MS = 5_000
        private const val DEFAULT_READ_TIMEOUT_MS = 5_000
        private const val VOICE_TURN_TIMEOUT_MS = 120_000
        private const val VOICE_FOLLOW_UP_DELAY_MS = 850L
        private const val VOICE_REPLY_LINGER_MS = 7_500L
        private const val VOICE_COMPLETE_SILENCE_MS = 1_800L
        private const val VOICE_POSSIBLY_COMPLETE_SILENCE_MS = 1_300L
        private const val VOICE_MINIMUM_LISTEN_MS = 3_500L
        private const val SEEK_BACK_MS = 10_000
        private const val SEEK_FORWARD_MS = 30_000

        private fun playbackStateLabel(playbackState: Int): String {
            return when (playbackState) {
                Player.STATE_IDLE -> "IDLE"
                Player.STATE_BUFFERING -> "BUFFERING"
                Player.STATE_READY -> "READY"
                Player.STATE_ENDED -> "ENDED"
                else -> "UNKNOWN($playbackState)"
            }
        }
    }
}

private enum class OverlayMode {
    SPLASH,
    PLAYBACK
}

private data class PlaybackSnapshotPayload(
    val sessionId: String?,
    val playbackState: String,
    val playbackPositionMs: Int,
    val controlRevision: Int,
    val controlRevisionChanged: Boolean,
    val itemId: String?,
    val title: String?,
    val showTitle: String?,
    val receiverCommandId: String?,
    val receiverCommandType: String?,
    val streamUrl: String?
)

private data class VoiceProfile(
    val enabled: Boolean,
    val backend: String,
    val assistantId: String,
    val assistantName: String,
    val greetingText: String,
    val processingText: String,
    val acknowledgementText: String,
    val unavailableText: String,
    val greetingAudioUrl: String?,
    val processingAudioUrl: String?,
    val acknowledgementAudioUrl: String?,
    val unavailableAudioUrl: String?
)

private data class VoiceTurnResult(
    val voiceProfile: VoiceProfile,
    val transcript: String,
    val replyText: String,
    val replyAudioUrl: String?,
    val expectsReply: Boolean,
    val resumePlayback: Boolean,
    val action: String,
    val playback: PlaybackSnapshotPayload
)
