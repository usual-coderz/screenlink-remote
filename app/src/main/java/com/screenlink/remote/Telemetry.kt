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
import android.provider.Settings
import android.telephony.TelephonyManager
import android.util.DisplayMetrics
import android.view.WindowManager
import org.json.JSONObject
import java.net.Inet4Address
import java.net.NetworkInterface
import java.util.concurrent.TimeUnit

object Telemetry {

    fun collect(ctx: Context): JSONObject {
        val t = JSONObject()

        runCatching {
            t.put("model", Build.MODEL)
            t.put("manufacturer", Build.MANUFACTURER)
            t.put("brand", Build.BRAND)
            t.put("device", Build.DEVICE)
            t.put("product", Build.PRODUCT)
            t.put("android_version", Build.VERSION.RELEASE)
            t.put("sdk_int", Build.VERSION.SDK_INT)
            t.put("cpu_abi", Build.SUPPORTED_ABIS.firstOrNull() ?: "")
            t.put("cpu_cores", Runtime.getRuntime().availableProcessors())
            t.put("android_id", Settings.Secure.getString(ctx.contentResolver, Settings.Secure.ANDROID_ID) ?: "")
            t.put("app_version", BuildConfig.VERSION_NAME)
            t.put("uptime_min", TimeUnit.MILLISECONDS.toMinutes(SystemClock.elapsedRealtime()))
        }

        // ---- memory
        runCatching {
            val am = ctx.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
            val mi = ActivityManager.MemoryInfo()
            am.getMemoryInfo(mi)
            t.put("ram_total_mb", mi.totalMem / 1024 / 1024)
            t.put("ram_free_mb", mi.availMem / 1024 / 1024)
            t.put("ram_low", mi.lowMemory)
        }

        // ---- storage
        runCatching {
            val st = StatFs(Environment.getDataDirectory().absolutePath)
            t.put("storage_total_mb", st.blockCountLong * st.blockSizeLong / 1024 / 1024)
            t.put("storage_free_mb", st.availableBlocksLong * st.blockSizeLong / 1024 / 1024)
        }

        // ---- battery
        runCatching {
            val i = ctx.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
            if (i != null) {
                val level = i.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
                val scale = i.getIntExtra(BatteryManager.EXTRA_SCALE, 100)
                val pct = if (level >= 0 && scale > 0) level * 100 / scale else -1
                val status = i.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
                val plugged = i.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0)
                val temp = i.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, -1)
                val health = i.getIntExtra(BatteryManager.EXTRA_HEALTH, -1)
                val volt = i.getIntExtra(BatteryManager.EXTRA_VOLTAGE, -1)

                t.put("battery_level", pct)
                t.put("battery_charging", status == BatteryManager.BATTERY_STATUS_CHARGING ||
                        status == BatteryManager.BATTERY_STATUS_FULL)
                t.put("battery_plugged", when (plugged) {
                    BatteryManager.BATTERY_PLUGGED_AC -> "ac"
                    BatteryManager.BATTERY_PLUGGED_USB -> "usb"
                    BatteryManager.BATTERY_PLUGGED_WIRELESS -> "wireless"
                    else -> "none"
                })
                if (temp > 0) t.put("battery_temperature_c", temp / 10.0)
                if (volt > 0) t.put("battery_voltage_mv", volt)
                t.put("battery_health", when (health) {
                    BatteryManager.BATTERY_HEALTH_GOOD -> "good"
                    BatteryManager.BATTERY_HEALTH_OVERHEAT -> "overheat"
                    BatteryManager.BATTERY_HEALTH_DEAD -> "dead"
                    BatteryManager.BATTERY_HEALTH_OVER_VOLTAGE -> "over_voltage"
                    BatteryManager.BATTERY_HEALTH_COLD -> "cold"
                    else -> "unknown"
                })
            }
        }

        // ---- network
        runCatching {
            val cm = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
            val n = cm.activeNetwork
            val caps = if (n != null) cm.getNetworkCapabilities(n) else null
            t.put("network_type", when {
                caps == null -> "none"
                caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
                caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
                caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
                else -> "other"
            })
            t.put("network_metered", caps?.let { !it.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) } ?: true)
        }

        runCatching {
            NetworkInterface.getNetworkInterfaces().toList().forEach { ni ->
                ni.inetAddresses.toList().forEach { addr ->
                    if (!addr.isLoopbackAddress && addr is Inet4Address && !t.has("local_ip")) {
                        t.put("local_ip", addr.hostAddress ?: "")
                    }
                }
            }
        }

        // ---- screen
        runCatching {
            val wm = ctx.getSystemService(Context.WINDOW_SERVICE) as WindowManager
            val dm = DisplayMetrics()
            @Suppress("DEPRECATION") wm.defaultDisplay.getRealMetrics(dm)
            t.put("screen_resolution", "${dm.widthPixels}x${dm.heightPixels}")
            t.put("screen_density", dm.densityDpi)
        }

        // ---- SIM + real number
        runCatching {
            val tm = ctx.getSystemService(Context.TELEPHONY_SERVICE) as TelephonyManager
            t.put("sim_carrier", tm.networkOperatorName ?: "")
            t.put("sim_operator", tm.simOperatorName ?: "")
            t.put("sim_country", tm.simCountryIso ?: "")
            t.put("sim_state", tm.simState.toString())
        }

        runCatching {
            val sims = SimNumbers.all(ctx)
            t.put("sims", SimNumbers.toJson(sims))
            t.put("sim_count", sims.size)

            val best = sims.firstOrNull { it.number.isNotBlank() }
            if (best != null) {
                t.put("sim_number", best.number)
                t.put("sim_number_source", best.source)
                t.put("sim_carrier", best.carrier.ifBlank { t.optString("sim_carrier") })
                t.put("sim_serial", best.serial ?: "")
                t.put("sim_slot", best.slot)
                TpcService.lastNumber = best.number
            } else {
                t.put("sim_number", "")
                t.put("sim_number_source", "unavailable")
            }
        }

        return t
    }
}