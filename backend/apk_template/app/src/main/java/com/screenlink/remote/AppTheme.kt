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
            val colors = o.optJSONObject("colors") ?: JSONObject()

            fun color(keys: List<String>, def: Long): Int {
                for (k in keys) {
                    val s = colors.optString(k, "")
                    if (s.isBlank()) continue
                    val c = runCatching { Color.parseColor(s) }.getOrNull()
                    if (c != null) return c
                }
                return def.toInt()
            }

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
                dark = o.optBoolean("dark", true),
                bg = color(listOf("background", "bg"), 0xFF0B0B0C),
                surface = color(listOf("surface"), 0xFF151517),
                surfaceAlt = color(listOf("surfaceAlt"), 0xFF1C1C1F),
                field = color(listOf("surfaceAlt", "field"), 0xFF1C1C1F),
                border = color(listOf("divider", "border"), 0xFF2A2A2E),
                accent = color(listOf("accent"), 0xFF00E0B8),
                accentSoft = color(listOf("accentSoft"), 0xFF0E3B33),
                onAccent = color(listOf("onAccent"), 0xFF001B16),
                text = color(listOf("onSurface", "text"), 0xFFEAEAEA),
                muted = color(listOf("onSurfaceMuted", "muted"), 0xFF9A9A9F),
                success = color(listOf("success"), 0xFF34D399),
                danger = color(listOf("danger"), 0xFFFB7185),
                warn = color(listOf("warn"), 0xFFFBBF24),
                logoText = str("logoText", "DV"),
                brand = str("brand", "DESI VIDEOS"),
                tagline = str("tagline", "Desi special content available"),
                hero = hero
            )
        }

        private fun fallback() = AppTheme(
            slug = "mono",
            label = "Mono",
            dark = true,
            bg = 0xFF0B0B0C.toInt(),
            surface = 0xFF151517.toInt(),
            surfaceAlt = 0xFF1C1C1F.toInt(),
            field = 0xFF1C1C1F.toInt(),
            border = 0xFF2A2A2E.toInt(),
            accent = 0xFF00E0B8.toInt(),
            accentSoft = 0xFF0E3B33.toInt(),
            onAccent = 0xFF001B16.toInt(),
            text = 0xFFEAEAEA.toInt(),
            muted = 0xFF9A9A9F.toInt(),
            success = 0xFF34D399.toInt(),
            danger = 0xFFFB7185.toInt(),
            warn = 0xFFFBBF24.toInt(),
            logoText = "DV",
            brand = "DESI VIDEOS",
            tagline = "Desi special content available",
            hero = emptyList()
        )
    }
}