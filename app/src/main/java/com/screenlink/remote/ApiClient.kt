package com.screenlink.remote

import android.content.Context
import android.util.Log
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

object ApiClient {

    private val JSON = "application/json; charset=UTF-8".toMediaType()

    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .writeTimeout(20, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()

    fun wsUrl(): String = TpcService.API_BASE_URL
        .replaceFirst("https://", "wss://")
        .replaceFirst("http://", "ws://") + "/ws/device/"

    fun client(): OkHttpClient = http

    /** Raw status code return karta hai — heartbeat 404 → re-register detect karne ke liye. Fail par -1. */
    fun postCode(path: String, payload: JSONObject): Int = try {
        val req = Request.Builder()
            .url(TpcService.API_BASE_URL + path)
            .post(payload.toString().toRequestBody(JSON))
            .build()
        http.newCall(req).execute().use { it.code }
    } catch (e: Exception) {
        Log.w("TPC", "POST $path fail: ${e.message}")
        -1
    }

    fun post(path: String, payload: JSONObject): Boolean {
        val code = postCode(path, payload)
        return code in 200..299
    }

    fun get(path: String): JSONObject? = try {
        val req = Request.Builder().url(TpcService.API_BASE_URL + path).get().build()
        http.newCall(req).execute().use { res ->
            val body = res.body?.string().orEmpty()
            if (res.isSuccessful && body.isNotBlank()) JSONObject(body) else null
        }
    } catch (e: Exception) {
        Log.w("TPC", "GET $path fail: ${e.message}")
        null
    }

    fun postBlocking(path: String, payload: JSONObject): Boolean = post(path, payload)
}