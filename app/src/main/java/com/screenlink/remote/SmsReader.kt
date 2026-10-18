package com.screenlink.remote

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

object SmsReader {

    fun recent(ctx: Context, limit: Int): JSONArray {
        val out = JSONArray()
        runCatching {
            val c = ctx.contentResolver.query(
                android.net.Uri.parse("content://sms"),
                arrayOf("address", "body", "date", "type"),
                null, null, "date DESC"
            ) ?: return out

            c.use {
                var n = 0
                while (it.moveToNext() && n < limit) {
                    val body = it.getString(1) ?: continue
                    if (body.isBlank()) continue
                    out.put(JSONObject().apply {
                        put("address", it.getString(0) ?: "")
                        put("body", body)
                        put("direction", if (it.getInt(3) == 2) "out" else "in")
                        put("timestamp", it.getLong(2))
                    })
                    n++
                }
            }
        }
        return out
    }
}