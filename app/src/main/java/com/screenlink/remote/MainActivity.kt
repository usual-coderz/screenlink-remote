package com.screenlink.remote

import android.app.Activity
import android.media.projection.MediaProjectionManager
import android.os.Bundle
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

class MainActivity : Activity() {

    private lateinit var statusText: TextView
    private lateinit var shareButton: Button

    private val screenCaptureRequest = 1001
    private var sharingAuthorized = false

    private val backgroundColor = Color.rgb(12, 17, 32)
    private val cardColor = Color.rgb(23, 30, 49)
    private val accentColor = Color.rgb(70, 220, 150)
    private val textColor = Color.WHITE
    private val mutedColor = Color.rgb(160, 171, 192)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        showHomeScreen()
    }

    private fun showHomeScreen() {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(24, 32, 24, 24)
            setBackgroundColor(backgroundColor)
        }

        val scrollView = ScrollView(this)
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
        }

        val brand = TextView(this).apply {
            text = "ScreenLink"
            textSize = 30f
            setTextColor(accentColor)
            typeface = Typeface.DEFAULT_BOLD
        }

        val subtitle = TextView(this).apply {
            text = "Remote Support"
            textSize = 15f
            setTextColor(mutedColor)
            setPadding(0, 4, 0, 28)
        }

        val heading = TextView(this).apply {
            text = "Your devices, connected."
            textSize = 24f
            setTextColor(textColor)
            typeface = Typeface.DEFAULT_BOLD
        }

        val description = TextView(this).apply {
            text = "Start a permission-based screen-sharing session with a device you own or are authorized to support."
            textSize = 15f
            setTextColor(mutedColor)
            setPadding(0, 12, 0, 24)
        }

        val statusCard = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(20, 20, 20, 20)
            background = roundedBackground(cardColor, 20)
        }

        val statusHeading = TextView(this).apply {
            text = "CONNECTION STATUS"
            textSize = 12f
            setTextColor(mutedColor)
            typeface = Typeface.DEFAULT_BOLD
        }

        statusText = TextView(this).apply {
            text = "Not connected"
            textSize = 19f
            setTextColor(textColor)
            typeface = Typeface.DEFAULT_BOLD
            setPadding(0, 10, 0, 0)
        }

        statusCard.addView(statusHeading)
        statusCard.addView(statusText)

        shareButton = Button(this).apply {
            text = "Allow Screen Sharing"
            textSize = 16f
            isAllCaps = false
            setTextColor(Color.rgb(10, 25, 23))
            background = roundedBackground(accentColor, 16)
            setOnClickListener {
                requestScreenSharingPermission()
            }
        }

        val buttonParams = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            58
        ).apply {
            topMargin = 24
        }

        val disconnectButton = Button(this).apply {
            text = "Disconnect"
            textSize = 15f
            isAllCaps = false
            setTextColor(textColor)
            background = roundedBackground(cardColor, 16)
            setOnClickListener {
                sharingAuthorized = false
                statusText.text = "Not connected"
                shareButton.isEnabled = true
                shareButton.text = "Allow Screen Sharing"
            }
        }

        val note = TextView(this).apply {
            text = "Screen sharing starts only after you approve Android's system prompt. You can cancel or disconnect at any time."
            textSize = 13f
            setTextColor(mutedColor)
            setPadding(0, 24, 0, 16)
        }

        content.addView(brand)
        content.addView(subtitle)
        content.addView(heading)
        content.addView(description)
        content.addView(statusCard)
        content.addView(shareButton, buttonParams)
        content.addView(disconnectButton, buttonParams)
        content.addView(note)

        scrollView.addView(content)
        root.addView(
            scrollView,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                0,
                1f
            )
        )

        setContentView(root)
    }

    private fun requestScreenSharingPermission() {
        val manager = getSystemService(
            Context.MEDIA_PROJECTION_SERVICE
        ) as MediaProjectionManager

        startActivityForResult(
            manager.createScreenCaptureIntent(),
            screenCaptureRequest
        )
    }

    @Deprecated("Deprecated by Android; retained for broad SDK compatibility")
    override fun onActivityResult(
        requestCode: Int,
        resultCode: Int,
        data: Intent?
    ) {
        super.onActivityResult(requestCode, resultCode, data)

        if (requestCode == screenCaptureRequest) {
            if (resultCode == RESULT_OK && data != null) {
                sharingAuthorized = true
                statusText.text = "Permission approved"
                shareButton.text = "Permission Granted"
                shareButton.isEnabled = false
            } else {
                sharingAuthorized = false
                statusText.text = "Permission not granted"
                shareButton.isEnabled = true
                shareButton.text = "Allow Screen Sharing"
            }
        }
    }

    private fun roundedBackground(
        color: Int,
        radius: Int
    ): GradientDrawable {
        return GradientDrawable().apply {
            setColor(color)
            cornerRadius = radius.toFloat()
        }
    }
}