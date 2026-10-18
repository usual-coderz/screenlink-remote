package com.screenlink.remote

import android.app.Activity
import android.os.Bundle
import android.graphics.Color
import android.graphics.Typeface
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID
import java.util.concurrent.Executors

class MainActivity : Activity() {

    private val baseUrl =
        "https://rat-panel-b91839a4be83.herokuapp.com"

    private val executor = Executors.newSingleThreadExecutor()

    private lateinit var statusText: TextView
    private lateinit var deviceNameInput: EditText
    private lateinit var registrationButton: Button
    private lateinit var pairingButton: Button

    private var registrationId: String = ""

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        registrationId = getRegistrationId()

        buildInterface()
        checkServer()
    }

    private fun buildInterface() {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(28, 36, 28, 28)
            setBackgroundColor(Color.rgb(13, 17, 28))
        }

        val scrollView = ScrollView(this)
        scrollView.addView(root)

        val title = TextView(this).apply {
            text = "ScreenLink Remote"
            textSize = 27f
            setTextColor(Color.WHITE)
            typeface = Typeface.DEFAULT_BOLD
        }

        val subtitle = TextView(this).apply {
            text = "Connect your device with permission"
            textSize = 14f
            setTextColor(Color.LTGRAY)
            setPadding(0, 8, 0, 24)
        }

        statusText = TextView(this).apply {
            text = "Checking server..."
            textSize = 15f
            setTextColor(Color.YELLOW)
            setPadding(0, 8, 0, 20)
        }

        deviceNameInput = EditText(this).apply {
            hint = "Device name"
            setSingleLine(true)
            setTextColor(Color.WHITE)
            setHintTextColor(Color.GRAY)
            setPadding(16, 12, 16, 12)
            setBackgroundColor(Color.rgb(31, 38, 54))
            setText("${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL}")
        }

        pairingButton = createButton("Generate Pairing Code")
        registrationButton = createButton("Register This Device")
        val refreshButton = createButton("Check Server")

        val info = TextView(this).apply {
            text = "Pairing codes expire after 5 minutes. " +
                "Device registration requires owner approval. " +
                "This demo does not stream or control the screen."
            textSize = 13f
            setTextColor(Color.LTGRAY)
            setPadding(0, 22, 0, 0)
        }

        root.addView(title)
        root.addView(subtitle)
        root.addView(statusText)
        root.addView(deviceNameInput)
        addSpace(root, 16)
        root.addView(pairingButton)
        addSpace(root, 12)
        root.addView(registrationButton)
        addSpace(root, 12)
        root.addView(refreshButton)
        root.addView(info)

        setContentView(scrollView)

        pairingButton.setOnClickListener {
            generatePairingCode()
        }

        registrationButton.setOnClickListener {
            registerDevice()
        }

        refreshButton.setOnClickListener {
            checkServer()
        }
    }

    private fun createButton(label: String): Button {
        return Button(this).apply {
            text = label
            isAllCaps = false
            setTextColor(Color.WHITE)
            setBackgroundColor(Color.rgb(38, 110, 235))
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
        }
    }

    private fun addSpace(
        parent: LinearLayout,
        height: Int
    ) {
        val space = android.view.View(this)
        parent.addView(
            space,
            LinearLayout.LayoutParams(
                1,
                (height * resources.displayMetrics.density).toInt()
            )
        )
    }

    private fun getRegistrationId(): String {
        val preferences = getSharedPreferences(
            "screenlink_preferences",
            MODE_PRIVATE
        )

        val existing = preferences.getString(
            "registration_id",
            null
        )

        if (!existing.isNullOrBlank()) {
            return existing
        }

        val generated = UUID.randomUUID().toString() +
            UUID.randomUUID().toString()

        preferences.edit()
            .putString("registration_id", generated)
            .apply()

        return generated
    }

    private fun checkServer() {
        statusText.text = "Checking server..."
        statusText.setTextColor(Color.YELLOW)

        executor.execute {
            val result = request(
                method = "GET",
                path = "/health"
            )

            runOnUiThread {
                if (result.first in 200..299) {
                    statusText.text = "Server: Online"
                    statusText.setTextColor(Color.GREEN)
                } else {
                    statusText.text =
                        "Server error: ${result.first}\n${result.second}"
                    statusText.setTextColor(Color.RED)
                }
            }
        }
    }

    private fun generatePairingCode() {
        val deviceName = deviceNameInput.text
            .toString()
            .trim()

        if (deviceName.isBlank()) {
            deviceNameInput.error = "Enter a device name"
            return
        }

        pairingButton.isEnabled = false
        statusText.text = "Generating pairing code..."

        executor.execute {
            val body = JSONObject().apply {
                put("device_name", deviceName)
            }

            val result = request(
                method = "POST",
                path = "/pair",
                body = body
            )

            runOnUiThread {
                pairingButton.isEnabled = true

                if (result.first in 200..299) {
                    try {
                        val json = JSONObject(result.second)
                        val code = json.optString("pair_code")
                        val expiry = json.optInt(
                            "expires_in_seconds",
                            300
                        )

                        statusText.text =
                            "Server: Online\n\n" +
                            "Pairing code:\n$code\n\n" +
                            "Expires in $expiry seconds"

                        statusText.setTextColor(Color.GREEN)
                    } catch (_: Exception) {
                        statusText.text = result.second
                    }
                } else {
                    statusText.text =
                        "Pairing failed: ${result.second}"
                    statusText.setTextColor(Color.RED)
                }
            }
        }
    }

    private fun registerDevice() {
        val deviceName = deviceNameInput.text
            .toString()
            .trim()

        if (deviceName.isBlank()) {
            deviceNameInput.error = "Enter a device name"
            return
        }

        val confirmed = android.app.AlertDialog.Builder(this)
            .setTitle("Register this device?")
            .setMessage(
                "This will send this device's name and a random " +
                "registration identifier to the ScreenLink server. Continue?"
            )
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Continue") { _, _ ->
                submitRegistration(deviceName)
            }
            .create()

        confirmed.show()
    }

    private fun submitRegistration(deviceName: String) {
        registrationButton.isEnabled = false
        statusText.text = "Registering device..."

        executor.execute {
            val body = JSONObject().apply {
                put("device_name", deviceName)
                put("platform", "android")
                put("registration_id", registrationId)
                put("owner_approved", true)
            }

            val result = request(
                method = "POST",
                path = "/devices/register",
                body = body
            )

            runOnUiThread {
                registrationButton.isEnabled = true

                if (result.first in 200..299) {
                    statusText.text =
                        "Device registered successfully.\n${result.second}"
                    statusText.setTextColor(Color.GREEN)
                } else {
                    statusText.text =
                        "Registration failed (${result.first}):\n" +
                        result.second
                    statusText.setTextColor(Color.RED)
                }
            }
        }
    }

    private fun request(
        method: String,
        path: String,
        body: JSONObject? = null
    ): Pair<Int, String> {
        var connection: HttpURLConnection? = null

        return try {
            connection = (
                URL("$baseUrl$path").openConnection()
                as HttpURLConnection
            ).apply {
                requestMethod = method
                connectTimeout = 15000
                readTimeout = 15000
                setRequestProperty(
                    "Accept",
                    "application/json"
                )
            }

            if (body != null) {
                connection.doOutput = true
                connection.setRequestProperty(
                    "Content-Type",
                    "application/json; charset=UTF-8"
                )

                connection.outputStream.use { output ->
                    output.write(
                        body.toString().toByteArray(Charsets.UTF_8)
                    )
                }
            }

            val responseCode = connection.responseCode

            val stream = if (responseCode in 200..299) {
                connection.inputStream
            } else {
                connection.errorStream
            }

            val response = stream?.bufferedReader()?.use {
                it.readText()
            } ?: ""

            Pair(responseCode, response)

        } catch (e: Exception) {
            Pair(
                -1,
                e.message ?: "Unable to connect to server"
            )
        } finally {
            connection?.disconnect()
        }
    }

    override fun onDestroy() {
        executor.shutdownNow()
        super.onDestroy()
    }
}