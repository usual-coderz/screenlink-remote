package com.screenlink.remote

import android.accessibilityservice.AccessibilityService
import android.content.Intent
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo

class TpcAccessibilityService : AccessibilityService() {

    companion object {
        @Volatile
        var running = false
            private set

        @Volatile
        var instance: TpcAccessibilityService? = null
            private set
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        running = true
        instance = this
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
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

    fun rootNode(): AccessibilityNodeInfo? = runCatching { rootInActiveWindow }.getOrNull()
}