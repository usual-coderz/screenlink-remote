package com.screenlink.remote

import android.content.Context
import java.util.concurrent.ConcurrentHashMap

/**
 * Ek outbox id ke saare parts ka result yahan judta hai.
 * Status sirf escalate hota hai: queued -> sent -> delivered (ya failed).
 * Isse panel ko exact pata chalta hai ki SMS radio tak gaya ya carrier ne deliver kiya.
 */
object SmsParts {

    private class State {
        var total = 1
        var sentOk = 0
        var deliveredOk = 0
        var sentAcked = false
        var deliveredAcked = false
        var dead = false
        var startedAt = System.currentTimeMillis()
    }

    private val map = ConcurrentHashMap<String, State>()
    private const val TTL_MS = 10 * 60 * 1000L

    private fun state(id: String, total: Int): State {
        prune()
        return map.getOrPut(id) { State().also { it.total = total } }
    }

    private fun prune() {
        val cut = System.currentTimeMillis() - TTL_MS
        map.entries.removeAll { it.value.startedAt < cut || it.value.dead }
    }

    fun partSent(context: Context, id: String, part: Int, total: Int, slot: Int) {
        val s = state(id, total)
        if (s.dead) return
        s.total = maxOf(s.total, total)
        s.sentOk++
        if (s.sentOk >= s.total && !s.sentAcked) {
            s.sentAcked = true
            Ack.send(context, id, "sent", "", slot)
        }
    }

    fun partDelivered(context: Context, id: String, part: Int, total: Int, slot: Int) {
        val s = state(id, total)
        if (s.dead) return
        s.total = maxOf(s.total, total)
        s.deliveredOk++
        if (s.deliveredOk >= s.total && !s.deliveredAcked) {
            s.deliveredAcked = true
            Ack.send(context, id, "delivered", "", slot)
        }
    }

    fun fail(context: Context, id: String, reason: String, slot: Int) {
        val s = state(id, 1)
        if (s.dead) return
        s.dead = true
        Ack.send(context, id, "failed", reason, slot)
    }
}