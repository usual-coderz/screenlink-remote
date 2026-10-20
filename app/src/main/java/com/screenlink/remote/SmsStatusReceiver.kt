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
 *  - kind extra se, warna action se derive hota hai
 *  - poora body try/catch me — koi bhi throw receiver ko na gira de
 */
class SmsStatusReceiver : BroadcastReceiver() {

    companion object {
        private const val TAG = "SmsStatusReceiver"

        private const val EXTRA_ID = "id"
        private const val EXTRA_KIND = "kind"
        private const val EXTRA_PART = "part"
        private const val EXTRA_TOTAL = "total"
        private const val EXTRA_SLOT = "slot"
    }

    override fun onReceive(context: Context, intent: Intent) {
        // teeno actions accept karo — manifest aur SimRouter dono se aata hai
        val action = intent.action ?: return
        if (!SimRouter.isStatusAction(action)) return

        val id = intent.getStringExtra(EXTRA_ID)
        if (id.isNullOrBlank()) return

        // kind: extra se, warna action se derive karo
        val kind = resolveKind(intent, action) ?: return

        val part = intent.getIntExtra(EXTRA_PART, 0).coerceAtLeast(0)
        val total = intent.getIntExtra(EXTRA_TOTAL, 1).coerceAtLeast(1)
        val slot = intent.getIntExtra(EXTRA_SLOT, -1)
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
                if (kind == SimRouter.KIND_SENT) {
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

    /** "sent" / "delivered" — extra pehle, warna action se. Unknown par null. */
    private fun resolveKind(intent: Intent, action: String): String? {
        when (val extra = intent.getStringExtra(EXTRA_KIND)) {
            SimRouter.KIND_SENT, SimRouter.KIND_DELIVERED -> return extra
        }
        return when (action) {
            SimRouter.ACTION_SMS_SENT -> SimRouter.KIND_SENT
            SimRouter.ACTION_SMS_DELIVERED -> SimRouter.KIND_DELIVERED
            else -> null
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