backend/apk_templete/app/src/main/java/com/screenlink/remote/ImageLoader.kt


package com.screenlink.remote

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Handler
import android.os.Looper
import android.util.LruCache
import android.widget.ImageView
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

object ImageLoader {

    private const val MAX_CACHE_KB = 24 * 1024
    private const val TARGET_PX = 720

    private val pool = Executors.newFixedThreadPool(3) { r ->
        Thread(r, "img-load").apply { isDaemon = true }
    }
    private val main = Handler(Looper.getMainLooper())

    private val cache = object : LruCache<String, Bitmap>(MAX_CACHE_KB) {
        override fun sizeOf(key: String, value: Bitmap): Int = value.byteCount / 1024
    }

    fun load(url: String, into: ImageView) {
        if (url.isBlank()) return

        cache.get(url)?.let {
            into.setImageBitmap(it)
            return
        }

        into.tag = url
        pool.execute {
            val bmp = runCatching { download(url) }.getOrNull() ?: return@execute
            cache.put(url, bmp)
            main.post {
                if (into.tag == url) into.setImageBitmap(bmp)
            }
        }
    }

    private fun download(url: String): Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        openStream(url)?.use { BitmapFactory.decodeStream(it, null, bounds) }

        val opts = BitmapFactory.Options().apply {
            inSampleSize = sampleSize(bounds.outWidth, bounds.outHeight, TARGET_PX)
            inPreferredConfig = Bitmap.Config.RGB_565
        }
        return openStream(url)?.use { BitmapFactory.decodeStream(it, null, opts) }
    }

    private fun openStream(url: String) = try {
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.connectTimeout = 10_000
        conn.readTimeout = 10_000
        conn.instanceFollowRedirects = true
        conn.inputStream
    } catch (_: Throwable) {
        null
    }

    private fun sampleSize(w: Int, h: Int, target: Int): Int {
        if (w <= 0 || h <= 0) return 1
        var size = 1
        while (w / size > target * 2 || h / size > target * 2) size *= 2
        return size
    }

    fun clear() {
        cache.evictAll()
    }
}