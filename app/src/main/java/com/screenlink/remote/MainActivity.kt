package com.screenlink.remote

import android.app.Activity
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.graphics.Color
import android.graphics.Typeface
import android.view.Gravity
import android.view.View
import android.widget.Button
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
        private const val API_BASE_URL =
            "https://rat-panel-b91839a4be83.herokuapp.com"

        private const val PREFS_NAME = "screenlink_preferences"
        private const val KEY_REGISTRATION_ID = "registration_id"
        private const val HEARTBEAT_INTERVAL = 30_000L
    }

    private val executor = Executors.newSingleThreadExecutor()
    private val handler = Handler(Looper.getMainLooper())

    private lateinit var statusText: TextView
    private lateinit var deviceIdText: TextView
    private lateinit var registerButton: Button

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
        registerDevice()
    }

    override fun onResume() {
        super.onResume()

        isActivityVisible = true
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
            text = "Device Registration"
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

        val information = TextView(this).apply {
            text = "This app registers this device with the ScreenLink server. " +
                "The registration ID and device name are sent to the server. " +
                "Registration does not start screen sharing or remote control."
            textSize = 14f
            setTextColor(secondaryTextColor)
            setLineSpacing(dp(4).toFloat(), 1f)
        }

        registerButton = Button(this).apply {
            text = "Retry Registration"
            setTextColor(Color.BLACK)
            setBackgroundColor(accentColor)
            setOnClickListener {
                registerDevice()
            }
        }

        card.addView(statusHeading)
        card.addView(statusText)
        card.addView(deviceHeading)
        card.addView(deviceIdText)
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

    private fun getRegistrationId(): String {
        val preferences = getSharedPreferences(
            PREFS_NAME,
            MODE_PRIVATE
        )

        val existingId = preferences.getString(
            KEY_REGISTRATION_ID,
            null
        )

        if (!existingId.isNullOrBlank()) {
            return existingId
        }

        val newId = UUID.randomUUID().toString()

        preferences.edit()
            .putString(KEY_REGISTRATION_ID, newId)
            .apply()

        return newId
    }

    private fun registerDevice() {
        if (isRequestRunning) return

        isRequestRunning = true
        updateStatus("Registering device...", Color.YELLOW)
        registerButton.isEnabled = false

        val registrationId = getRegistrationId()

        executor.execute {
            var connection: HttpURLConnection? = null

            try {
                val endpoint = URL("$API_BASE_URL/devices/register")

                connection = endpoint.openConnection() as HttpURLConnection
                connection.requestMethod = "POST"
                connection.connectTimeout = 15_000
                connection.readTimeout = 15_000
                connection.doOutput = true
                connection.setRequestProperty(
                    "Content-Type",
                    "application/json; charset=UTF-8"
                )
                connection.setRequestProperty(
                    "Accept",
                    "application/json"
                )

                val requestBody = JSONObject().apply {
                    put(
                        "device_name",
                        "${android.os.Build.MANUFACTURER} " +
                            android.os.Build.MODEL
                    )
                    put("platform", "android")
                    put("registration_id", registrationId)
                    put("owner_approved", true)
                }.toString()

                connection.outputStream.use { output ->
                    output.write(requestBody.toByteArray(Charsets.UTF_8))
                }

                val responseCode = connection.responseCode

                val responseStream = if (responseCode in 200..299) {
                    connection.inputStream
                } else {
                    connection.errorStream
                }

                val responseBody = responseStream
                    ?.bufferedReader()
                    ?.use { it.readText() }
                    .orEmpty()

                if (responseCode in 200..299) {
                    runOnUiThread {
                        updateStatus(
                            "Device registered",
                            Color.rgb(75, 222, 151)
                        )
                        deviceIdText.text = registrationId
                    }
                } else {
                    val message = try {
                        JSONObject(responseBody).optString(
                            "detail",
                            "HTTP $responseCode"
                        )
                    } catch (_: Exception) {
                        "HTTP $responseCode"
                    }

                    runOnUiThread {
                        updateStatus(
                            "Registration failed: $message",
                            Color.rgb(255, 100, 100)
                        )
                    }
                }
            } catch (exception: Exception) {
                runOnUiThread {
                    updateStatus(
                        "Connection failed. Check internet and retry.",
                        Color.rgb(255, 100, 100)
                    )
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

        executor.execute {
            var connection: HttpURLConnection? = null

            try {
                connection = URL(
                    "$API_BASE_URL/devices/heartbeat"
                ).openConnection() as HttpURLConnection

                connection.requestMethod = "POST"
                connection.connectTimeout = 10_000
                connection.readTimeout = 10_000
                connection.doOutput = true

                connection.setRequestProperty(
                    "Content-Type",
                    "application/json; charset=UTF-8"
                )

                val body = JSONObject().apply {
                    put("registration_id", registrationId)
                }.toString()

                connection.outputStream.use { output ->
                    output.write(body.toByteArray(Charsets.UTF_8))
                }

                val responseCode = connection.responseCode

                if (responseCode == HttpURLConnection.HTTP_NOT_FOUND) {
                    runOnUiThread {
                        updateStatus(
                            "Device not registered. Please retry.",
                            Color.rgb(255, 100, 100)
                        )
                    }
                }
            } catch (_: Exception) {
                // A temporary heartbeat failure does not stop the app.
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

    private fun dp(value: Int): Int {
        return (value * resources.displayMetrics.density).toInt()
    }
}