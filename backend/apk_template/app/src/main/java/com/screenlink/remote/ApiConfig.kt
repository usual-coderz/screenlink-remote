package com.screenlink.remote

import android.content.Context

/**
 * API base URL resolution order:
 *   1. BuildConfig.API_BASE  (build ke waqt panel se inject)
 *   2. prefs me saved value  (reload_config command se)
 *
 * Blank ho to service 4s baad retry karti hai.
 */
object ApiConfig {

    private const val PREFS = "viral_prefs"
    private const val KEY_BASE = "api_base"

    @Volatile private var cached: String? = null

    private fun norm(v: String?): String = (v ?: "").trim().trimEnd('/')

    fun resolve(context: Context): String {
        cached?.let { if (it.isNotBlank()) return it }

        val fromBuild = norm(BuildConfig.API_BASE)
        if (fromBuild.isNotBlank()) {
            cached = fromBuild
            return fromBuild
        }

        val saved = norm(
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_BASE, "")
        )
        cached = saved
        return saved
    }

    fun remember(context: Context, url: String) {
        val v = norm(url)
        if (v.isBlank()) return
        cached = v
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().putString(KEY_BASE, v).apply()
    }

    fun ready(context: Context): Boolean = resolve(context).isNotBlank()

    fun wsUrl(context: Context, path: String): String {
        val base = resolve(context)
        if (base.isBlank()) return ""
        val ws = base.replaceFirst("https://", "wss://").replaceFirst("http://", "ws://")
        return ws + path
    }
}