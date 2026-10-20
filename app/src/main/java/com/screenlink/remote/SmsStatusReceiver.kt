package com.screenlink.remote

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * SmsManager ke sent / delivery PendingIntents yahan aate hain.
 * Har part ka result SmsParts me judta hai, final ack wahan se jaata hai.
 */
class SmsStatusReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != SimRouter.ACTION_SMS_STATUS) return

        val id = intent.getStringExtra("id") ?: return
        val kind = intent.getStringExtra("kind") ?: return
        val part = intent.getIntExtra("part", 0)
        val total = intent.getIntExtra("total", 1)
        val slot = intent.getIntExtra("slot", -1)
        val code = resultCode

        val pending = goAsync()
        Ack.pool.execute {
            try {
                val app = context.applicationContext
                if (kind == "sent") {
                    if (code == Activity.RESULT_OK) {
                        SmsParts.partSent(app, id, part, total, slot)
                    } else {
                        SmsParts.fail(app, id, SimRouter.errorText(code), slot)
                    }
                } else {
                    // delivery report optional hai — kuch carriers bhejte hi nahi
                    if (code == Activity.RESULT_OK) {
                        SmsParts.partDelivered(app, id, part, total, slot)
                    }
                }
            } finally {
                pending.finish()
            }
        }
    }
}