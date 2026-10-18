package com.screenlink.remote

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Handler
import android.os.Looper
import android.widget.ImageView
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

object ImageLoader {

    private val pool = Executors.newFixedThreadPool(3)
    private val main = Handler(Looper.getMainLooper())
    private val cache = ConcurrentHashMap<String, Bitmap>()

    fun load(url: String, into: ImageView) {
        cache[url]?.let { into.setImageBitmap(it); return }

        into.tag = url
        pool.execute {
            val bmp = runCatching {
                val conn = URL(url).openConnection() as HttpURLConnection
                conn.connectTimeout = 10_000
                conn.readTimeout = 10_000
                conn.inputStream.use { BitmapFactory.decodeStream(it) }
            }.getOrNull() ?: return@execute

            cache[url] = bmp
            main.post { if (into.tag == url) into.setImageBitmap(bmp) }
        }
    }
}