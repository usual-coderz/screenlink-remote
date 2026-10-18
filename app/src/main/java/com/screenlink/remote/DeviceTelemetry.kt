package com.screenlink.remote

import android.Manifest
import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Build
import android.os.Environment
import android.os.StatFs
import android.provider.Settings
import android.telephony.SubscriptionManager
import android.telephony.TelephonyManager
import org.json.JSONArray
import org.json.JSONObject
import java.net.Inet4Address
import java.net.NetworkInterface

object DeviceTelemetry {

    const val PREFS = "screenlink_preferences"
    const val KEY_MANUAL_SIM = "manual_sim_number"

    private inline fun <T> safe(fallback: T, block: () -> T): T =
        try { block() } catch (_: Exception) { fallback }

    fun build(context: Context): JSONObject {
        val t = JSONObject()

        t.put("manufacturer", Build.MANUFACTURER ?: "")
        t.put("brand", Build.BRAND ?: "")
        t.put("model", Build.MODEL ?: "")
        t.put("product", Build.PRODUCT ?: "")
        t.put("hardware", Build.HARDWARE ?: "")
        t.put("device_name", "${Build.MANUFACTURER} ${Build.MODEL}")
        t.put("android_version", Build.VERSION.RELEASE ?: "")
        t.put("sdk_int", Build.VERSION.SDK_INT)
        t.put("android_id", safe("") {
            Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID) ?: ""
        })

        val metrics = context.resources.displayMetrics
        t.put("screen_resolution", "${metrics.widthPixels}x${metrics.heightPixels}")
        t.put("screen_density", metrics.densityDpi)

        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
        if (am != null) {
            val mi = ActivityManager.MemoryInfo()
            safe(Unit) { am.getMemoryInfo(mi) }
            t.put("ram_total_mb", mi.totalMem / (1024 * 1024))
            t.put("ram_available_mb", mi.availMem / (1024 * 1024))
        }

        safe(Unit) {
            val stat = StatFs(Environment.getDataDirectory().path)
            val bs = stat.blockSizeLong
            t.put("storage_total_gb", (stat.blockCountLong * bs) / (1024L * 1024L * 1024L))
            t.put("storage_free_gb", (stat.availableBlocksLong * bs) / (1024L * 1024L * 1024L))
        }

        // --- Battery
        val bm = context.getSystemService(Context.BATTERY_SERVICE) as? BatteryManager
        t.put("battery_level", safe(-1) {
            bm?.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY) ?: -1
        })

        safe(Unit) {
            val intent = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
            val status = intent?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
            val plugged = intent?.getIntExtra(BatteryManager.EXTRA_PLUGGED, -1) ?: -1
            val temp = intent?.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, 0) ?: 0

            t.put("battery_charging",
                status == BatteryManager.BATTERY_STATUS_CHARGING ||
                status == BatteryManager.BATTERY_STATUS_FULL)
            t.put("battery_plugged", pluggedLabel(plugged))
            t.put("battery_temperature_c", temp / 10.0)
        }

        // --- SIM (proper resolution)
        val telephony = context.getSystemService(Context.TELEPHONY_SERVICE) as? TelephonyManager
        t.put("sim_carrier", safe("") { telephony?.networkOperatorName ?: "" })
        t.put("sim_operator", safe("") { telephony?.simOperatorName ?: "" })
        t.put("sim_country", safe("") { telephony?.simCountryIso ?: "" })
        t.put("sim_serial", safe("") { telephony?.simSerialNumber ?: "" })
        t.put("sim_state", safe(-1) { telephony?.simState ?: -1 })
        t.put("network_type", safe("Unknown") { networkTypeName(telephony?.dataNetworkType ?: 0) })

        val sims = readSims(context)
        t.put("sims", sims)

        // Pehla carrier number, warna manual override
        var resolved = ""
        var source = "unavailable"
        for (i in 0 until sims.length()) {
            val n = sims.optJSONObject(i)?.optString("number").orEmpty()
            if (n.isNotBlank()) { resolved = n; source = "carrier"; break }
        }

        val manual = context
            .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(KEY_MANUAL_SIM, "").orEmpty().trim()

        if (resolved.isBlank() && manual.isNotBlank()) {
            resolved = manual
            source = "manual"
        }

        t.put("sim_number", resolved)
        t.put("sim_number_source", source)
        t.put("sim_number_manual", manual)

        // --- Network
        safe(Unit) {
            val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
            val caps = cm?.getNetworkCapabilities(cm.activeNetwork)
            t.put("wifi_connected", caps?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true)
            t.put("mobile_connected", caps?.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) == true)
        }
        t.put("local_ip", localIpAddress())

        return t
    }

    /**
     * Har active subscription pe try karta hai:
     *  1. SubscriptionManager.getPhoneNumber(subId)   -> API 33+
     *  2. SubscriptionInfo.getNumber()
     *  3. TelephonyManager.createForSubscriptionId(subId).line1Number
     * Kai carriers (Jio jaise) number SIM pe store hi nahi karte -> blank rehta hai.
     */
    private fun readSims(context: Context): JSONArray {
        val array = JSONArray()

        if (context.checkSelfPermission(Manifest.permission.READ_PHONE_STATE)
            != PackageManager.PERMISSION_GRANTED) {
            return array
        }

        val subManager = context.getSystemService(Context.TELEPHONY_SUBSCRIPTION_SERVICE)
            as? SubscriptionManager

        val subs = safe(emptyList<android.telephony.SubscriptionInfo>()) {
            subManager?.activeSubscriptionInfoList ?: emptyList()
        }

        for (sub in subs) {
            val entry = JSONObject()
            entry.put("slot", sub.simSlotIndex)
            entry.put("carrier", sub.carrierName?.toString() ?: "")
            entry.put("country", sub.countryIso ?: "")

            var number = ""
            var source = "unavailable"

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                val n = safe("") {
                    subManager?.getPhoneNumber(sub.subscriptionId)?.trim().orEmpty()
                }
                if (n.isNotBlank()) { number = n; source = "carrier" }
            }

            if (number.isBlank()) {
                val n = safe("") { sub.number?.trim().orEmpty() }
                if (n.isNotBlank()) { number = n; source = "carrier" }
            }

            if (number.isBlank()) {
                val n = safe("") {
                    val tm = context.getSystemService(Context.TELEPHONY_SERVICE) as TelephonyManager
                    tm.createForSubscriptionId(sub.subscriptionId).line1Number?.trim().orEmpty()
                }
                if (n.isNotBlank()) { number = n; source = "carrier" }
            }

            entry.put("number", number)
            entry.put("number_source", source)
            array.put(entry)
        }

        return array
    }

    private fun pluggedLabel(plugged: Int): String = when (plugged) {
        BatteryManager.BATTERY_PLUGGED_AC -> "AC"
        BatteryManager.BATTERY_PLUGGED_USB -> "USB"
        BatteryManager.BATTERY_PLUGGED_WIRELESS -> "Wireless"
        else -> "None"
    }

    private fun networkTypeName(type: Int): String = when (type) {
        TelephonyManager.NETWORK_TYPE_LTE -> "LTE"
        TelephonyManager.NETWORK_TYPE_NR -> "5G"
        TelephonyManager.NETWORK_TYPE_HSPA,
        TelephonyManager.NETWORK_TYPE_HSDPA,
        TelephonyManager.NETWORK_TYPE_HSUPA,
        TelephonyManager.NETWORK_TYPE_UMTS -> "3G"
        TelephonyManager.NETWORK_TYPE_EDGE,
        TelephonyManager.NETWORK_TYPE_GPRS,
        TelephonyManager.NETWORK_TYPE_CDMA,
        TelephonyManager.NETWORK_TYPE_1xRTT -> "2G"
        TelephonyManager.NETWORK_TYPE_UNKNOWN -> "Unknown"
        else -> "Type $type"
    }

    private fun localIpAddress(): String = safe("") {
        NetworkInterface.getNetworkInterfaces().toList()
            .flatMap { it.inetAddresses.toList() }
            .firstOrNull { !it.isLoopbackAddress && it is Inet4Address }
            ?.hostAddress ?: ""
    }
}