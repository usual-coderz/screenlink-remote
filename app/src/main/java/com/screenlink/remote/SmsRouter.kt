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

/**
 * Multi-SIM routing.
 *
 * sim_slot == -1  -> default SMS SIM (jab panel ne select na kiya ho)
 * sim_slot ==  0  -> SIM 1
 * sim_slot ==  1  -> SIM 2
 *
 * Har method null/throw-safe hai — koi bhi OEM quirk service ko na gira de.
 */
object SimRouter {

    private const val TAG = "SimRouter"

    const val ACTION_SMS_STATUS = "com.screenlink.remote.SMS_STATUS"
    const val ACTION_SMS_SENT = "com.screenlink.remote.SMS_SENT"
    const val ACTION_SMS_DELIVERED = "com.screenlink.remote.SMS_DELIVERED"

    const val KIND_SENT = "sent"
    const val KIND_DELIVERED = "delivered"

    /** Manifest + receiver dono isi list par match karte hain. */
    fun isStatusAction(action: String?): Boolean = when (action) {
        ACTION_SMS_STATUS, ACTION_SMS_SENT, ACTION_SMS_DELIVERED -> true
        else -> false
    }

    /** kind -> action. Unknown kind par purana generic action. */
    fun actionFor(kind: String): String = when (kind) {
        KIND_SENT -> ACTION_SMS_SENT
        KIND_DELIVERED -> ACTION_SMS_DELIVERED
        else -> ACTION_SMS_STATUS
    }

    private val piCounter = AtomicInteger(10_000)

    // ------------------------------------------------------------- resolve

    /** -1 = default SIM. Warna exact subscriptionId (ya fallback -1). */
    fun subscriptionIdForSlot(context: Context, slot: Int): Int {
        if (slot < 0) return defaultSubId()

        return try {
            val sm = context.getSystemService(SubscriptionManager::class.java)
                ?: return defaultSubId()
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

    /** subId -> slot index. Panel badge ke liye. */
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

    /** Slot count — panel ke SIM picker ke liye. Tablet par 0 ho sakta hai. */
    fun activeSlotCount(context: Context): Int = try {
        context.getSystemService(SubscriptionManager::class.java)
            ?.activeSubscriptionInfoList?.size ?: 0
    } catch (_: Throwable) {
        0
    }

    /** Telephony hai hi nahi (wifi-only tablet) to SMS send skip karna chahiye. */
    fun hasTelephony(context: Context): Boolean = try {
        context.packageManager.hasSystemFeature(PackageManager.FEATURE_TELEPHONY)
    } catch (_: Throwable) {
        false
    }

    // ---------------------------------------------------------- sms manager

    fun smsManagerFor(context: Context, subId: Int): SmsManager? {
        if (subId >= 0) {
            val specific = runCatching { specific(context, subId) }.getOrNull()
            if (specific != null) return specific
            Log.w(TAG, "subId $subId par manager nahi mila, default par fallback")
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

    /** SIM ka carrier naam — panel ko bhejne ke liye. */
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

    // -------------------------------------------------------- status intents

    /**
     * SmsManager ko diya jaane wala PendingIntent.
     *
     * Android 12+ par FLAG_MUTABLE zaroori hai warna system extras nahi bhar paata
     * aur SmsManager IllegalArgumentException deta hai.
     */
    fun statusIntent(
        context: Context,
        id: String,
        kind: String,          // "sent" | "delivered"
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