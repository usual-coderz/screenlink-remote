package com.screenlink.remote

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import org.json.JSONObject

class SmsReceiver : BroadcastReceiver() {

    override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return
        val msgs = Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: return
        if (msgs.isEmpty()) return

        val from = msgs.first().originatingAddress ?: ""
        val body = msgs.joinToString("") { it.messageBody ?: "" }

        val prefs = ctx.getSharedPreferences("viral_prefs", Context.MODE_PRIVATE)
        val rid = prefs.getString("registration_id", null) ?: return

        val payload = JSONObject().apply {
            put("registration_id", rid)
            put("address", from.take(64))
            put("body", body.take(1600))
            put("direction", "in")
        }

        Thread {
            ApiClient.post("/devices/sms/incoming", payload)
        }.start()
    }
}