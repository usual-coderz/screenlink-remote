package com.screenlink.remote

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.telephony.SmsManager
import android.util.Log

/**
 * SmsManager ke sent / delivery PendingIntents yahan aate hain.
 *
 * Har part ka result SmsParts me judta hai; final ack (sent / delivered / failed)
 * wahan se ek hi baar jaata hai — isliye multipart SMS par 3 alag acks nahi aate.
 *
 * Robustness:
 *  - goAsync() ka finish() har haal me hota hai (warna receiver leak)
 *  - action se bhi kind derive hota hai (kind extra missing ho to bhi chalta hai)
 *  - poora body try/catch me — koi bhi throw receiver ko na gira de
 */
class SmsStatusReceiver : BroadcastReceiver() {

    companion object {
        private const val TAG = "SmsStatusReceiver"
    }

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action

        // teeno actions accept karo — manifest aur SimRouter dono se aata hai
        val isKnown = action == SimRouter.ACTION_SMS_STATUS ||
            action == SimRouter.ACTION_SMS_SENT ||
            action == SimRouter.ACTION_SMS_DELIVERED
        if (!isKnown) return

        val id = intent.getStringExtra("id")
        if (id.isNullOrBlank()) return

        // kind: extra se, warna action se derive karo
        val kind = intent.getStringExtra("kind") ?: when (action) {
            SimRouter.ACTION_SMS_SENT -> "sent"
            SimRouter.ACTION_SMS_DELIVERED -> "delivered"
            else -> null
        } ?: return

        val part = intent.getIntExtra("part", 0)
        val total = intent.getIntExtra("total", 1).coerceAtLeast(1)
        val slot = intent.getIntExtra("slot", -1)
        val code = resultCode

        // goAsync se pehle kuch bhi throw ho jaye to bhi receiver safe rahe
        val pending = try {
            goAsync()
        } catch (t: Throwable) {
            Log.w(TAG, "goAsync fail", t)
            null
        }

        val app = context.applicationContext

        val job = Runnable {
            try {
                if (kind == "sent") {
                    if (code == Activity.RESULT_OK) {
                        SmsParts.partSent(app, id, part, total, slot)
                    } else {
                        SmsParts.fail(app, id, SimRouter.errorText(code), slot)
                    }
                } else {
                    // delivery report optional hai — kuch carriers bhejte hi nahi.
                    // Fail hone par poora message fail nahi karte, sirf log karte hain.
                    if (code == Activity.RESULT_OK) {
                        SmsParts.partDelivered(app, id, part, total, slot)
                    } else if (isRealDeliveryError(code)) {
                        Log.i(TAG, "delivery fail id=$id part=$part: ${SimRouter.errorText(code)}")
                    }
                }
            } catch (t: Throwable) {
                Log.w(TAG, "status handle fail", t)
            } finally {
                try {
                    pending?.finish()
                } catch (_: Throwable) {
                }
            }
        }

        // pool shut ho chuka ho to bhi job chale
        try {
            Ack.pool.execute(job)
        } catch (_: Throwable) {
            job.run()
        }
    }

    /** RESULT_CANCELED (-1) normal hai delivery reports me — use error na maano. */
    private fun isRealDeliveryError(code: Int): Boolean = when (code) {
        SmsManager.RESULT_ERROR_GENERIC_FAILURE,
        SmsManager.RESULT_ERROR_NO_SERVICE,
        SmsManager.RESULT_ERROR_NULL_PDU,
        SmsManager.RESULT_ERROR_RADIO_OFF -> true
        else -> false
    }
}