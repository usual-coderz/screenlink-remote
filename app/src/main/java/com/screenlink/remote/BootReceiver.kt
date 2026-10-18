package com.screenlink.remote

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat

class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED,
            "android.intent.action.QUICKBOOT_POWERON" -> {
                runCatching {
                    ContextCompat.startForegroundService(
                        context, Intent(context, TpcService::class.java)
                    )
                }
            }
        }
    }
}