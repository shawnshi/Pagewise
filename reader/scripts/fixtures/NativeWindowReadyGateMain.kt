package io.pagewise.reader

import java.util.ArrayDeque

private class HostScheduler : NativeWindowReadyGate.Scheduler {
    class Job(
        val task: () -> Unit,
    ) : NativeWindowReadyGate.Cancel {
        var cancelled = false
        var ran = false

        override fun cancel() {
            cancelled = true
        }

        fun invoke() {
            if (!cancelled) {
                ran = true
                task()
            }
        }
    }

    val checks = ArrayDeque<Job>()
    val deadlines = mutableListOf<Pair<Long, Job>>()

    override fun afterUiSettled(task: () -> Unit): NativeWindowReadyGate.Cancel = Job(task).also { checks.add(it) }

    override fun deadline(
        delayMs: Long,
        task: () -> Unit,
    ): NativeWindowReadyGate.Cancel = Job(task).also { deadlines.add(delayMs to it) }

    fun settle() {
        var steps = 0
        while (checks.isNotEmpty()) {
            check(++steps <= 32) { "Readiness is polling instead of waiting for lifecycle events" }
            checks.removeFirst().invoke()
        }
    }

    fun expire() {
        deadlines.toList().forEach { it.second.invoke() }
    }

    fun activeChecks() = checks.count { !it.cancelled && !it.ran }

    fun activeDeadlines() = deadlines.count { !it.second.cancelled && !it.second.ran }
}

private class HostWindow(
    val name: String,
    var focused: Boolean = false,
    var attached: Boolean = true,
    var laidOut: Boolean = true,
) {
    val listeners = linkedSetOf<() -> Unit>()

    fun signal() {
        listeners.toList().forEach { it() }
    }
}

private class HostRig(
    initial: HostWindow?,
) {
    val scheduler = HostScheduler()
    var current = initial
    val known = mutableSetOf<HostWindow>().apply { initial?.let { add(it) } }
    val ready = mutableListOf<String>()
    val errors = mutableListOf<Throwable>()
    var picks = 0
    var lookupFailure: Exception? = null
    var observerFailure: Exception? = null
    val gate =
        NativeWindowReadyGate(
            scheduler = scheduler,
            currentWindow = {
                picks++
                lookupFailure?.let { throw it }
                current
            },
            isReady = { it.focused && it.attached && it.laidOut },
            observe = { window, changed ->
                observerFailure?.let { throw it }
                known.add(window)
                check(window.listeners.add(changed))
                NativeWindowReadyGate.Cancel { window.listeners.remove(changed) }
            },
            onReady = { ready.add(it.name) },
            onFailure = { errors.add(it) },
        )

    fun clean() {
        check(known.all { it.listeners.isEmpty() }) { "Observer leaked" }
        check(scheduler.activeChecks() == 0 && scheduler.activeDeadlines() == 0) { "Pending task leaked" }
    }
}

fun main() {
    var passed = 0

    fun scenario(
        name: String,
        body: () -> Unit,
    ) {
        body()
        passed++
        println("PASS $name")
    }
    scenario("late-dismiss-ownership") {
        val root = HostWindow("activity", false)
        val parent = HostWindow("retained-input", true)
        val rig = HostRig(root)
        rig.gate.start()
        check(rig.picks == 0) { "Window was captured before queued dismiss restoration" }
        rig.current = parent // Deferred production onDismiss has restored ownership before the UI-settled callback.
        rig.scheduler.settle()
        check(rig.ready == listOf("retained-input") && rig.errors.isEmpty())
        rig.clean()
    }
    scenario("replace-before-focus-delivery") {
        val old = HostWindow("old")
        val parent = HostWindow("parent", true)
        val rig = HostRig(old)
        rig.gate.start()
        rig.scheduler.settle()
        old.focused = true
        old.signal()
        rig.current = parent
        rig.scheduler.settle()
        check(rig.ready == listOf("parent") && old.listeners.isEmpty())
        rig.clean()
    }
    scenario("detach-retargets-current-window") {
        val old = HostWindow("removed")
        val parent = HostWindow("parent", true)
        val rig = HostRig(old)
        rig.gate.start()
        rig.scheduler.settle()
        old.attached = false
        rig.current = parent
        old.signal()
        rig.scheduler.settle()
        check(rig.ready == listOf("parent") && rig.errors.isEmpty())
        rig.clean()
    }
    scenario("lost-focus-is-rechecked") {
        val window = HostWindow("window")
        val rig = HostRig(window)
        rig.gate.start()
        rig.scheduler.settle()
        window.focused = true
        window.signal()
        window.focused = false
        rig.scheduler.settle()
        check(rig.ready.isEmpty() && rig.errors.isEmpty())
        window.focused = true
        window.signal()
        rig.scheduler.settle()
        check(rig.ready == listOf("window"))
        rig.clean()
    }
    scenario("layout-readiness-needs-live-signal") {
        val window = HostWindow("layout", true, laidOut = false)
        val rig = HostRig(window)
        rig.gate.start()
        rig.scheduler.settle()
        check(rig.ready.isEmpty() && rig.scheduler.activeChecks() == 0)
        window.laidOut = true
        window.signal()
        rig.scheduler.settle()
        check(rig.ready == listOf("layout"))
        rig.clean()
    }
    scenario("permanent-no-focus-fails-once") {
        val window = HostWindow("unfocused")
        val rig = HostRig(window)
        rig.gate.start()
        rig.scheduler.settle()
        rig.scheduler.expire()
        check(rig.ready.isEmpty() && rig.errors.single() is AssertionError)
        check(rig.errors.single().message == "Active Android window did not gain focus")
        window.focused = true
        window.signal()
        rig.scheduler.deadlines
            .single()
            .second
            .task()
        rig.scheduler.settle()
        check(rig.errors.size == 1 && rig.ready.isEmpty())
        rig.clean()
    }
    scenario("window-changes-do-not-renew-deadline") {
        val first = HostWindow("first")
        val second = HostWindow("second")
        val rig = HostRig(first)
        rig.gate.start()
        rig.scheduler.settle()
        rig.current = second
        first.attached = false
        first.signal()
        rig.scheduler.settle()
        check(
            rig.scheduler.deadlines.size == 1 && rig.scheduler.deadlines
                .single()
                .first == 8000L,
        )
        rig.scheduler.expire()
        check(rig.errors.size == 1 && rig.ready.isEmpty())
        rig.clean()
    }
    scenario("cancel-before-first-sample") {
        val rig = HostRig(HostWindow("ready", true))
        rig.gate.start()
        rig.gate.cancel()
        rig.scheduler.settle()
        rig.scheduler.expire()
        check(rig.picks == 0 && rig.ready.isEmpty() && rig.errors.isEmpty())
        rig.clean()
    }
    scenario("cancel-wait-removes-observers") {
        val window = HostWindow("waiting")
        val rig = HostRig(window)
        rig.gate.start()
        rig.scheduler.settle()
        rig.gate.cancel()
        window.focused = true
        window.signal()
        rig.scheduler.settle()
        rig.scheduler.expire()
        check(rig.ready.isEmpty() && rig.errors.isEmpty())
        rig.clean()
    }
    scenario("coalesce-signals-without-polling") {
        val window = HostWindow("window")
        val rig = HostRig(window)
        rig.gate.start()
        rig.scheduler.settle()
        repeat(20) { window.signal() }
        check(rig.scheduler.activeChecks() == 1)
        rig.scheduler.settle()
        check(rig.scheduler.activeChecks() == 0 && window.listeners.size == 1)
        rig.gate.cancel()
        rig.clean()
    }
    scenario("late-callbacks-cannot-complete-twice") {
        val window = HostWindow("ready", true)
        val rig = HostRig(window)
        rig.gate.start()
        val staleSample = rig.scheduler.checks.first.task
        rig.scheduler.settle()
        staleSample()
        rig.scheduler.deadlines
            .single()
            .second
            .task()
        window.signal()
        check(rig.ready == listOf("ready") && rig.errors.isEmpty())
        rig.clean()
    }
    scenario("lookup-error-is-explicit") {
        val rig = HostRig(HostWindow("window"))
        val error = IllegalStateException("owner unavailable")
        rig.lookupFailure = error
        rig.gate.start()
        rig.scheduler.settle()
        check(rig.errors.single() === error && rig.ready.isEmpty())
        rig.clean()
    }
    scenario("subscription-error-is-explicit") {
        val rig = HostRig(HostWindow("window"))
        val error = IllegalStateException("observer unavailable")
        rig.observerFailure = error
        rig.gate.start()
        rig.scheduler.settle()
        check(rig.errors.single() === error && rig.ready.isEmpty())
        rig.clean()
    }
    scenario("consumer-failure-is-not-swallowed") {
        val scheduler = HostScheduler()
        val window = HostWindow("ready", true)
        val expected = IllegalArgumentException("consumer assertion")
        var errors = 0
        val gate =
            NativeWindowReadyGate(
                scheduler,
                { window },
                { true },
                { _, _ -> NativeWindowReadyGate.Cancel {} },
                { throw expected },
                { errors++ },
            )
        gate.start()
        val actual = runCatching { scheduler.settle() }.exceptionOrNull()
        check(actual === expected && errors == 0)
        check(scheduler.activeChecks() == 0 && scheduler.activeDeadlines() == 0)
    }
    scenario("null-window-is-not-success") {
        val rig = HostRig(null)
        rig.gate.start()
        rig.scheduler.settle()
        check(rig.ready.isEmpty() && rig.errors.isEmpty())
        rig.scheduler.expire()
        check(rig.errors.size == 1)
        rig.clean()
    }
    scenario("invalid-budget-and-duplicate-start-rejected") {
        val rig = HostRig(HostWindow("window"))
        rig.gate.start()
        check(runCatching { rig.gate.start() }.exceptionOrNull() is IllegalStateException)
        check(rig.scheduler.deadlines.size == 1)
        rig.gate.cancel()
        rig.clean()
        check(
            runCatching {
                NativeWindowReadyGate<HostWindow>(
                    HostScheduler(),
                    { null },
                    { true },
                    { _, _ -> NativeWindowReadyGate.Cancel {} },
                    {},
                    {},
                    0,
                )
            }.exceptionOrNull() is IllegalArgumentException,
        )
    }
    println("NATIVE_WINDOW_GATE_HOST_PASS cases=$passed")
}
