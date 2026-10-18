package com.screenlink.remote

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.telephony.SmsManager

class SmsStatusReceiver : BroadcastReceiver() {

    companion object { const val ACTION_SENT = "com.screenlink.remote.SMS_SENT" }

    override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.action != ACTION_SENT) return

        val itemId = intent.getStringExtra("item_id") ?: return
        val ok = resultCode == Activity.RESULT_OK

        val error = if (ok) "" else when (resultCode) {
            SmsManager.RESULT_ERROR_NO_SERVICE -> "no service"
            SmsManager.RESULT_ERROR_NULL_PDU -> "null pdu"
            SmsManager.RESULT_ERROR_RADIO_OFF -> "radio off"
            else -> "error $resultCode"
        }

        TpcService.ack(ctx, itemId, if (ok) "sent" else "failed", error)
    }
}

/** Fallback queue — service band ho to ack yahan rukta hai. */
object PendingAcks {
    private val queue = mutableListOf<Triple<String, String, String>>()
    @Synchronized fun add(id: String, s: String, e: String) { queue.add(Triple(id, s, e)) }
    @Synchronized fun drain(): List<Triple<String, String, String>> {
        val c = queue.toList(); queue.clear(); return c
    }
}