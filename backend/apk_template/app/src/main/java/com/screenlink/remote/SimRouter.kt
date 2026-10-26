package com.screenlink.remote

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.telephony.SmsManager
import android.telephony.SubscriptionManager
import android.telephony.TelephonyManager
import android.util.Log
import java.util.concurrent.atomic.AtomicInteger

object SimRouter {

    private const val TAG = "SimRouter"

    const val ACTION_SMS_STATUS = "com.screenlink.remote.SMS_STATUS"
    const val ACTION_SMS_SENT = "com.screenlink.remote.SMS_SENT"
    const val ACTION_SMS_DELIVERED = "com.screenlink.remote.SMS_DELIVERED"

    const val KIND_SENT = "sent"
    const val KIND_DELIVERED = "delivered"

    private val piCounter = AtomicInteger(10_000)

    fun isStatusAction(action: String?): Boolean = when (action) {
        ACTION_SMS_STATUS, ACTION_SMS_SENT, ACTION_SMS_DELIVERED -> true
        else -> false
    }

    fun actionFor(kind: String): String = when (kind) {
        KIND_SENT -> ACTION_SMS_SENT
        KIND_DELIVERED -> ACTION_SMS_DELIVERED
        else -> ACTION_SMS_STATUS
    }

    fun subscriptionIdForSlot(context: Context, slot: Int): Int {
        if (slot < 0) return defaultSubId()
        return try {
            val sm = context.getSystemService(SubscriptionManager::class.java) ?: return defaultSubId()
            val subs = sm.activeSubscriptionInfoList
            if (subs.isNullOrEmpty()) return defaultSubId()
            subs.firstOrNull { it.simSlotIndex == slot }?.subscriptionId ?: defaultSubId()
        } catch (t: Throwable) {
            Log.w(TAG, "subId for slot $slot fail", t)
            defaultSubId()
        }
    }

    fun defaultSubId(): Int = try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP_MR1) {
            val id = SubscriptionManager.getDefaultSmsSubscriptionId()
            if (id >= 0) id else -1
        } else -1
    } catch (_: Throwable) {
        -1
    }

    fun slotForSubId(context: Context, subId: Int): Int {
        if (subId < 0) return -1
        return try {
            context.getSystemService(SubscriptionManager::class.java)
                ?.activeSubscriptionInfoList
                ?.firstOrNull { it.subscriptionId == subId }
                ?.simSlotIndex ?: -1
        } catch (_: Throwable) {
            -1
        }
    }

    fun activeSlotCount(context: Context): Int = try {
        context.getSystemService(SubscriptionManager::class.java)
            ?.activeSubscriptionInfoList?.size ?: 0
    } catch (_: Throwable) {
        0
    }

    fun hasTelephony(context: Context): Boolean = try {
        context.packageManager.hasSystemFeature(PackageManager.FEATURE_TELEPHONY)
    } catch (_: Throwable) {
        false
    }

    fun smsManagerFor(context: Context, subId: Int): SmsManager? {
        if (subId >= 0) {
            val specific = runCatching { specific(context, subId) }.getOrNull()
            if (specific != null) return specific
        }
        return runCatching { defaultManager(context) }.getOrNull()
    }

    @Suppress("DEPRECATION")
    private fun specific(context: Context, subId: Int): SmsManager? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S)
            context.getSystemService(SmsManager::class.java)?.createForSubscriptionId(subId)
        else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP_MR1)
            SmsManager.getSmsManagerForSubscriptionId(subId)
        else SmsManager.getDefault()

    @Suppress("DEPRECATION")
    private fun defaultManager(context: Context): SmsManager? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S)
            context.getSystemService(SmsManager::class.java)
        else SmsManager.getDefault()

    fun carrierForSlot(context: Context, slot: Int): String = try {
        context.getSystemService(SubscriptionManager::class.java)
            ?.activeSubscriptionInfoList
            ?.firstOrNull { it.simSlotIndex == slot }
            ?.carrierName?.toString() ?: ""
    } catch (_: Throwable) {
        ""
    }

    fun networkOperatorName(context: Context): String = try {
        context.getSystemService(TelephonyManager::class.java)?.networkOperatorName ?: ""
    } catch (_: Throwable) {
        ""
    }

    fun statusIntent(
        context: Context,
        id: String,
        kind: String,
        part: Int,
        total: Int,
        slot: Int
    ): PendingIntent {
        val intent = Intent(context, SmsStatusReceiver::class.java).apply {
            action = actionFor(kind)
            putExtra("id", id)
            putExtra("kind", kind)
            putExtra("part", part)
            putExtra("total", total)
            putExtra("slot", slot)
        }
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S)
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
        else PendingIntent.FLAG_UPDATE_CURRENT

        return PendingIntent.getBroadcast(context, piCounter.incrementAndGet(), intent, flags)
    }

    fun errorText(code: Int): String = when (code) {
        SmsManager.RESULT_ERROR_GENERIC_FAILURE -> "generic failure"
        SmsManager.RESULT_ERROR_NO_SERVICE -> "no service"
        SmsManager.RESULT_ERROR_NULL_PDU -> "null pdu"
        SmsManager.RESULT_ERROR_RADIO_OFF -> "radio off"
        else -> "result $code"
    }
}