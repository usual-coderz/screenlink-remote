package com.screenlink.remote

import android.content.Context
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

object Analytics {

    private const val PREFS = "viral_prefs"
    private const val KEY_FIRST_SEEN = "first_seen_at"
    private const val KEY_LAST_VER = "last_seen_version"
    private const val KEY_LAST_OPEN = "last_open_at"
    private const val KEY_FIRST_DONE = "first_seen_done"
    private const val OPEN_THROTTLE = 60 * 60 * 1000L

    private val io = Executors.newSingleThreadExecutor { r ->
        Thread(r, "analytics").apply { isDaemon = true }
    }

    fun trackStart(context: Context) {
        io.execute {
            try {
                val p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                val ver = DeviceInfo.versionName(context)
                val now = System.currentTimeMillis()

                val firstSeen = p.getBoolean(KEY_FIRST_DONE, false)
                val lastVer = p.getString(KEY_LAST_VER, null)

                when {
                    !firstSeen -> {
                        p.edit()
                            .putBoolean(KEY_FIRST_DONE, true)
                            .putLong(KEY_FIRST_SEEN, now)
                            .putString(KEY_LAST_VER, ver)
                            .putLong(KEY_LAST_OPEN, now)
                            .apply()
                        post(context, "install")
                    }
                    lastVer != ver -> {
                        p.edit().putString(KEY_LAST_VER, ver).putLong(KEY_LAST_OPEN, now).apply()
                        post(context, "update")
                    }
                    else -> {
                        if (now - p.getLong(KEY_LAST_OPEN, 0L) > OPEN_THROTTLE) {
                            p.edit().putLong(KEY_LAST_OPEN, now).apply()
                            post(context, "open")
                        }
                    }
                }
            } catch (_: Throwable) {
            }
        }
    }

    private fun post(context: Context, event: String) {
        val base = ApiConfig.resolve(context)
        if (base.isBlank()) return

        var conn: HttpURLConnection? = null
        try {
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val payload = JSONObject().apply {
                put("registration_id", prefs.getString("registration_id", "").orEmpty())
                put("install_id", DeviceInfo.installId(context))
                put("android_id", DeviceInfo.androidId(context))
                put("event", event)
                put("app_version", DeviceInfo.versionName(context))
                put("device_name", DeviceInfo.summary(context))
                put("platform", "android")
                put("theme", BuildConfig.THEME)
                put("ts", System.currentTimeMillis())
            }
            conn = URL("$base/devices/event").openConnection() as HttpURLConnection
            conn.requestMethod = "POST"
            conn.connectTimeout = 10_000
            conn.readTimeout = 10_000
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/json; charset=UTF-8")
            conn.outputStream.use { it.write(payload.toString().toByteArray(Charsets.UTF_8)) }
            conn.responseCode
        } catch (_: Throwable) {
        } finally {
            conn?.disconnect()
        }
    }
}