package io.pagewise.reader

import android.app.Activity
import android.content.Context
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Rect
import android.os.Bundle
import android.view.Choreographer
import android.view.ContextThemeWrapper
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.CheckBox
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class NativeBookRecommendationsActivity : Activity() {
    private var variant: Context? = null

    override fun getResources() = variant?.resources ?: super.getResources()

    override fun getTheme() = variant?.theme ?: super.getTheme()

    override fun getAssets() = variant?.assets ?: super.getAssets()

    fun configure(font: Float) {
        val config =
            Configuration(super.getResources().configuration).apply {
                densityDpi = 160
                fontScale = font
            }
        variant = ContextThemeWrapper(super.createConfigurationContext(config), android.R.style.Theme_Material_Light_NoActionBar)
    }

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        val label = intent.getStringExtra("label") ?: error("missing label")
        check(label.matches(Regex("[A-Za-z0-9_-]+")))
        runRecommendationTests(this, File(filesDir, label))
    }
}

private fun recNodes(root: View): List<View> =
    listOf(root) + if (root is ViewGroup) (0 until root.childCount).flatMap { recNodes(root.getChildAt(it)) } else emptyList()

private fun recField(
    value: Any,
    name: String,
) = value.javaClass
    .getDeclaredField(name)
    .apply { isAccessible = true }
    .get(value)

private fun recAssign(
    value: Any,
    name: String,
    field: Any,
) {
    value.javaClass
        .getDeclaredField(name)
        .apply { isAccessible = true }
        .set(value, field)
}

private fun recInvoke(
    value: Any,
    name: String,
    vararg args: Any?,
): Any? =
    value.javaClass.declaredMethods
        .first {
            it.name == name &&
                it.parameterTypes.size == args.size
        }.apply { isAccessible = true }
        .invoke(value, *args)

private fun recBook(
    id: String = "source",
    en: Boolean = false,
) = JSONObject()
    .put(
        "id",
        id,
    ).put(
        "title",
        if (en) "Synthetic complexity and systems $id" else "合成复杂系统与演化机制 $id",
    ).put(
        "author",
        if (en) "Synthetic author $id" else "合成作者 $id",
    ).put(
        "publisher",
        "Synthetic publisher",
    ).put("publicationDate", "2020-01-01")
    .put("format", "epub")
    .put("fileName", "synthetic.epub")
    .put("supported", true)
    .put(
        "readingStatus",
        if (id ==
            "source"
        ) {
            "reading"
        } else {
            "unmarked"
        },
    ).put(
        "effectiveReadingStatus",
        "reading",
    ).put("lastReadAt", 1)
    .put("progress", 0.25)
    .put("hasCover", false)
    .put("tags", JSONArray())

private class RecTransport {
    val calls = mutableListOf<Pair<String, JSONObject>>()
    var hold: String? = null
    var pending: NativePageReply? = null
    var failGet = false

    fun result(payload: JSONObject): JSONObject {
        val en = payload.optString("language") == "en"

        fun card(id: String) =
            JSONObject()
                .put(
                    "book",
                    recBook(id, en),
                ).put(
                    "sourceId",
                    "source",
                ).put(
                    "sourceTitle",
                    recBook("source", en).getString("title"),
                ).put(
                    "reason",
                    if (en) "The source and this book both explicitly name complexity; this is metadata evidence, not verified content." else "《合成复杂系统与演化机制 source》与本书共享明确主题“复杂系统”；这是元数据线索，不是已核验正文结论。",
                ).put("recordCount", 1)
                .put("reasonKind", "local")
        val data =
            JSONObject()
                .put("token", "synthetic-context")
                .put("mode", payload.getString("mode"))
                .put(
                    "referenceId",
                    payload.opt("referenceId") ?: JSONObject.NULL,
                ).put(
                    "sources",
                    JSONArray().put(JSONObject().put("id", "source").put("title", recBook("source", en).getString("title"))),
                ).put(
                    "related",
                    JSONArray().put(card("related-one")).put(card("related-two")),
                ).put("extended", JSONArray().put(card("extended-one")))
        return JSONObject().put("ok", true).put("result", data).put("canAddWanted", true)
    }

    fun request(
        action: String,
        payload: JSONObject,
        reply: NativePageReply,
    ) {
        calls.add(action to JSONObject(payload.toString()))
        if (action == hold) {
            pending = reply
            return
        }
        when (action) {
            "state.settingsGet" -> {
                reply(JSONObject().put("raw", JSONObject().put("language", "zh").put("appearance", "light").toString()), null)
            }

            "action.recommendationsGet" -> {
                if (failGet) reply(JSONObject().put("ok", false).put("code", "feedback_corrupt"), null) else reply(result(payload), null)
            }

            "action.recommendationsWanted", "action.recommendationsFeedback", "action.recommendationsClearFeedback", "action.recommendationsCancel" -> {
                reply(JSONObject().put("ok", true), null)
            }

            "action.librarySessionGet" -> {
                reply(JSONObject().put("defaults", session()).put("session", session()), null)
            }

            "action.libraryPage" -> {
                reply(
                    JSONObject()
                        .put(
                            "ok",
                            true,
                        ).put(
                            "allCount",
                            0,
                        ).put(
                            "readingSeconds",
                            0,
                        ).put(
                            "total",
                            0,
                        ).put("page", 1)
                        .put("pageSize", 12)
                        .put("totalPages", 1)
                        .put("selectionToken", "synthetic-selection")
                        .put(
                            "session",
                            payload.optJSONObject("session") ?: session(),
                        ).put(
                            "tabCounts",
                            JSONObject()
                                .put(
                                    "reading",
                                    0,
                                ).put("recent", 0)
                                .put("wanted", 0)
                                .put("paused", 0)
                                .put("finished", 0)
                                .put("abandoned", 0),
                        ).put(
                            "facets",
                            JSONObject().put("tagFilter", JSONArray()).put("categoryFilter", JSONArray()),
                        ).put("items", JSONArray()),
                    null,
                )
            }

            "action.librarySessionSave" -> {
                reply(JSONObject().put("ok", true), null)
            }

            "library.book" -> {
                reply(JSONObject().put("book", recBook()), null)
            }

            "action.libraryBookInfo" -> {
                check(payload.getString("bookId") == "source")
                val book = recBook(payload.getString("bookId"))
                reply(
                    JSONObject()
                        .put("ok", true)
                        .put("effectiveReadingStatus", book.getString("effectiveReadingStatus"))
                        .put("supported", book.getBoolean("supported")),
                    null,
                )
            }

            "library.annotations" -> {
                reply(
                    JSONObject()
                        .put("items", JSONArray())
                        .put("total", 0)
                        .put("page", 1)
                        .put("pageSize", 12)
                        .put("totalPages", 1),
                    null,
                )
            }

            else -> {
                reply(null, "unexpected_fixture_action:$action")
            }
        }
    }

    private fun session() =
        JSONObject()
            .put(
                "page",
                1,
            ).put("pageSize", 12)
            .put("sortBy", "added")
            .put("keyword", "")
            .put("categoryFilter", "")
            .put("orderedBookIds", JSONArray())
}

private fun runRecommendationTests(
    activity: NativeBookRecommendationsActivity,
    out: File,
) {
    check(!out.exists())
    out.mkdirs()
    Thread {
        val results = JSONArray()
        val images = JSONArray()

        fun ui(action: () -> Unit) {
            val done = CountDownLatch(1)
            var error: Throwable? = null
            activity.runOnUiThread {
                try {
                    action()
                } catch (t: Throwable) {
                    error =
                        t
                } finally {
                    done.countDown()
                }
            }
            check(done.await(10, TimeUnit.SECONDS)) { "UI timeout" }
            error?.let { throw it }
        }

        fun frames() {
            repeat(3) {
                val done = CountDownLatch(1)
                activity.runOnUiThread { Choreographer.getInstance().postFrameCallback { done.countDown() } }
                check(done.await(8, TimeUnit.SECONDS)) { "frame timeout" }
            }
        }

        fun test(
            name: String,
            action: () -> Unit,
        ) {
            File(out, "progress.json").writeText(JSONObject().put("current", name).put("completed", results).toString(2))
            try {
                action()
                results.put(JSONObject().put("name", name).put("passed", true))
            } catch (t: Throwable) {
                results.put(
                    JSONObject()
                        .put(
                            "name",
                            name,
                        ).put("passed", false)
                        .put("error", t.toString())
                        .put("stack", t.stackTraceToString().take(5000)),
                )
            }
            File(out, "progress.json").writeText(JSONObject().put("current", name).put("completed", results).toString(2))
        }

        fun button(
            root: View,
            title: String,
        ) = recNodes(root).filterIsInstance<Button>().first { it.text.toString() == title }

        fun attach(
            panel: NativeBookRecommendationsPanel,
            width: Int = 320,
            font: Float = 1f,
        ): View {
            var view: View? = null
            ui {
                activity.configure(font)
                view =
                    panel.render()
                activity.setContentView(ScrollView(activity).apply { addView(view) })
                activity.window.setLayout(width, 900)
            }
            frames()
            return view!!
        }

        fun panel(
            t: RecTransport,
            en: Boolean = false,
            mode: String = "reading",
            count: (Int?) -> Unit = {},
        ): NativeBookRecommendationsPanel =
            NativeBookRecommendationsPanel(
                activity,
                0xff111111.toInt(),
                0xffffffff.toInt(),
                en,
                mode,
                if (mode ==
                    "detail"
                ) {
                    "source"
                } else {
                    null
                },
                t::request,
                { true },
                {},
                { _, _ -> },
                count,
            )
        test("local cards, exact count and no automatic AI") {
            val t = RecTransport()
            var count: Int? = null
            lateinit var p: NativeBookRecommendationsPanel
            ui {
                activity.configure(1f)
                p =
                    panel(t, count = { count = it })
            }
            val root = attach(p)
            ui {
                check(count == 3)
                check(t.calls.none { it.first == "action.recommendationsAi" })
                check(recNodes(root).filterIsInstance<TextView>().any { it.text.toString().contains("相关阅读 (2)") })
            }
        }
        test("wanted write blocks leave/back and changes no progress fields in payload") {
            val t = RecTransport().apply { hold = "action.recommendationsWanted" }
            lateinit var p: NativeBookRecommendationsPanel
            ui { p = panel(t) }
            val root = attach(p)
            ui {
                button(root, "加入想读").performClick()
                check(!p.canLeave())
                check(p.handleBack())
                val payload = t.calls.last { it.first == t.hold }.second
                check(payload.keys().asSequence().toSet() == setOf("token", "candidateId", "requestId"))
                t.pending!!(JSONObject().put("ok", true), null)
                check(p.canLeave())
            }
        }
        test("unknown write disables replay but retains details navigation") {
            val t = RecTransport().apply { hold = "action.recommendationsWanted" }
            lateinit var p: NativeBookRecommendationsPanel
            ui { p = panel(t) }
            val root = attach(p)
            ui {
                button(root, "加入想读").performClick()
                t.pending!!(null, "host_closed")
                check(p.canLeave())
                check(
                    recNodes(root)
                        .filterIsInstance<Button>()
                        .filter {
                            it.text.toString() ==
                                "加入想读"
                        }.all { !it.isEnabled },
                )
                check(button(root, "查看详情").isEnabled)
                check(t.calls.count { it.first == t.hold } == 1)
            }
        }
        test("failed preference read is error, not empty; explicit feature-only clear remains accessible") {
            val t = RecTransport().apply { failGet = true }
            lateinit var p: NativeBookRecommendationsPanel
            ui { p = panel(t) }
            val root = attach(p)
            ui {
                check(recNodes(root).filterIsInstance<TextView>().any { it.text.toString().contains("偏好") })
                val clear = button(root, "清空推荐负反馈")
                check(clear.isEnabled)
                clear.performClick()
                button(root, "确认清空").performClick()
                check(t.calls.count { it.first == "action.recommendationsClearFeedback" } == 1)
            }
        }
        test("closed owner ignores late load and cancels context") {
            val t = RecTransport().apply { hold = "action.recommendationsGet" }
            lateinit var p: NativeBookRecommendationsPanel
            var counts = 0
            ui {
                p =
                    panel(t, count = { if (it != null) counts++ })
            }
            attach(p)
            ui {
                p.close()
                t.pending!!(t.result(JSONObject().put("mode", "reading")), null)
                check(counts == 0)
                check(
                    t.calls.any {
                        it.first ==
                            "action.recommendationsCancel"
                    },
                )
            }
        }
        test("explicit AI disclosure is required and cancel calls only owned request") {
            val t = RecTransport().apply { hold = "action.recommendationsAi" }
            lateinit var p: NativeBookRecommendationsPanel
            ui { p = panel(t) }
            val root = attach(p)
            ui {
                check(t.calls.none { it.first == "action.recommendationsAi" })
                button(root, "发送书目摘要生成 AI 理由").performClick()
                check(t.calls.count { it.first == "action.recommendationsAi" } == 1)
                button(root, "取消 AI 请求").performClick()
                check(
                    t.calls.any {
                        it.first ==
                            "action.recommendationsCancel" &&
                            it.second.has("requestId")
                    },
                )
            }
        }
        for (en in listOf(false, true)) {
            for ((width, font) in listOf(320 to 1f, 992 to 1f, 320 to 1.8f)) {
                test("attached layout ${if (en) "en" else "zh"}-$width-$font") {
                    val t = RecTransport()
                    lateinit var p: NativeBookRecommendationsPanel
                    ui {
                        activity.configure(font)
                        p = panel(t, en, "detail")
                    }
                    val root = attach(p, width, font)
                    val buttons = mutableListOf<Button>()
                    ui {
                        buttons.addAll(
                            recNodes(root).filterIsInstance<Button>().filter {
                                it.visibility ==
                                    View.VISIBLE
                            },
                        )
                        ;check(root.width > 0)
                        check(buttons.isNotEmpty())
                    }
                    for (b in buttons) {
                        ui { b.requestRectangleOnScreen(Rect(0, 0, b.width, b.height), true) }
                        frames()
                        ui {
                            val rect = Rect()
                            check(b.width >= 48 && b.height >= 48) { "small ${b.text}: ${b.width}x${b.height}" }
                            check(b.getGlobalVisibleRect(rect) && rect.width() >= b.width && rect.height() >= b.height) {
                                "clipped ${b.text}: $rect ${b.width}x${b.height}"
                            }
                        }
                    }
                    ui { (root.parent as ScrollView).scrollTo(0, 0) }
                    frames()
                    ui {
                        val decor = activity.window.decorView
                        val bitmap = Bitmap.createBitmap(decor.width, decor.height, Bitmap.Config.ARGB_8888)
                        decor.draw(Canvas(bitmap))
                        val name = "${if (en) "en" else "zh"}-$width-$font.png"
                        File(out, name).outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
                        bitmap.recycle()
                        images.put(name)
                    }
                }
            }
        }
        test("reading recommendation tab is reachable without replacing six status tabs") {
            val t = RecTransport()
            lateinit var c: NativePagesController
            lateinit var root: View
            ui {
                activity.configure(1f)
                c = NativePagesController(activity, t::request, {}, {})
                activity.setContentView(android.widget.FrameLayout(activity))
                c.show("reading", JSONObject())
                root = activity.window.decorView
                activity.window.setLayout(320, 900)
            }
            frames()
            ui {
                check(t.calls.any { it.first == "action.libraryPage" })
                button(root, "推荐").performClick()
            }
            frames()
            ui {
                check(
                    t.calls.any {
                        it.first ==
                            "action.recommendationsGet" &&
                            it.second.optString("mode") == "reading"
                    },
                )
                check(recNodes(root).filterIsInstance<TextView>().any { it.text.toString().contains("相关阅读 (2)") })
            }
        }
        test("detail fourth tab is lazy, count-bound and protects wanted write on tab change") {
            val t = RecTransport().apply { hold = "action.recommendationsWanted" }
            lateinit var c: NativePagesController
            lateinit var root: View
            ui {
                activity.configure(1f)
                c = NativePagesController(activity, t::request, {}, {})
                activity.setContentView(android.widget.FrameLayout(activity))
                c.show("book", JSONObject().put("id", "source"))
                root = activity.window.decorView
                activity.window.setLayout(320, 900)
            }
            frames()
            ui {
                check(t.calls.none { it.first == "action.recommendationsGet" })
                button(root, "相关与拓展").performClick()
            }
            frames()
            ui {
                check(button(root, "相关与拓展 (3)").isSelected)
                button(root, "加入想读").performClick()
                button(root, "概览信息").performClick()
                check(button(root, "相关与拓展 (3)").isSelected)
                t.pending!!(JSONObject().put("ok", true), null)
                button(root, "概览信息").performClick()
                check(button(root, "概览信息").isSelected)
            }
        }
        val passed = (0 until results.length()).count { results.getJSONObject(it).optBoolean("passed") }
        File(
            out,
            "result.json",
        ).writeText(
            JSONObject()
                .put(
                    "passed",
                    passed == results.length(),
                ).put("passedCount", passed)
                .put("total", results.length())
                .put("tests", results)
                .put("images", images)
                .toString(2),
        )
    }.start()
}
