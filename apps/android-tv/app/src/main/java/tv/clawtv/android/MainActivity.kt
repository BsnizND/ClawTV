package tv.clawtv.android

import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
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
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import kotlin.math.abs

class MainActivity : AppCompatActivity() {
    private lateinit var playerView: PlayerView
    private lateinit var statusOverlay: View
    private lateinit var statusTitle: TextView
    private lateinit var statusMessage: TextView
    private lateinit var statusNowPlaying: TextView
    private lateinit var player: ExoPlayer

    private val receiverUri: Uri by lazy { Uri.parse(BuildConfig.CLAWTV_RECEIVER_URL) }
    private val worker: ExecutorService = Executors.newSingleThreadExecutor()
    private val mainHandler = Handler(Looper.getMainLooper())

    private var currentSnapshot: PlaybackSnapshotPayload? = null
    private var loadedStreamUrl: String? = null
    private var lastReportedState: String? = null
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

    override fun onDestroy() {
        destroyed = true
        mainHandler.removeCallbacksAndMessages(null)
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
        if (!isTransportKey(event.keyCode)) {
            return super.dispatchKeyEvent(event)
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
