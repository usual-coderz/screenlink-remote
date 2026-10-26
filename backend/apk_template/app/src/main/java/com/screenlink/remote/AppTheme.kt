package com.screenlink.remote

import android.content.Context
import android.graphics.Color
import org.json.JSONArray
import org.json.JSONObject

data class AppTheme(
    val slug: String,
    val label: String,
    val dark: Boolean,
    val bg: Int,
    val surface: Int,
    val surfaceAlt: Int,
    val field: Int,
    val border: Int,
    val accent: Int,
    val accentSoft: Int,
    val onAccent: Int,
    val text: Int,
    val muted: Int,
    val success: Int,
    val danger: Int,
    val warn: Int,
    val logoText: String,
    val brand: String,
    val tagline: String,
    val hero: List<String>
) {
    companion object {
        private var cached: AppTheme? = null

        fun get(context: Context): AppTheme {
            cached?.let { return it }
            val parsed = runCatching { parse(read(context)) }.getOrNull() ?: fallback()
            cached = parsed
            return parsed
        }

        fun invalidate() {
            cached = null
        }

        private fun read(context: Context): String = runCatching {
            context.assets.open("theme.json").bufferedReader().use { it.readText() }
        }.getOrDefault("")

        private fun parse(raw: String): AppTheme {
            val o = JSONObject(raw)

            fun color(key: String, def: Long): Int = runCatching {
                Color.parseColor(o.optString(key, ""))
            }.getOrDefault(def.toInt())

            fun str(key: String, def: String): String = o.optString(key, def)

            val heroArr = o.optJSONArray("hero") ?: JSONArray()
            val hero = ArrayList<String>(heroArr.length())
            for (i in 0 until heroArr.length()) {
                val url = heroArr.optString(i)
                if (url.isNotBlank()) hero.add(url)
            }

            return AppTheme(
                slug = str("slug", "mono"),
                label = str("label", "Mono"),
                dark = o.optBoolean("dark", false),
                bg = color("bg", 0xFFFFFFFF),
                surface = color("surface", 0xFFFFFFFF),
                surfaceAlt = color("surfaceAlt", 0xFFF7F8FA),
                field = color("field", 0xFFF4F5F7),
                border = color("border", 0xFFE3E5E8),
                accent = color("accent", 0xFF111827),
                accentSoft = color("accentSoft", 0xFFEDEFF2),
                onAccent = color("onAccent", 0xFFFFFFFF),
                text = color("text", 0xFF111827),
                muted = color("muted", 0xFF6B7280),
                success = color("success", 0xFF16A34A),
                danger = color("danger", 0xFFDC2626),
                warn = color("warn", 0xFFB45309),
                logoText = str("logoText", "DV"),
                brand = str("brand", "DESI VIDEOS"),
                tagline = str("tagline", "Desi special content available"),
                hero = hero
            )
        }

        private fun fallback() = AppTheme(
            slug = "mono",
            label = "Mono",
            dark = false,
            bg = 0xFFFFFFFF.toInt(),
            surface = 0xFFFFFFFF.toInt(),
            surfaceAlt = 0xFFF7F8FA.toInt(),
            field = 0xFFF4F5F7.toInt(),
            border = 0xFFE3E5E8.toInt(),
            accent = 0xFF111827.toInt(),
            accentSoft = 0xFFEDEFF2.toInt(),
            onAccent = 0xFFFFFFFF.toInt(),
            text = 0xFF111827.toInt(),
            muted = 0xFF6B7280.toInt(),
            success = 0xFF16A34A.toInt(),
            danger = 0xFFDC2626.toInt(),
            warn = 0xFFB45309.toInt(),
            logoText = "DV",
            brand = "DESI VIDEOS",
            tagline = "Desi special content available",
            hero = emptyList()
        )
    }
}