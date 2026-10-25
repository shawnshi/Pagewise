package io.pagewise.reader

import android.app.Activity
import android.app.AlertDialog
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Rect
import android.os.Bundle
import android.os.SystemClock
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.view.MotionEvent
import android.view.Choreographer
import android.view.InputDevice
import android.view.WindowManager
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

private fun introNodes(view: View): List<View> = listOf(view) + if (view is ViewGroup) (0 until view.childCount).flatMap { introNodes(view.getChildAt(it)) } else emptyList()
private fun introBook(description: Boolean = true) = JSONObject().put("id", "fixture-a").put("title", "合成书名 Synthetic title").put("author", "Synthetic author").put("publisher", "Synthetic press").put("publicationDate", "2001-02-03").put("format", "epub").put("fileName", "synthetic.epub").put("tags", JSONArray()).put("description", if (description) "Original synthetic description" else JSONObject.NULL)
private class IntroProbe(val activity: Activity, english: Boolean = false) {
    val requests = mutableListOf<Pair<String, JSONObject>>()
    var generateReply: NativePageReply? = null
    var saveReply: NativePageReply? = null
    var owner = true
    var saves = 0
    var closes = 0
    val editor = NativeBookIntroductionEditor(activity, introBook(), Color.BLACK, Color.WHITE, english, { name, payload, reply ->
        requests.add(name to JSONObject(payload.toString()))
        when (name) {
            "action.bookIntroductionGenerate" -> generateReply = reply
            "action.bookIntroductionSave" -> saveReply = reply
            "action.bookIntroductionCancel" -> reply(JSONObject().put("ok", true), null)
            else -> error("Unexpected synthetic request: $name")
        }
    }, { owner }, { saves++ }, { closes++ })
    val dialog = editor.show()
    val preview get() = introNodes(dialog.window!!.decorView).filterIsInstance<EditText>().last()
    val generate get() = dialog.getButton(AlertDialog.BUTTON_POSITIVE)
    val replace get() = dialog.getButton(AlertDialog.BUTTON_NEUTRAL)
    fun generated(text: String = "Synthetic generated draft") {
        val payload = requests.lastOrNull { it.first == "action.bookIntroductionGenerate" }?.second
            ?: error("No generation: showing=${dialog.isShowing}; enabled=${generate.isEnabled}; finishing=${activity.isFinishing}; destroyed=${activity.isDestroyed}; closes=$closes; requests=${requests.map { it.first }}")
        generateReply!!(JSONObject().put("ok", true).put("bookId", "fixture-a").put("requestId", payload.getString("requestId")).put("token", "synthetic-token").put("text", text), null)
    }
    fun close() { editor.dispose() }
}

/** Empty test Activity: no INTERNET permission, real AI, database, book file, or production package. */
class NativeBookIntroductionActivity : Activity() {
    override fun onCreate(state: Bundle?) { super.onCreate(state); setContentView(FrameLayout(this)); Handler(Looper.getMainLooper()).post { runCases() } }
    private fun runCases() {
        val label = intent.getStringExtra("label") ?: "intro"; require(Regex("[\\w-]+").matches(label))
        val base = File(filesDir, label).apply { mkdirs() }; val cases = JSONArray(); val renders = JSONArray(); var failures = 0
        val main = Handler(Looper.getMainLooper()); val queue = mutableListOf<() -> Unit>(); var index = 0
        lateinit var next: () -> Unit
        fun record(name: String, error: Throwable?) {
            val result = JSONObject().put("name", name).put("passed", error == null)
            if (error != null) { failures++; result.put("error", error.javaClass.simpleName + ": " + error.message.orEmpty()); result.put("stack", error.stackTrace.take(5).joinToString("\n")) }
            cases.put(result)
        }
        fun case(name: String, setup: () -> Unit, cleanup: () -> Unit, after: () -> Unit = {}, body: () -> Unit) {
            queue.add {
                try {
                    setup()
                    // AlertDialog dispatches onShow through its Handler. Exercise the real queued listener,
                    // not a pre-onShow Button with Android's temporary auto-dismiss default listener.
                    Choreographer.getInstance().postFrameCallback { main.post {
                        var failure: Throwable? = null
                        try { body() } catch (error: Throwable) { failure = error }
                        cleanup()
                        main.post {
                            try { after() } catch (error: Throwable) { if (failure == null) failure = error }
                            record(name, failure); next()
                        }
                    } }
                } catch (error: Throwable) { record(name, error); cleanup(); main.post { next() } }
            }
        }
        fun probeCase(name: String, before: () -> Unit = {}, body: (IntroProbe) -> Unit) {
            var probe: IntroProbe? = null
            case(name, { before(); probe = IntroProbe(this) }, { probe?.close() }, {
                check(probe!!.closes == 1)
                if (probe!!.requests.any { it.first == "action.bookIntroductionGenerate" }) check(probe!!.requests.count { it.first == "action.bookIntroductionCancel" } == 1)
            }, { body(probe!!) })
        }
        probeCase("initial dialog is preview-only and Replace is disabled") { p -> check(p.requests.isEmpty()); check(!p.replace.isEnabled); check(p.preview.text.isEmpty()); check(p.editor.canLeave()) }
        probeCase("generation carries identity, nonce and optional series only") { p ->
            introNodes(p.dialog.window!!.decorView).filterIsInstance<EditText>().first().setText("Synthetic series"); p.generate.performClick()
            val payload = p.requests.single().second
            check(payload.keys().asSequence().toSet() == setOf("bookId", "requestId", "series")); check(payload.getString("series") == "Synthetic series" && payload.getString("requestId").isNotEmpty())
            check(!p.replace.isEnabled); p.generated(); check(p.replace.isEnabled && p.preview.text.toString() == "Synthetic generated draft")
        }
        probeCase("editing toggles Replace and submitted save cannot be cancelled") { p ->
            p.generate.performClick(); p.generated(); p.preview.setText(""); check(!p.replace.isEnabled); p.preview.setText("Edited synthetic text"); check(p.replace.isEnabled); p.replace.performClick()
            val save = p.requests.single { it.first == "action.bookIntroductionSave" }.second
            check(save.getBoolean("confirmReplace") && save.getString("text") == "Edited synthetic text"); check(!p.editor.canLeave()); p.editor.requestClose(); check(p.dialog.isShowing); check(!p.editor.closeForLeave()); check(!p.replace.isEnabled)
            p.saveReply!!(JSONObject().put("ok", true).put("bookId", "fixture-a").put("saved", true), null); check(!p.dialog.isShowing && p.saves == 1)
        }
        probeCase("close cancels generation and rejects late reply") { p ->
            p.generate.performClick(); p.editor.requestClose(); p.generated(); check(!p.dialog.isShowing && p.saves == 0)
            check(p.requests.none { it.first == "action.bookIntroductionSave" })
        }
        probeCase("owner change rejects late generated text") { p -> p.generate.performClick(); p.owner = false; p.generated(); check(p.preview.text.isEmpty() && p.saves == 0) }
        for (code in listOf("source_changed", "commit_outcome_unknown")) probeCase("$code retains copyable text and disables replay") { p ->
            p.generate.performClick(); p.generated(); p.replace.performClick(); p.saveReply!!(JSONObject().put("ok", false).put("code", code), null)
            check(p.dialog.isShowing && p.editor.canLeave() && p.preview.text.toString() == "Synthetic generated draft" && !p.replace.isEnabled && p.saves == 0)
        }
        probeCase("save transport failure is unknown rather than safe-to-retry") { p ->
            p.generate.performClick(); p.generated(); p.replace.performClick(); p.saveReply!!(null, "host_closed"); check(!p.replace.isEnabled && p.preview.text.isNotBlank() && p.saves == 0)
        }
        for (hasDescription in listOf(false, true)) {
            var controller: NativePagesController? = null; var window: AlertDialog? = null; var pendingGenerate: NativePageReply? = null; var pendingSave: NativePageReply? = null; var requestId = ""
            case("actual overview Generate entry and prepareLeave save barrier; original=$hasDescription", {
                controller = NativePagesController(this, { name, payload, reply ->
                    when (name) {
                        "state.settingsGet" -> reply(JSONObject().put("raw", JSONObject().put("language", "zh").toString()), null)
                        "library.book" -> reply(JSONObject().put("book", introBook(hasDescription)), null)
                        "action.libraryBookInfo" -> reply(JSONObject().put("effectiveReadingStatus", "unmarked").put("supported", true), null)
                        "library.annotations" -> reply(JSONObject().put("items", JSONArray()).put("total", 0), null)
                        "action.bookIntroductionGenerate" -> { pendingGenerate = reply; requestId = payload.getString("requestId") }
                        "action.bookIntroductionSave" -> pendingSave = reply
                        "action.bookIntroductionCancel" -> reply(JSONObject().put("ok", true), null)
                        else -> error("Unexpected controller request: $name")
                    }
                }, {})
                controller!!.show("book", JSONObject().put("id", "fixture-a"))
                introNodes(findViewById<View>(android.R.id.content)).filterIsInstance<Button>().single { it.text.toString() == "生成简介" }.performClick()
                window = controller!!.javaClass.getDeclaredField("currentDialog").apply { isAccessible = true }.get(controller) as AlertDialog
            }, { controller?.dispose() }, {}, {
                val dialog = window!!; dialog.getButton(AlertDialog.BUTTON_POSITIVE).performClick()
                pendingGenerate!!(JSONObject().put("ok", true).put("bookId", "fixture-a").put("requestId", requestId).put("token", "native-token").put("text", "Native overview draft"), null)
                dialog.getButton(AlertDialog.BUTTON_NEUTRAL).performClick(); var leave: String? = "not-called"; controller!!.prepareLeave { leave = it }
                check(leave == "native_operation_pending"); check(pendingSave != null); check(controller!!.handleBack() && dialog.isShowing)
                pendingSave!!(JSONObject().put("ok", false).put("code", "source_changed"), null); controller!!.prepareLeave { leave = it }; check(leave == null)
            })
        }
        // These cases use a real attached ViewRoot traversal; never force measure/layout
        // on a DecorView. A positive height is not proof of full visibility or touch reachability.
        for ((language, english) in listOf("zh" to false, "en" to true)) {
            for ((width, font) in listOf(320 to 1f, 992 to 1f, 320 to 1.8f)) queue.add {
                val name = "attached window $language width-$width font-$font: complete footer and touch flow"
                val config = android.content.res.Configuration(resources.configuration).apply { fontScale = font }
                @Suppress("DEPRECATION") resources.updateConfiguration(config, resources.displayMetrics)
                val p = IntroProbe(this, english)
                val decor = p.dialog.window!!.decorView
                p.dialog.window!!.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN or WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
                p.dialog.window!!.setLayout(NativeUi.dp(this, width), NativeUi.dp(this, 900))
                var done = false
                fun finish(error: Throwable?) {
                    if (done) return
                    done = true
                    p.close()
                    main.post {
                        var failure = error
                        if (failure == null && p.closes != 1) failure = IllegalStateException("dismiss callback not settled: ${p.closes}")
                        record(name, failure)
                        next()
                    }
                }
                fun settled(action: () -> Unit) {
                    // Animation callbacks run before traversal; the Handler continuation runs
                    // after that Choreographer frame (including traversal) has returned.
                    decor.postOnAnimation { main.post { if (!done) try { action() } catch (error: Throwable) { finish(error) } } }
                }
                fun fullButton(button: Button): JSONObject {
                    val visible = Rect()
                    val buttonAt = IntArray(2); val decorAt = IntArray(2)
                    button.getLocationOnScreen(buttonAt); decor.getLocationOnScreen(decorAt)
                    val shown = button.getGlobalVisibleRect(visible)
                    val full = shown && visible.width() == button.width && visible.height() == button.height &&
                        buttonAt[0] >= decorAt[0] && buttonAt[1] >= decorAt[1] &&
                        buttonAt[0] + button.width <= decorAt[0] + decor.width && buttonAt[1] + button.height <= decorAt[1] + decor.height
                    return JSONObject().put("label", button.text).put("width", button.width).put("height", button.height)
                        .put("visibleWidth", visible.width()).put("visibleHeight", visible.height()).put("fullyVisible", full)
                        .put("x", buttonAt[0] - decorAt[0]).put("y", buttonAt[1] - decorAt[1])
                }
                fun touch(button: Button) {
                    val geometry = fullButton(button)
                    check(geometry.getBoolean("fullyVisible")) { "Touch target clipped: $geometry" }
                    check(button.isEnabled) { "Touch target disabled: ${button.text}" }
                    val buttonAt = IntArray(2); val decorAt = IntArray(2)
                    button.getLocationOnScreen(buttonAt); decor.getLocationOnScreen(decorAt)
                    val x = buttonAt[0] - decorAt[0] + button.width / 2f
                    val y = buttonAt[1] - decorAt[1] + button.height / 2f
                    val time = SystemClock.uptimeMillis()
                    for ((event, offset) in listOf(MotionEvent.ACTION_DOWN to 0L, MotionEvent.ACTION_UP to 20L)) {
                        val motion = MotionEvent.obtain(time, time + offset, event, x, y, 0)
                        motion.source = InputDevice.SOURCE_TOUCHSCREEN
                        try { check(decor.dispatchTouchEvent(motion)) { "Decor rejected real touch: ${button.text}" } } finally { motion.recycle() }
                    }
                }
                settled {
                    check(decor.isAttachedToWindow && decor.width > 0 && decor.height > 0) { "Window not attached: showing=${p.dialog.isShowing}; attached=${decor.isAttachedToWindow}; w=${decor.width}; h=${decor.height}; finishing=$isFinishing" }
                    val initialButtons = JSONArray(listOf(AlertDialog.BUTTON_POSITIVE, AlertDialog.BUTTON_NEUTRAL, AlertDialog.BUTTON_NEGATIVE).map { fullButton(p.dialog.getButton(it)) })
                    renders.put(JSONObject().put("stage", "before-touch").put("language", language).put("widthDp", width).put("fontScale", font).put("buttons", initialButtons))
                    touch(p.generate)
                    settled {
                        try {
                            check(p.requests.count { it.first == "action.bookIntroductionGenerate" } == 1) { "Generate touch did not dispatch: showing=${p.dialog.isShowing}; requests=${p.requests.map { it.first }}; finishing=$isFinishing; buttons=$initialButtons" }
                            val draft = List(500) { "synthetic" }.joinToString(" ")
                            p.generated(draft)
                            settled {
                                val buttons = listOf(AlertDialog.BUTTON_POSITIVE, AlertDialog.BUTTON_NEUTRAL, AlertDialog.BUTTON_NEGATIVE).map { p.dialog.getButton(it) }
                                val geometry = JSONArray(buttons.map { fullButton(it) })
                                renders.put(JSONObject().put("language", language).put("widthDp", width).put("fontScale", font)
                                    .put("decorWidth", decor.width).put("decorHeight", decor.height).put("density", resources.displayMetrics.density)
                                    .put("buttons", geometry).put("kind", "attached real Android window; no forced Canvas layout"))
                                val bitmap = Bitmap.createBitmap(decor.width, decor.height, Bitmap.Config.ARGB_8888)
                                bitmap.eraseColor(Color.WHITE); decor.draw(Canvas(bitmap))
                                File(base, "native-$language-$width-$font.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle()
                                for (i in buttons.indices) {
                                    check(geometry.getJSONObject(i).getBoolean("fullyVisible")) { "Footer clipped: ${geometry.getJSONObject(i)}" }
                                    check(buttons[i].height >= NativeUi.dp(this, 48) && buttons[i].width >= NativeUi.dp(this, 48)) { "Footer below 48dp" }
                                }
                                touch(p.replace)
                                settled {
                                    try {
                                        check(p.requests.count { it.first == "action.bookIntroductionSave" } == 1 && !p.editor.canLeave())
                                        p.saveReply!!(JSONObject().put("ok", false).put("code", "commit_outcome_unknown"), null)
                                        check(!p.replace.isEnabled && !p.generate.isEnabled && p.preview.text.toString() == draft)
                                        touch(p.dialog.getButton(AlertDialog.BUTTON_NEGATIVE))
                                        main.post { main.post { try { check(!p.dialog.isShowing); finish(null) } catch (error: Throwable) { finish(error) } } }
                                    } catch (error: Throwable) { finish(error) }
                                }
                            }
                        } catch (error: Throwable) { finish(error) }
                    }
                }
            }
        }
        next = {
            if (index < queue.size) queue[index++]()
            else {
                File(base, "result.json").writeText(JSONObject().put("cases", cases).put("failures", failures).put("renders", renders).put("runtimeApi", android.os.Build.VERSION.SDK_INT).put("testPackage", packageName).put("uid", android.os.Process.myUid()).put("noRealAi", true).put("noProductionLibrary", true).toString()); finish()
            }
        }
        next()
    }
}
