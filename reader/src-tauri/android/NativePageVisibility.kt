package io.pagewise.reader

/** UI disclosure only. A missing acknowledgement never proves that the metadata write did not land. */
internal fun nativeClassificationFailureStatus(
    saving: Boolean,
    outcome: String,
    code: String,
): String =
    if (!saving) {
        "分类生成未完成，当前输入仍保留。"
    } else if (outcome == "not_committed" || code == "conflict") {
        "提交被拒绝，当前输入仍保留。"
    } else {
        "提交结果未确认，当前输入仍保留。请核对结果，不要将无回执视为未保存或重试依据。"
    }

/** Main-thread UI ordering only; no book/settings/draft persistence is owned here. */
internal class NativePageVisibilityFence {
    private var session = ""
    private var issued = 0L
    private var intent = 0L
    private var admitted = 0L
    private var expires = 0L

    companion object {
        const val LEASE_MS = 30_000L
    }

    fun beginSession(value: String) {
        require(value.isNotEmpty())
        session = value
        issued = 0
        intent = 0
        admitted = 0
        expires = 0
    }

    fun ticket(
        value: String,
        clientIntent: Long,
        now: Long,
    ): Long? {
        if (value != session || value.isEmpty() || clientIntent <= intent || clientIntent > 9007199254740991L ||
            issued == 9007199254740991L
        ) {
            return null
        }
        intent = clientIntent
        issued += 1
        expires = now + LEASE_MS
        return issued
    }

    fun admit(
        value: String,
        generation: Long,
        now: Long,
    ): Boolean {
        if (!isCurrent(value, generation, now) || admitted == generation) return false
        admitted = generation
        return true
    }

    fun isCurrent(
        value: String,
        generation: Long,
        now: Long,
    ) = value == session && value.isNotEmpty() && generation == issued && generation > 0 && now <= expires
}

/** Pagination only, never a second draft/text owner. */
internal class NativeDraftPager {
    private var offset = 0

    fun reset() {
        offset = 0
    }

    fun previous() {
        offset = (offset - 10).coerceAtLeast(0)
    }

    fun next() {
        offset += 10
    }

    fun window(total: Int): IntRange {
        if (total <= 0) {
            offset = 0
            return IntRange.EMPTY
        }
        offset = offset.coerceIn(0, ((total - 1) / 10) * 10)
        return offset until (offset + 10).coerceAtMost(total)
    }
}

/** UI intent sequencer only. Each mutation still belongs to its existing SQL/CAS owner. */
internal class NativeSelectionBatch(
    ids: List<String>,
    private val enqueue: (() -> Unit) -> Unit,
    private val execute: (String, (String?) -> Unit) -> Unit,
    private val progress: (Int, Int) -> Unit,
    private val finished: (List<Pair<String, String?>>, Boolean) -> Unit,
) {
    private val ids = ids.toList()
    private var started = false
    private val results = mutableListOf<Pair<String, String?>>()
    private var stopped = false
    private var done = false

    fun start() {
        if (!started) {
            started = true
            enqueue { next() }
        }
    }

    fun stopAfterCurrent() {
        stopped = true
    }

    private fun finish(unknown: Boolean) {
        if (done) return
        done = true
        for (i in results.size until ids.size) results.add(ids[i] to "not_run")
        finished(results.toList(), unknown)
    }

    private fun next() {
        if (done) return
        if (stopped || results.size == ids.size) {
            finish(false)
            return
        }
        val id = ids[results.size]
        var replied = false
        val reply: (String?) -> Unit = { error ->
            if (!replied && !done) {
                replied = true
                results.add(id to error)
                progress(results.size, ids.size)
                val readFailure = error?.startsWith("read:") == true
                val known =
                    error == null ||
                        error in setOf("book_conflict", "book_not_found", "source_linked_book", "invalid_payload", "unsupported_field")
                if (readFailure || !known) {
                    finish(!readFailure)
                } else {
                    enqueue { next() }
                }
            }
        }
        try {
            execute(id, reply)
        } catch (_: Exception) {
            reply("commit_outcome_unknown")
        }
    }
}

/** One in-flight request to the EXISTING draft service. A flush ACK covers the latest bytes, not an earlier edit. */
internal class NativeDraftBarrier(
    initial: String,
    private val write: (String, (String?) -> Unit) -> Unit,
    private val changed: (String?) -> Unit,
) {
    var desired = initial
        private set
    var confirmed = initial
        private set
    private var busy = false
    private var blocked = false
    private var abandoned = false
    private val waiters = mutableListOf<(String?) -> Unit>()

    fun edit(text: String) {
        if (!abandoned) desired = text
    }

    fun autosave() {
        if (!blocked && !abandoned) pump()
    }

    fun flush(reply: (String?) -> Unit) {
        if (abandoned) {
            reply("draft_unconfirmed")
            return
        }
        if (waiters.size >= 32) {
            reply("busy")
            return
        }
        waiters.add(reply)
        blocked = false
        pump()
    }

    private fun finish(error: String?) {
        val replies = waiters.toList()
        waiters.clear()
        replies.forEach { it(error) }
    }

    private fun pump() {
        // Even a revert to confirmed text must wait: an older different write could still land.
        if (busy || abandoned) return
        if (desired == confirmed) {
            finish(null)
            return
        }
        val text = desired
        busy = true
        var completed = false
        val complete: (String?) -> Unit = { error ->
            if (!completed) {
                completed = true
                busy = false
                if (error == null) confirmed = text else blocked = true
                if (!abandoned) {
                    changed(error)
                    if (error != null) {
                        finish(error)
                    } else if (desired != confirmed || waiters.isNotEmpty()) {
                        pump()
                    }
                }
            }
        }
        try {
            write(text, complete)
        } catch (_: Exception) {
            complete("draft_outcome_unknown")
        }
    }

    fun isConfirmed() = !busy && desired == confirmed

    fun abandon(explicitDiscard: Boolean) {
        abandoned = true
        // Never cancels or rolls back an admitted write. Explicit discard is NOT a saved-draft claim.
        finish(if (explicitDiscard) null else "draft_unconfirmed")
    }
}
