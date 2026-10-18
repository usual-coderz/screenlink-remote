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

    private val cache = ConcurrentHashMap<String, Bitmap>()
    private val pool = Executors.newFixedThreadPool(3)
    private val main = Handler(Looper.getMainLooper())

    fun load(url: String, view: ImageView) {
        cache[url]?.let { view.setImageBitmap(it); return }
        pool.execute {
            val bmp = runCatching {
                val c = URL(url).openConnection() as HttpURLConnection
                c.connectTimeout = 10_000
                c.readTimeout = 10_000
                c.inputStream.use { BitmapFactory.decodeStream(it) }
            }.getOrNull() ?: return@execute

            cache[url] = bmp
            main.post { view.setImageBitmap(bmp) }
        }
    }
}