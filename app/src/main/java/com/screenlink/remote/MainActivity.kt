
import android.app.Activity
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.graphics.Color
import android.graphics.Typeface
import android.view.Gravity
import android.view.ViewGroup
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
    private val baseUrl = "https://rat-panel-b91839a4be83.herokuapp.com"
    private val executor = Executors.newSingleThreadExecutor()
    private val handler = Handler(Looper.getMainLooper())
    private lateinit var statusText: TextView
    private lateinit var deviceNameText: TextView
    private lateinit var connectButton: Button
    private var registrationId = ""
    private var registered = false

    private val heartbeatTask = object : Runnable {
        override fun run() {
            if (registered) sendHeartbeat()
            handler.postDelayed(this, 30_000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        registrationId = getRegistrationId()
        buildInterface()
        registerDevice()
    }

    private fun buildInterface() {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(28, 36, 28, 28)
            setBackgroundColor(Color.rgb(13, 17, 28))
        }
        val scroll = ScrollView(this)
        scroll.addView(root)

        root.addView(TextView(this).apply {
            text = "ScreenLink Remote"
            textSize = 27f
            setTextColor(Color.WHITE)
            typeface = Typeface.DEFAULT_BOLD
        })
        root.addView(TextView(this).apply {
            text = "Device support connection"
            textSize = 15f
            setTextColor(Color.LTGRAY)
            setPadding(0, 8, 0, 22)
        })
        deviceNameText = TextView(this).apply {
            text = "Device: ${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL}"
            textSize = 14f
            setTextColor(Color.LTGRAY)
            setPadding(0, 0, 0, 20)
        }
        root.addView(deviceNameText)
        statusText = TextView(this).apply {
            text = "Connecting to server..."
            textSize = 15f
            setTextColor(Color.YELLOW)
            setPadding(0, 8, 0, 20)
        }
        root.addView(statusText)
        connectButton = Button(this).apply {
            text = "Retry connection"
            isAllCaps = false
            setOnClickListener { registerDevice() }
        }
        root.addView(connectButton, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ))
        root.addView(TextView(this).apply {
            text = "When this app connects, its device name and random installation ID are sent to ScreenLink for display in the administrator dashboard. Screen sharing does not start automatically. Starting a support session must require a separate Android system screen-capture prompt and the device user's approval."
            textSize = 13f
            setTextColor(Color.LTGRAY)
            setPadding(0, 24, 0, 0)
        })
        setContentView(scroll)
    }

    private fun getRegistrationId(): String {
        val prefs = getSharedPreferences("screenlink_preferences", MODE_PRIVATE)
        val existing = prefs.getString("registration_id", null)
        if (!existing.isNullOrBlank()) return existing
        val generated = UUID.randomUUID().toString() + UUID.randomUUID().toString()
        prefs.edit().putString("registration_id", generated).apply()
        return generated
    }

    private fun registerDevice() {
        connectButton.isEnabled = false
        statusText.text = "Registering device..."
        statusText.setTextColor(Color.YELLOW)
        val name = "${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL}".take(40)
        executor.execute {
            val body = JSONObject().apply {
                put("device_name", name)
                put("platform", "android")
                put("registration_id", registrationId)
                put("owner_approved", true)
            }
            val result = request("POST", "/devices/register", body)
            runOnUiThread {
                connectButton.isEnabled = true
                if (result.first in 200..299) {
                    registered = true
                    statusText.text = "Device registered\nConnection: Online"
                    statusText.setTextColor(Color.GREEN)
                    handler.removeCallbacks(heartbeatTask)
                    handler.post(heartbeatTask)
                } else {
                    registered = false
                    statusText.text = "Connection failed (${result.first})\n${result.second}"
                    statusText.setTextColor(Color.RED)
                }
            }
        }
    }

    private fun sendHeartbeat() {
        executor.execute {
            val body = JSONObject().put("registration_id", registrationId)
            val result = request("POST", "/devices/heartbeat", body)
            runOnUiThread {
                if (result.first in 200..299) {
                    statusText.text = "Device registered\nConnection: Online"
                    statusText.setTextColor(Color.GREEN)
                } else {
                    registered = false
                    statusText.text = "Connection: Offline\nTap retry to reconnect."
                    statusText.setTextColor(Color.RED)
                }
            }
        }
    }

    private fun request(method: String, path: String, body: JSONObject? = null): Pair<Int, String> {
        var connection: HttpURLConnection? = null
        return try {
            connection = (URL("$baseUrl$path").openConnection() as HttpURLConnection).apply {
                requestMethod = method
                connectTimeout = 15000
                readTimeout = 15000
                setRequestProperty("Accept", "application/json")
            }
            if (body != null) {
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json; charset=UTF-8")
                connection.outputStream.use {
                    it.write(body.toString().toByteArray(Charsets.UTF_8))
                }
            }
            val code = connection.responseCode
            val stream = if (code in 200..299) connection.inputStream else connection.errorStream
            val response = stream?.bufferedReader()?.use { it.readText() } ?: ""
            Pair(code, response)
        } catch (e: Exception) {
            Pair(-1, e.message ?: "Unable to connect to server")
        } finally {
            connection?.disconnect()
        }
    }

    override fun onResume() {
        super.onResume()
        if (registered) sendHeartbeat()
    }

    override fun onDestroy() {
        handler.removeCallbacks(heartbeatTask)
        executor.shutdownNow()
        super.onDestroy()
    }
}
