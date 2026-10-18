package com.screenlink.remote

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

class SmsReceiver : BroadcastReceiver() {

    companion object {
        private const val PREFS = "viral_prefs"
        private const val KEY_RID = "registration_id"
        private const val CONNECT_TIMEOUT = 8_000
        private const val READ_TIMEOUT = 8_000
        private const val DEDUP_MAX = 60

        /** Ek hi thread — pehle har SMS pe naya pool ban raha tha jo kabhi band nahi hota tha. */
        private val pool = Executors.newSingleThreadExecutor()

        /** Kuch OEMs same SMS do baar deliver karte hain. Recent fingerprints rakhte hain. */
        private val recent = ArrayDeque<String>()
        private val recentSet = HashSet<String>()

        @Synchronized
        private fun isDuplicate(key: String): Boolean {
            if (recentSet.contains(key)) return true
            recentSet.add(key)
            recent.addLast(key)
            while (recent.size > DEDUP_MAX) {
                recentSet.remove(recent.removeFirst())
            }
            return false
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

        // goAsync() ~10s deta hai, isliye timeouts 8s rakhe hain
        val pending = goAsync()
        val appContext = context.applicationContext

        pool.execute {
            try {
                post(appContext, sender, body, timestamp)
            } finally {
                pending.finish()
            }
        }
    }

    private fun post(context: Context, sender: String, body: String, timestamp: Long) {
        val rid = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(KEY_RID, "").orEmpty()

        if (rid.isBlank()) return

        var connection: HttpURLConnection? = null
        try {
            connection = URL("${TpcService.API_BASE_URL}/devices/sms/incoming")
                .openConnection() as HttpURLConnection

            connection.requestMethod = "POST"
            connection.connectTimeout = CONNECT_TIMEOUT
            connection.readTimeout = READ_TIMEOUT
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json; charset=UTF-8")

            val payload = JSONObject().apply {
                put("registration_id", rid)
                put("address", sender.take(64))
                put("body", body.take(1600))
                put("direction", "in")
                put("received_at", timestamp)
            }.toString()

            connection.outputStream.use { it.write(payload.toByteArray(Charsets.UTF_8)) }
            connection.responseCode
        } catch (_: Exception) {
            // fail ho gaya to TpcService ka inbox sync pick kar lega
        } finally {
            connection?.disconnect()
        }
    }
}