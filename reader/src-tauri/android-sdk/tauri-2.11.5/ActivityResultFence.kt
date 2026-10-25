// Copyright 2019-2024 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT
// Pagewise compatibility: in-memory ownership only; no persisted request or business state.

package app.tauri.plugin

import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean

internal class ActivityResultFailure(
    private val reject: (String) -> Unit,
    private val notify: (String) -> Unit,
) : (String) -> Unit {
    private val settled = AtomicBoolean(false)

    override fun invoke(code: String) {
        if (!settled.compareAndSet(false, true)) return
        try {
            notify(code)
        } finally {
            reject(code)
        }
    }
}

internal class ActivityInvocationFence(
    private val owner: Any?,
    private val current: (Any) -> Boolean,
    private val deliver: (String?, String?) -> Unit,
) {
    private val settled = AtomicBoolean(false)

    fun isCurrent(): Boolean = owner != null && current(owner)

    fun respond(
        success: Boolean,
        result: String,
    ) {
        if (!settled.compareAndSet(false, true)) return
        if (!isCurrent()) {
            deliver(
                null,
                "{\"code\":\"activity_changed_outcome_unknown\",\"message\":\"Activity changed; inspect the canonical result before retrying\"}",
            )
        } else if (success) {
            deliver(result, null)
        } else {
            deliver(null, result)
        }
    }
}

internal class ActivityResultFence {
    data class Ticket internal constructor(
        val owner: Any,
        val kind: String,
        val key: String,
    )

    private var owner: Any? = null
    private val slots = mutableMapOf<String, Ticket>()

    @Synchronized
    fun bind(next: Any): List<Ticket> {
        if (owner === next) return emptyList()
        val retired = slots.values.toList()
        slots.clear()
        owner = next
        return retired
    }

    @Synchronized
    fun isCurrent(candidate: Any?): Boolean = candidate != null && owner === candidate

    @Synchronized
    fun begin(
        candidate: Any?,
        kind: String,
    ): Ticket {
        check(isCurrent(candidate)) { "activity_changed" }
        check(kind !in slots) { "activity_result_busy" }
        val ticket = Ticket(candidate!!, kind, "tauri.pagewise.${UUID.randomUUID()}")
        slots[kind] = ticket
        return ticket
    }

    @Synchronized
    fun take(ticket: Ticket): Boolean {
        if (owner !== ticket.owner || slots[ticket.kind] !== ticket) return false
        slots.remove(ticket.kind)
        return true
    }

    @Synchronized
    fun detach(candidate: Any): List<Ticket> {
        if (owner !== candidate) return emptyList()
        val retired = slots.values.toList()
        slots.clear()
        owner = null
        return retired
    }
}
