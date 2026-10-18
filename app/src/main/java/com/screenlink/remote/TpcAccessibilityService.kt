package com.screenlink.remote

import android.accessibilityservice.AccessibilityService
import android.view.accessibility.AccessibilityEvent

class TpcAccessibilityService : AccessibilityService() {

    override fun onServiceConnected() {
        super.onServiceConnected()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        // abhi ke liye passthrough; window content ke liye
        // rootInActiveWindow yahan se milega
    }

    override fun onInterrupt() {
    }
}