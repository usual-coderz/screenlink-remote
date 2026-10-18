package com.screenlink.remote

import android.app.Activity
import android.os.Bundle
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.widget.*
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

class MainActivity : Activity() {

    private val serverUrl =
        "https://rat-panel-b91839a4be83.herokuapp.com"

    private val executor = Executors.newSingleThreadExecutor()

    private lateinit var statusText: TextView
    private lateinit var resultText: TextView
    private lateinit var deviceNameInput: EditText
    private lateinit var pairButton: Button

    private val bg = Color.rgb(12, 17, 32)
    private val card = Color.rgb(23, 30, 49)
    private val green = Color.rgb(70, 220, 150)
    private val white = Color.WHITE
    private val muted = Color.rgb(160, 171, 192)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        buildUI()
        checkServer()
    }

    private fun buildUI() {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(24, 36, 24, 24)
            setBackgroundColor(bg)
        }

        val scroll = ScrollView(this)
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
        }

        content.addView(label("ScreenLink", 30f, green, true))
        content.addView(label("REMOTE SUPPORT", 12f, muted, true))

        val heading = label("Connect your device", 24f, white, true)
        heading.setPadding(0, 32, 0, 8)
        content.addView(heading)

        content.addView(
            label(
                "Connect to your ScreenLink server and create a temporary pairing code.",
                15f,
                muted
            )
        )

        val statusCard = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(18, 18, 18, 18)
            background = rounded(card, 18)
        }

        statusCard.addView(
            label("SERVER STATUS", 12f, muted, true)
        )

        statusText = label("Checking server...", 18f, white, true)
        statusText.setPadding(0, 10, 0, 0)
        statusCard.addView(statusText)

        val statusParams = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply {
            topMargin = 24
        }

        content.addView(statusCard, statusParams)

        val inputTitle = label("Device name", 14f, white, true)
        inputTitle.setPadding(0, 24, 0, 8)
        content.addView(inputTitle)

        deviceNameInput = EditText(this).apply {
            hint = "e.g. My Android"
            setHintTextColor(muted)
            setTextColor(white)
            textSize = 16f
            setSingleLine(true)
            setPadding(16, 12, 16, 12)
            background = rounded(card, 14)
        }

        content.addView(
            deviceNameInput,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                56
            )
        )

        pairButton = Button(this).apply {
            text = "Create Pairing Code"
            isAllCaps = false
            textSize = 16f
            setTextColor(bg)
            background = rounded(green, 14)
            setOnClickListener {
                createPairingCode()
            }
        }

        val pairParams = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            56
        ).apply {
            topMargin = 18
        }

        content.addView(pairButton, pairParams)

        resultText = label("", 16f, green, true).apply {
            gravity = Gravity.CENTER
            setPadding(0, 24, 0, 8)
        }

        content.addView(resultText)

        val note = label(
            "Pairing codes are temporary. This prototype creates a code but does not yet establish a live screen-sharing session.",
            13f,
            muted
        )
        note.setPadding(0, 16, 0, 16)
        content.addView(note)

        scroll.addView(content)

        root.addView(
            scroll,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                0,
                1f
            )
        )

        setContentView(root)
    }

    private fun checkServer() {
        statusText.text = "Checking server..."

        executor.execute {
            val result = request(
                path = "/health",
                method = "GET"
            )

            runOnUiThread {
                statusText.text = if (result != null) {
                    "● Server online"
                } else {
                    "● Server unavailable"
                }

                statusText.setTextColor(
                    if (result != null) green else Color.RED
                )
            }
        }
    }

    private fun createPairingCode() {
        val name = deviceNameInput.text.toString().trim()

        if (name.isEmpty()) {
            deviceNameInput.error = "Enter a device name"
            return
        }

        pairButton.isEnabled = false
        pairButton.text = "Creating..."
        resultText.text = ""

        executor.execute {
            val body = JSONObject().apply {
                put("device_name", name)
            }

            val response = request(
                path = "/pair",
                method = "POST",
                body = body.toString()
            )

            runOnUiThread {
                pairButton.isEnabled = true
                pairButton.text = "Create Pairing Code"

                if (response != null) {
                    try {
                        val json = JSONObject(response)
                        val code = json.getString("pair_code")
                        val expiry = json.optInt(
                            "expires_in_seconds",
                            300
                        )

                        resultText.text =
                            "Pairing code:\n$code\n\nExpires in $expiry seconds"
                    } catch (_: Exception) {
                        resultText.text = "Invalid server response"
                    }
                } else {
                    resultText.text =
                        "Could not create pairing code. Try again."
                }
            }
        }
    }

    private fun request(
        path: String,
        method: String,
        body: String? = null
    ): String? {
        var connection: HttpURLConnection? = null

        return try {
            connection = URL("$serverUrl$path")
                .openConnection() as HttpURLConnection

            connection.requestMethod = method
            connection.connectTimeout = 15000
            connection.readTimeout = 15000
            connection.setRequestProperty(
                "Accept",
                "application/json"
            )

            if (body != null) {
                connection.doOutput = true
                connection.setRequestProperty(
                    "Content-Type",
                    "application/json"
                )

                connection.outputStream.use {
                    it.write(body.toByteArray(Charsets.UTF_8))
                }
            }

            val stream = if (connection.responseCode in 200..299) {
                connection.inputStream
            } else {
                connection.errorStream
            }

            stream?.bufferedReader()?.use {
                it.readText()
            }
        } catch (_: Exception) {
            null
        } finally {
            connection?.disconnect()
        }
    }

    private fun label(
        text: String,
        size: Float,
        color: Int,
        bold: Boolean = false
    ): TextView {
        return TextView(this).apply {
            this.text = text
            textSize = size
            setTextColor(color)

            if (bold) {
                typeface = Typeface.DEFAULT_BOLD
            }
        }
    }

    private fun rounded(
        color: Int,
        radius: Int
    ): GradientDrawable {
        return GradientDrawable().apply {
            setColor(color)
            cornerRadius = radius.toFloat()
        }
    }

    override fun onDestroy() {
        executor.shutdownNow()
        super.onDestroy()
    }
}