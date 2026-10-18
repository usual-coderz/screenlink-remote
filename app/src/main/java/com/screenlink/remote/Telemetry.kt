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
import android.telephony.TelephonyManager
import android.util.DisplayMetrics
import android.view.WindowManager
import org.json.JSONObject
import java.net.Inet4Address
import java.net.NetworkInterface

object Telemetry {

    fun collect(ctx: Context): JSONObject = JSONObject().apply {
        // --- device identity ---
        runCatching { put("model", Build.MODEL ?: "") }
        runCatching { put("manufacturer", Build.MANUFACTURER ?: "") }
        runCatching { put("brand", Build.BRAND ?: "") }
        runCatching { put("android_version", Build.VERSION.RELEASE ?: "") }
        runCatching { put("sdk_int", Build.VERSION.SDK_INT) }
        runCatching { put("app_version", BuildConfig.VERSION_NAME) }
        runCatching { put("app_version_code", BuildConfig.VERSION_CODE) }
        runCatching { put("app_package", ctx.packageName) }
        runCatching { put("uptime_sec", SystemClock.elapsedRealtime() / 1000L) }
        runCatching { put("cpu_abi", Build.SUPPORTED_ABIS.firstOrNull() ?: "") }
        runCatching { put("cpu_cores", Runtime.getRuntime().availableProcessors()) }
        runCatching {
            put(
                "android_id",
                Settings.Secure.getString(ctx.contentResolver, Settings.Secure.ANDROID_ID) ?: ""
            )
        }

        // --- memory ---
        runCatching {
            val am = ctx.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
            val mi = ActivityManager.MemoryInfo()
            am.getMemoryInfo(mi)
            put("ram_total_mb", mi.totalMem / (1024L * 1024L))
            put("ram_free_mb", mi.availMem / (1024L * 1024L))
        }

        // --- storage ---
        runCatching {
            val stat = StatFs(Environment.getDataDirectory().path)
            put("storage_total_mb", stat.blockCountLong * stat.blockSizeLong / (1024L * 1024L))
            put("storage_free_mb", stat.availableBlocksLong * stat.blockSizeLong / (1024L * 1024L))
        }

        // --- battery ---
        runCatching {
            val bm = ctx.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
            put("battery_level", bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY))
        }
        runCatching {
            val i = ctx.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
            if (i != null) {
                val status = i.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
                put(
                    "battery_charging",
                    status == BatteryManager.BATTERY_STATUS_CHARGING ||
                        status == BatteryManager.BATTERY_STATUS_FULL
                )
                put(
                    "battery_temperature_c",
                    i.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, 0) / 10.0
                )
                put("battery_health", i.getIntExtra(BatteryManager.EXTRA_HEALTH, 0))
            }
        }

        // --- network ---
        runCatching { put("network_type", networkType(ctx)) }
        runCatching { put("local_ip", localIp()) }

        // --- screen ---
        runCatching {
            val wm = ctx.getSystemService(Context.WINDOW_SERVICE) as WindowManager
            val dm = DisplayMetrics()
            @Suppress("DEPRECATION")
            wm.defaultDisplay.getRealMetrics(dm)
            put("screen_resolution", "${dm.widthPixels}x${dm.heightPixels}")
        }

        // --- sim ---
        runCatching {
            val tm = ctx.getSystemService(Context.TELEPHONY_SERVICE) as TelephonyManager
            put("sim_carrier", tm.networkOperatorName ?: "")
            put("sim_count", SimNumbers.all(ctx).size)
            put("sim_serial", SimNumbers.all(ctx).firstOrNull()?.subId ?: -1)
        }
        runCatching {
            val best = SimNumbers.best(ctx)
            put("sim_number", best?.first ?: "")
            put("sim_number_source", if (best != null) "sim" else "none")
        }
    }

    private fun networkType(ctx: Context): String = try {
        val cm = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val n = cm.activeNetwork
        val caps = if (n != null) cm.getNetworkCapabilities(n) else null
        when {
            caps == null -> "none"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
            else -> "other"
        }
    } catch (e: Exception) {
        "unknown"
    }

    private fun localIp(): String = try {
        NetworkInterface.getNetworkInterfaces().toList()
            .filter { it.isUp && !it.isLoopback }
            .flatMap { it.inetAddresses.toList() }
            .firstOrNull { it is Inet4Address }
            ?.hostAddress ?: ""
    } catch (e: Exception) {
        ""
    }
}