package io.pagewise.reader

/** Test-only, single-UI-thread readiness gate. No Android or persistence owner is replaced. */
internal class NativeWindowReadyGate<W : Any>(
    private val scheduler: Scheduler,
    private val currentWindow: () -> W?,
    private val isReady: (W) -> Boolean,
    private val observe: (W, () -> Unit) -> Cancel,
    private val onReady: (W) -> Unit,
    private val onFailure: (Throwable) -> Unit,
    private val timeoutMs: Long = 8000,
) {
    fun interface Cancel {
        fun cancel()
    }

    interface Scheduler {
        /** Asynchronous: drain prior UI callbacks, then settle layout frames, before invoking task. */
        fun afterUiSettled(task: () -> Unit): Cancel

        fun deadline(
            delayMs: Long,
            task: () -> Unit,
        ): Cancel
    }

    private enum class State { NEW, WAITING, FINISHED }

    private var state = State.NEW
    private var samplePending = false
    private var sampleTask: Cancel? = null
    private var timeoutTask: Cancel? = null
    private var watched: W? = null
    private var subscription: Cancel? = null

    init {
        require(timeoutMs > 0)
    }

    fun start() {
        check(state == State.NEW)
        state = State.WAITING
        timeoutTask =
            scheduler.deadline(timeoutMs) {
                if (state == State.WAITING) fail(AssertionError("Active Android window did not gain focus"))
            }
        requestSample()
    }

    fun cancel() {
        if (state != State.FINISHED) finish()
    }

    private fun requestSample() {
        if (state != State.WAITING || samplePending) return
        samplePending = true
        sampleTask =
            scheduler.afterUiSettled {
                samplePending = false
                sampleTask = null
                if (state == State.WAITING) sample()
            }
    }

    private fun sample() {
        // Resolve ownership here, never before the deferred dismiss callback or frame boundary.
        val target: W?
        val ready: Boolean
        try {
            target = currentWindow()
            if (target !== watched) {
                subscription?.cancel()
                subscription = null
                watched = target
                if (target != null) subscription = observe(target, ::requestSample)
            }
            ready = target != null && isReady(target)
        } catch (error: Exception) {
            fail(error)
            return
        }
        if (ready) {
            finish()
            onReady(target)
        }
    }

    private fun fail(error: Throwable) {
        if (state != State.WAITING) return
        finish()
        onFailure(error)
    }

    private fun finish() {
        state = State.FINISHED
        sampleTask?.cancel()
        sampleTask = null
        samplePending = false
        timeoutTask?.cancel()
        timeoutTask = null
        subscription?.cancel()
        subscription = null
        watched = null
    }
}
