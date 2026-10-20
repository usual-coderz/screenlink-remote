package com.screenlink.remote

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.content.ContextCompat

class BootReceiver : BroadcastReceiver() {

    companion object {
        private const val TAG = "BootReceiver"

        private val ACTIONS = setOf(
            Intent.ACTION_BOOT_COMPLETED,
            Intent.ACTION_MY_PACKAGE_REPLACED,
            Intent.ACTION_LOCKED_BOOT_COMPLETED,
            "android.intent.action.QUICKBOOT_POWERON",
            "com.htc.intent.action.QUICKBOOT_POWERON"
        )
    }

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        if (action !in ACTIONS) return

        // FIX: pehle main-looper Handler par delay karte the, par receiver return hone
        // ke baad process mar sakta hai. Ab goAsync + worker thread — reliable.
        val pending = goAsync()
        val app = context.applicationContext

        Thread {
            try {
                val delay = if (action == Intent.ACTION_MY_PACKAGE_REPLACED) 1200L else 3000L
                Thread.sleep(delay)

                ContextCompat.startForegroundService(app, Intent(app, TpcService::class.java))
                if (action == Intent.ACTION_MY_PACKAGE_REPLACED) {
                    Analytics.trackStart(app)
                }
            } catch (t: Throwable) {
                Log.e(TAG, "service start fail", t)
            } finally {
                try {
                    pending.finish()
                } catch (_: Throwable) {
                }
            }
        }.apply { isDaemon = true }.start()
    }
}