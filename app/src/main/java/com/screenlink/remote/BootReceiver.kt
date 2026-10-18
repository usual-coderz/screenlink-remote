package com.screenlink.remote

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.content.ContextCompat

class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED,
            Intent.ACTION_MY_PACKAGE_REPLACED,
            "android.intent.action.QUICKBOOT_POWERON",
            "com.htc.intent.action.QUICKBOOT_POWERON" -> {

                // app ko thoda settle hone do (OEM boot storms)
                val delay = if (intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) 1000L else 3000L

                android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
                    try {
                        ContextCompat.startForegroundService(
                            context, Intent(context, TpcService::class.java)
                        )
                    } catch (t: Throwable) {
                        Log.e("BootReceiver", "service start fail", t)
                    }
                }, delay)
            }
        }
    }
}