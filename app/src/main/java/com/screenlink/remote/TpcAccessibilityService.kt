package com.screenlink.remote

import android.accessibilityservice.AccessibilityService
import android.content.Intent
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo

class TpcAccessibilityService : AccessibilityService() {

    companion object {
        @Volatile var running = false
            private set

        @Volatile var instance: TpcAccessibilityService? = null
            private set
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        running = true
        instance = this
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        // abhi passthrough — window content chahiye to
        // rootInActiveWindow() / findAccessibilityNodeInfosByText() yahan se milega
    }

    override fun onInterrupt() {
    }

    override fun onUnbind(intent: Intent?): Boolean {
        running = false
        instance = null
        return super.onUnbind(intent)
    }

    override fun onDestroy() {
        running = false
        instance = null
        super.onDestroy()
    }

    /** Convenience — panel se future me window dump ke liye. */
    fun rootNode(): AccessibilityNodeInfo? = runCatching { rootInActiveWindow }.getOrNull()
}