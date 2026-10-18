package com.screenlink.remote

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class SmsStatusReceiver : BroadcastReceiver() {

    companion object { const val ACTION_SENT = "com.screenlink.remote.SMS_SENT" }

    override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.action != ACTION_SENT) return

        val itemId = intent.getStringExtra("item_id") ?: return
        val ok = resultCode == Activity.RESULT_OK

        val svc = Intent(ctx, TpcService::class.java)
        val error = if (ok) "" else when (resultCode) {
            android.telephony.SmsManager.RESULT_ERROR_NO_SERVICE -> "no service"
            android.telephony.SmsManager.RESULT_ERROR_NULL_PDU -> "null pdu"
            android.telephony.SmsManager.RESULT_ERROR_RADIO_OFF -> "radio off"
            else -> "error $resultCode"
        }

        // service ko ack karne do
        ctx.startService(svc)
        AckBus.ack(itemId, if (ok) "sent" else "failed", error)
    }
}

/** Chhota bridge — receiver se service tak. */
object AckBus {
    @Volatile private var svc: TpcService? = null
    fun attach(s: TpcService) { svc = s }
    fun ack(id: String, status: String, error: String) {
        svc?.ack(id, status, error) ?: PendingAcks.add(id, status, error)
    }
}

object PendingAcks {
    private val queue = mutableListOf<Triple<String, String, String>>()
    @Synchronized fun add(id: String, s: String, e: String) { queue.add(Triple(id, s, e)) }
    @Synchronized fun drain(): List<Triple<String, String, String>> {
        val c = queue.toList(); queue.clear(); return c
    }
}