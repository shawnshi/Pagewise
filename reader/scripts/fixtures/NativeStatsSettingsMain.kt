package io.pagewise.reader

import android.app.Activity
import android.app.AlertDialog
import android.app.Instrumentation
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Rect
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.RadioButton
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.ArrayDeque

class NativeStatsSettingsInstrumentation : Instrumentation() {
    companion object {
        var active: NativeStatsSettingsInstrumentation? = null
    }

    private var arguments = Bundle()

    override fun onCreate(arguments: Bundle?) {
        this.arguments = arguments ?: Bundle()
        active = this
        start()
    }

    override fun onStart() {
        startActivitySync(
            Intent(targetContext, NativeStatsSettingsActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK).putExtras(arguments),
        )
    }

    fun complete(report: JSONObject) {
        finish(
            if (report.getBoolean("passed")) Activity.RESULT_OK else Activity.RESULT_CANCELED,
            Bundle().apply {
                putString("statsSettingsResult", report.toString())
            },
        )
    }
}

class NativeStatsSettingsActivity : Activity() {
    private val main = Handler(Looper.getMainLooper())
    private val cases = ArrayDeque<Pair<String, () -> Unit>>()
    private val results = JSONArray()
    private val requests = mutableListOf<Pair<String, JSONObject>>()
    private lateinit var controller: NativePagesController
    private lateinit var prefs: JSONObject
    private lateinit var schema: JSONObject
    private lateinit var snapshots: JSONObject
    private var pending: NativePageReply? = null
    private var holdWrite = false
    private var casesStarted = false
    private var readiness: NativeWindowReadyGate<View>? = null
    private var dayDialog: AlertDialog? = null
    private var boolRule = JSONObject()
    private var english = false
    private var profile = ""

    private fun tr(
        zh: String,
        en: String,
    ) = if (english) en else zh

    private fun walk(root: View): Sequence<View> =
        sequence {
            yield(root)
            if (root is ViewGroup) for (i in 0 until root.childCount) yieldAll(walk(root.getChildAt(i)))
        }

    private fun field(
        owner: Any,
        name: String,
    ): Any? =
        owner.javaClass
            .getDeclaredField(name)
            .apply { isAccessible = true }
            .get(owner)

    private fun root(): View = field(controller, "overlay") as View

    private fun stats() = field(controller, "statsPanel") as NativeStatsPanel

    private fun settings() = field(controller, "settingsPanel") as NativeSettingsPanel

    private fun statsDialog() = field(stats(), "dialog") as AlertDialog

    private fun settingsDialog() = field(settings(), "dialog") as AlertDialog

    private fun button(
        root: View,
        value: String,
        prefix: Boolean = false,
    ): Button =
        walk(root).filterIsInstance<Button>().first {
            it.isShown &&
                (if (prefix) it.text.toString().startsWith(value) else it.text.toString() == value)
        }

    private fun input(dialog: AlertDialog) =
        walk(dialog.window!!.decorView).filterIsInstance<EditText>().first {
            it.visibility ==
                View.VISIBLE
        }

    private fun content(dialog: AlertDialog) = dialog.window!!.decorView

    private fun count(action: String) = requests.count { it.first == action }

    private fun assertThat(
        value: Boolean,
        message: String,
    ) {
        if (!value) throw AssertionError(message)
    }

    private fun tap(view: View) {
        assertThat(view.isAttachedToWindow && view.isEnabled && view.isShown, "Target unavailable: ${(view as? TextView)?.text}")
        view.requestRectangleOnScreen(Rect(0, 0, view.width, view.height), true)
        val visible = Rect()
        assertThat(view.getGlobalVisibleRect(visible), "Target off screen")
        val live = (field(controller, "statsPanel") as? NativeStatsPanel)?.let { field(it, "dialog") as? AlertDialog }
        val detail =
            live?.let {
                "showing=${it.isShowing};focused=${it.window?.decorView?.hasWindowFocus()};texts=" +
                    walk(content(it)).filterIsInstance<TextView>().map { t -> t.text.toString() }.toList()
            }
        assertThat(view.rootView.hasWindowFocus(), "Target window lacks focus; statsDialog=$detail")
        val at = IntArray(2)
        view.rootView.getLocationOnScreen(at)
        val position = IntArray(2)
        view.getLocationOnScreen(position)
        val x = position[0] + view.width / 2f - at[0]
        val y = position[1] + view.height / 2f - at[1]
        val now = android.os.SystemClock.uptimeMillis()
        for (action in listOf(MotionEvent.ACTION_DOWN, MotionEvent.ACTION_UP)) {
            val event = MotionEvent.obtain(now, now + if (action == MotionEvent.ACTION_UP) 30 else 0, action, x, y, 0)
            view.rootView.dispatchTouchEvent(event)
            event.recycle()
        }
    }

    private fun checkFooter(
        dialog: AlertDialog,
        vararg ids: Int,
    ) {
        val decor = content(dialog)
        val viewport = Rect()
        decor.getWindowVisibleDisplayFrame(viewport)
        for (id in ids) {
            val target = dialog.getButton(id)
            val rect = Rect()
            assertThat(target != null && target.isAttachedToWindow && target.getGlobalVisibleRect(rect), "Footer not attached: $id")
            assertThat(
                rect.width() / resources.displayMetrics.density >= 48f && rect.height() / resources.displayMetrics.density >= 48f,
                "Footer target below 48dp: $rect",
            )
            val position = IntArray(2)
            target!!.getLocationOnScreen(position)
            rect.set(position[0], position[1], position[0] + target.width, position[1] + target.height)
            assertThat(
                rect.left >= viewport.left && rect.right <= viewport.right && rect.top >= viewport.top && rect.bottom <= viewport.bottom,
                "Footer outside visible window: $rect / $viewport",
            )
            val layout = target!!.layout
            assertThat(
                layout != null && target.height >= layout.height + target.compoundPaddingTop + target.compoundPaddingBottom,
                "Footer text clipped: ${target.text}",
            )
        }
    }

    private fun capture(
        view: View,
        name: String,
    ) {
        assertThat(view.isAttachedToWindow && view.width > 0 && view.height > 0, "Capture not attached")
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        view.draw(Canvas(bitmap))
        File(getExternalFilesDir(null), "$profile-$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }

    private fun add(
        name: String,
        run: () -> Unit,
    ) {
        cases.add(name to run)
    }

    private fun currentTestWindow(): View {
        val settingsWindow = (field(controller, "settingsPanel") as? NativeSettingsPanel)?.let { field(it, "dialog") as? AlertDialog }
        val statsWindow = (field(controller, "statsPanel") as? NativeStatsPanel)?.let { field(it, "dialog") as? AlertDialog }
        return when {
            settingsWindow?.isShowing == true -> content(settingsWindow)
            statsWindow?.isShowing == true -> content(statsWindow)
            else -> root().rootView
        }
    }

    private val readyScheduler =
        object : NativeWindowReadyGate.Scheduler {
            override fun afterUiSettled(task: () -> Unit): NativeWindowReadyGate.Cancel {
                val queue = Looper.getMainLooper().queue
                val frames = android.view.Choreographer.getInstance()
                var cancelled = false
                val second = android.view.Choreographer.FrameCallback { if (!cancelled) task() }
                val first = android.view.Choreographer.FrameCallback { if (!cancelled) frames.postFrameCallback(second) }
                val idle =
                    android.os.MessageQueue.IdleHandler {
                        if (!cancelled) frames.postFrameCallback(first)
                        false
                    }
                val register = Runnable { if (!cancelled) queue.addIdleHandler(idle) }
                main.post(register)
                return NativeWindowReadyGate.Cancel {
                    cancelled = true
                    main.removeCallbacks(register)
                    queue.removeIdleHandler(idle)
                    frames.removeFrameCallback(first)
                    frames.removeFrameCallback(second)
                }
            }

            override fun deadline(
                delayMs: Long,
                task: () -> Unit,
            ): NativeWindowReadyGate.Cancel {
                val timeout = Runnable { task() }
                main.postDelayed(timeout, delayMs)
                return NativeWindowReadyGate.Cancel { main.removeCallbacks(timeout) }
            }
        }

    private fun observeTestWindow(
        window: View,
        changed: () -> Unit,
    ): NativeWindowReadyGate.Cancel {
        val observer = window.viewTreeObserver
        val focus = android.view.ViewTreeObserver.OnWindowFocusChangeListener { changed() }
        val layout = android.view.ViewTreeObserver.OnGlobalLayoutListener { changed() }
        val attachment =
            object : View.OnAttachStateChangeListener {
                override fun onViewAttachedToWindow(view: View) = changed()

                override fun onViewDetachedFromWindow(view: View) = changed()
            }
        observer.addOnWindowFocusChangeListener(focus)
        observer.addOnGlobalLayoutListener(layout)
        window.addOnAttachStateChangeListener(attachment)
        return NativeWindowReadyGate.Cancel {
            fun remove(from: android.view.ViewTreeObserver) {
                if (from.isAlive) {
                    from.removeOnWindowFocusChangeListener(focus)
                    from.removeOnGlobalLayoutListener(layout)
                }
            }
            remove(observer)
            val current = window.viewTreeObserver
            if (current !== observer) remove(current)
            window.removeOnAttachStateChangeListener(attachment)
        }
    }

    private fun step() {
        readiness?.cancel()
        readiness = null
        if (cases.isEmpty()) {
            complete()
            return
        }
        val (name, run) = cases.removeFirst()

        fun failure(error: Throwable) {
            results.put(
                JSONObject()
                    .put("name", name)
                    .put("passed", false)
                    .put("type", error.javaClass.simpleName)
                    .put("message", error.message),
            )
            complete()
        }
        val gate =
            NativeWindowReadyGate(
                scheduler = readyScheduler,
                currentWindow = ::currentTestWindow,
                isReady = { it.isAttachedToWindow && it.isLaidOut && !it.isLayoutRequested && it.hasWindowFocus() },
                observe = ::observeTestWindow,
                onReady = {
                    readiness = null
                    try {
                        run()
                        results.put(JSONObject().put("name", name).put("passed", true))
                        step()
                    } catch (error: Throwable) {
                        failure(error)
                    }
                },
                onFailure = { error ->
                    readiness = null
                    failure(error)
                },
            )
        readiness = gate
        gate.start()
    }

    override fun onDestroy() {
        readiness?.cancel()
        readiness = null
        super.onDestroy()
    }

    private fun complete() {
        readiness?.cancel()
        readiness = null
        val failed = (0 until results.length()).count { !results.getJSONObject(it).getBoolean("passed") }
        if (failed != 0) capture(root(), "failure")
        val report =
            JSONObject()
                .put("profile", profile)
                .put("passed", failed == 0 && cases.isEmpty())
                .put("failed", failed)
                .put("results", results)
                .put("requestNames", JSONArray(requests.map { it.first }))
                .put(
                    "visibleText",
                    JSONArray(
                        walk(root())
                            .filterIsInstance<TextView>()
                            .filter {
                                it.isShown && it !is EditText
                            }.map { it.text.toString() }
                            .toList(),
                    ),
                ).put("fontScale", resources.configuration.fontScale)
                .put("widthDp", root().width / resources.displayMetrics.density)
                .put(
                    "privateData",
                    false,
                ).put("productionInstall", false)
                .put("renderer", "attached Activity/View and Android window; PNG uses attached decor Canvas")
        File(getExternalFilesDir(null), "$profile-result.json").writeText(report.toString(2))
        NativeStatsSettingsInstrumentation.active!!.complete(report)
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus && !casesStarted && ::controller.isInitialized) {
            casesStarted = true
            step()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        profile = intent.getStringExtra("profile") ?: "profile"
        english = intent.getStringExtra("language") == "en"
        setContentView(FrameLayout(this))

        fun asset(name: String) = JSONObject(assets.open("$name.json").bufferedReader().use { it.readText() })
        schema = asset("schema")
        prefs = asset("prefs").put("language", if (english) "en" else "zh").put("appearance", intent.getStringExtra("theme") ?: "light")
        snapshots = asset("snapshots")
        boolRule =
            (0 until schema.getJSONArray("fields").length()).map { schema.getJSONArray("fields").getJSONObject(it) }.first {
                it.getString("kind") ==
                    "boolean" &&
                    it.getString("group") == "reading"
            }
        controller =
            NativePagesController(this, { name, payload, reply ->
                requests.add(name to JSONObject(payload.toString()))
                when (name) {
                    "state.settingsGet" -> {
                        reply(JSONObject().put("raw", prefs.toString()), null)
                    }

                    "action.settingsSchema" -> {
                        reply(JSONObject(schema.toString()), null)
                    }

                    "action.statisticsGet" -> {
                        val key = if (payload.has("selectedDay")) "day${payload.optInt("dayBookOffset", 0)}" else "base"
                        reply(JSONObject(snapshots.getJSONObject(key).toString()).put("language", if (english) "en" else "zh"), null)
                    }

                    "action.settingsPatch" -> {
                        if (holdWrite) {
                            assertThat(pending == null, "Overlapping writes")
                            pending = reply
                        } else {
                            reply(JSONObject().put("ok", true), null)
                        }
                    }

                    "action.settingsRecoveryInspect" -> {
                        reply(JSONObject().put("ok", true).put("state", "unresolved"), null)
                    }

                    else -> {
                        reply(null, "unexpected_fixture_action:$name")
                    }
                }
            }, {})
        controller.show("stats", JSONObject())
        add("attached statistics overview preserves shared-owner totals") {
            assertThat(root().isAttachedToWindow, "Overview detached")
            assertThat(
                walk(root()).filterIsInstance<TextView>().any {
                    it.isShown && it.text.toString() == "1 h 34 min"
                },
                "Expected 5640 seconds display missing",
            )
            for (title in listOf(tr("概览", "Overview"), tr("趋势", "Trends"), tr("年历", "Calendar"))) {
                assertThat(button(root(), title).height / resources.displayMetrics.density >= 48, "Tab too small")
            }
            capture(root(), "overview")
            tap(button(root(), tr("趋势", "Trends")))
        }
        add("trends retain scope controls without changing the source totals") {
            assertThat(
                walk(root()).filterIsInstance<TextView>().any {
                    it.isShown && it.text.toString() == tr("区间趋势", "Period trends")
                },
                "Trend card missing",
            )
            tap(button(root(), tr("年历", "Calendar")))
        }
        add("calendar adapts without shrinking date targets") {
            val digits =
                walk(
                    root(),
                ).filterIsInstance<Button>().filter { it.isShown && it.text.toString().matches(Regex("\\d{2}")) }.toList()
            for (day in digits) {
                assertThat(
                    day.width / resources.displayMetrics.density >= 48 && day.height / resources.displayMetrics.density >= 48,
                    "Calendar target too small",
                )
            }
            capture(root(), "calendar")
            tap(button(root(), tr("概览", "Overview")))
        }
        add("date details open through a real touch event") { tap(button(root(), "10-25", true)) }
        add("day dialog keeps complete footer and bounded scroll body") {
            dayDialog = statsDialog()
            checkFooter(dayDialog!!, AlertDialog.BUTTON_NEGATIVE)
            assertThat(
                walk(content(dayDialog!!)).filterIsInstance<TextView>().any { it.text.toString() == "1–20 / 65" },
                "Day page count missing",
            )
            val next = button(content(dayDialog!!), tr("下页", "Next page"))
            next.isFocusableInTouchMode = true
            next.requestFocus()
            tap(next)
        }
        add("day pagination reuses the same live Android dialog") {
            assertThat(dayDialog === statsDialog(), "Pagination replaced dialog")
            assertThat(requests.last { it.first == "action.statisticsGet" }.second.getInt("dayBookOffset") == 20, "Wrong day offset")
            assertThat((dayDialog!!.currentFocus as? Button)?.text.toString() == tr("下页", "Next page"), "Pager focus lost")
            checkFooter(dayDialog!!, AlertDialog.BUTTON_NEGATIVE)
            capture(content(dayDialog!!), "day")
            tap(dayDialog!!.getButton(AlertDialog.BUTTON_NEGATIVE))
        }
        add("goal form opens without a nested value chooser") { tap(button(root(), tr("每日目标", "Daily goal"), true)) }
        add("goal input and footer remain reachable at system font scale") {
            val alert = statsDialog()
            checkFooter(alert, AlertDialog.BUTTON_NEGATIVE, AlertDialog.BUTTON_NEUTRAL, AlertDialog.BUTTON_POSITIVE)
            input(alert).setText("1450")
            tap(alert.getButton(AlertDialog.BUTTON_POSITIVE))
        }
        add("invalid goal is rejected before the next explicit Save") {
            assertThat(count("action.settingsPatch") == 0, "Invalid goal submitted")
            input(statsDialog()).setText("0")
            holdWrite = true
            tap(statsDialog().getButton(AlertDialog.BUTTON_POSITIVE))
        }
        add("pending goal submission blocks Back and duplicate saving") {
            val alert = statsDialog()
            assertThat(!stats().canLeave() && stats().handleBack() && alert.isShowing, "Pending goal escaped")
            assertThat(
                !alert.getButton(AlertDialog.BUTTON_POSITIVE).isEnabled && !alert.getButton(AlertDialog.BUTTON_NEGATIVE).isEnabled,
                "Pending footer active",
            )
            assertThat(count("action.settingsPatch") == 1, "Duplicate goal write")
            val done = pending!!
            pending = null
            holdWrite = false
            done(null, "commit_outcome_unknown")
        }
        add("unknown goal keeps exact input and local recovery access") {
            val alert = statsDialog()
            assertThat(input(alert).text.toString() == "0", "Goal draft lost")
            checkFooter(alert, AlertDialog.BUTTON_NEGATIVE, AlertDialog.BUTTON_NEUTRAL, AlertDialog.BUTTON_POSITIVE)
            capture(content(alert), "goal")
            tap(alert.getButton(AlertDialog.BUTTON_NEUTRAL))
        }
        add("recovery inspect does not replay an unknown commit") {
            val recovery = settingsDialog()
            assertThat(count("action.settingsRecoveryInspect") == 1 && count("action.settingsPatch") == 1, "Recovery replayed")
            checkFooter(recovery, AlertDialog.BUTTON_NEGATIVE)
            tap(recovery.getButton(AlertDialog.BUTTON_NEGATIVE))
        }
        add("returning from recovery retains the goal window") { tap(statsDialog().getButton(AlertDialog.BUTTON_NEGATIVE)) }
        add("explicitly close original input before opening settings") { controller.show("settings", JSONObject()) }
        add("settings directory retains all eight canonical groups") {
            val page = field(settings(), "pageLayout") as NativeSettingsPageLayout
            assertThat(
                page.wide == ((root().width - root().paddingLeft - root().paddingRight) / resources.displayMetrics.density >= 960),
                "Wrong directory breakpoint: ${resources.configuration.screenWidthDp}",
            )
            if (!page.wide) tap(button(root(), tr("通用", "General")))
        }
        add("a single settings group is laid out inside the live page") {
            capture(root(), "settings")
            val label =
                schema.getJSONArray("fields").let { fields ->
                    (0 until fields.length())
                        .map { fields.getJSONObject(it) }
                        .first {
                            it.getJSONArray("path").toString() ==
                                "[\"language\"]"
                        }.getString(if (english) "labelEn" else "label")
                }
            val row = walk(root()).first { it.isShown && it.contentDescription?.toString()?.startsWith("$label:") == true }
            tap(row)
        }
        add("enum labels edit a draft without persisting canonical values") {
            val alert = settingsDialog()
            assertThat(
                walk(content(alert)).filterIsInstance<EditText>().none { it.visibility == View.VISIBLE },
                "Enum still exposes raw text",
            )
            tap(walk(content(alert)).filterIsInstance<RadioButton>().first { it.text.toString() == "English" })
        }
        add("translated enum choice has no persistence side effect") {
            val alert = settingsDialog()
            assertThat(count("action.settingsPatch") == 1, "Enum wrote before Save")
            checkFooter(alert, AlertDialog.BUTTON_NEGATIVE, AlertDialog.BUTTON_NEUTRAL, AlertDialog.BUTTON_POSITIVE)
            tap(alert.getButton(AlertDialog.BUTTON_NEGATIVE))
        }
        add("canonical section deep link opens the boolean category") {
            controller.show("settings", JSONObject().put("section", boolRule.getString("group")))
        }
        add("single row opens boolean draft directly") {
            val label = boolRule.getString(if (english) "labelEn" else "label")
            tap(walk(root()).first { it.isShown && it.contentDescription?.toString()?.startsWith("$label:") == true })
        }
        add("boolean choices keep raw values separate from translated labels") {
            tap(walk(content(settingsDialog())).filterIsInstance<RadioButton>().first { it.text.toString() == tr("开启", "On") })
        }
        add("boolean draft still requires explicit Save") {
            assertThat(count("action.settingsPatch") == 1, "Boolean wrote before Save")
            holdWrite = true
            tap(settingsDialog().getButton(AlertDialog.BUTTON_POSITIVE))
        }
        add("settings CAS payload remains typed and Back remains blocked") {
            val patch =
                requests
                    .last { it.first == "action.settingsPatch" }
                    .second
                    .getJSONArray("patches")
                    .getJSONObject(0)
            assertThat(
                patch.getJSONObject("before").get("value") == false && patch.getJSONObject("after").get("value") == true,
                "Canonical boolean changed type",
            )
            assertThat(!settings().canLeave() && settings().handleBack(), "Pending settings escaped")
            val done = pending!!
            pending = null
            holdWrite = false
            done(null, "commit_outcome_unknown")
        }
        add("unknown settings preserve selection and recovery in the same form") {
            val alert = settingsDialog()
            assertThat(
                walk(content(alert)).filterIsInstance<RadioButton>().any {
                    it.isChecked &&
                        it.text.toString() == tr("开启", "On")
                },
                "Boolean draft lost",
            )
            checkFooter(alert, AlertDialog.BUTTON_NEGATIVE, AlertDialog.BUTTON_NEUTRAL, AlertDialog.BUTTON_POSITIVE)
            capture(content(alert), "boolean")
            tap(alert.getButton(AlertDialog.BUTTON_NEUTRAL))
        }
        add("settings recovery returns to the original draft without replay") {
            tap(settingsDialog().getButton(AlertDialog.BUTTON_NEGATIVE))
            assertThat(count("action.settingsPatch") == 2, "Unknown settings replayed")
        }
        add("explicitly close retained boolean input") { tap(settingsDialog().getButton(AlertDialog.BUTTON_NEGATIVE)) }
        add("narrow Back returns to directory rather than leaving the page") {
            val page = field(settings(), "pageLayout") as NativeSettingsPageLayout
            if (!page.wide) {
                assertThat(settings().handleBack(), "Directory Back not handled")
                assertThat(page.directory, "Back did not restore directory")
            }
        }
    }
}
