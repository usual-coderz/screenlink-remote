package com.screenlink.remote

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.telephony.SmsManager
import android.util.Log

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
        val action = intent.action ?: return
        if (!SimRouter.isStatusAction(action)) return

        val id = intent.getStringExtra(EXTRA_ID)
        if (id.isNullOrBlank()) return

        val kind = resolveKind(intent, action) ?: return

        val part = intent.getIntExtra(EXTRA_PART, 0).coerceAtLeast(0)
        val total = intent.getIntExtra(EXTRA_TOTAL, 1).coerceAtLeast(1)
        val slot = intent.getIntExtra(EXTRA_SLOT, -1)
        val code = resultCode

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
                    if (code == Activity.RESULT_OK) SmsParts.partSent(app, id, part, total, slot)
                    else SmsParts.fail(app, id, SimRouter.errorText(code), slot)
                } else {
                    if (code == Activity.RESULT_OK) SmsParts.partDelivered(app, id, part, total, slot)
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

        try {
            Ack.pool.execute(job)
        } catch (_: Throwable) {
            job.run()
        }
    }

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
}