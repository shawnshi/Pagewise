package io.pagewise.reader

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.os.Looper
import android.view.ContextThemeWrapper
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

class NativeLibraryPresentationActivity : Activity() {
    private var variant: Context? = null

    override fun getResources() = variant?.resources ?: super.getResources()

    override fun getTheme() = variant?.theme ?: super.getTheme()

    fun configure(font: Float) {
        val config =
            android.content.res.Configuration(super.getResources().configuration).apply {
                densityDpi = 300
                fontScale = font
            }
        variant = ContextThemeWrapper(super.createConfigurationContext(config), android.R.style.Theme_Material_Light)
    }

    override fun onCreate(state: android.os.Bundle?) {
        super.onCreate(state)
        val label = intent.getStringExtra("label") ?: error("missing fixture label")
        check(label.matches(Regex("[A-Za-z0-9_-]+")))
        runPresentationTests(this, File(filesDir, label))
    }
}

private fun field(
    target: Any,
    name: String,
): Any? =
    target.javaClass
        .getDeclaredField(name)
        .apply { isAccessible = true }
        .get(target)

private fun assign(
    target: Any,
    name: String,
    value: Any?,
) {
    target.javaClass
        .getDeclaredField(name)
        .apply { isAccessible = true }
        .set(target, value)
}

private fun invoke(
    target: Any,
    name: String,
    vararg args: Any?,
): Any? =
    target.javaClass.declaredMethods
        .first {
            it.name == name && it.parameterTypes.size == args.size
        }.apply { isAccessible = true }
        .invoke(target, *args)

private fun nodes(root: View): List<View> =
    listOf(root) + if (root is ViewGroup) (0 until root.childCount).flatMap { nodes(root.getChildAt(it)) } else emptyList()

private fun texts(root: View) = nodes(root).filterIsInstance<TextView>().filter { it.visibility != View.GONE }.map { it.text.toString() }

private fun sample() =
    JSONObject()
        .put("id", "synthetic-book")
        .put("title", "合成书目标题 Synthetic book")
        .put("author", "合成作者")
        .put("publisher", "合成出版社")
        .put("publicationDate", "2021-03-04T12:00:00Z")
        .put("format", "epub")
        .put("kind", "book")
        .put("fileName", "synthetic.epub")
        .put("tags", JSONArray().put("文学").put("小说").put("合成分类"))
        .put("supported", true)
        .put("effectiveReadingStatus", "reading")
        .put("readingStatus", "reading")
        .put("lastReadAt", 1700000000000L)
        .put("readingSeconds", 95)
        .put("progress", 0.25)
        .put("fileAvailability", "available")

private fun session() =
    JSONObject()
        .put("page", 1)
        .put("pageSize", 12)
        .put("sortBy", "added")
        .put("keyword", "")
        .put("orderedBookIds", JSONArray().put("old-order"))
        .put("lastViewedBookId", "old-order")
        .put("categoryFilter", "")

private class Presentation(
    val activity: Activity,
    val reading: Boolean,
    val empty: Boolean = false,
    val withZero: Boolean = false,
) {
    val requests = mutableListOf<Pair<String, JSONObject>>()
    val pending = mutableListOf<NativePageReply>()
    var hold = false
    val controller =
        NativePagesController(activity, { action, payload, reply ->
            requests.add(action to JSONObject(payload.toString()))
            when (action) {
                "action.librarySessionGet" -> reply(JSONObject().put("defaults", session()).put("session", session()), null)
                "action.libraryPage" -> if (hold) pending.add(reply) else reply(page(payload.optJSONObject("session") ?: session()), null)
                "action.librarySessionSave" -> reply(JSONObject().put("ok", true), null)
                "library.book" -> reply(JSONObject().put("book", sample()), null)
                else -> reply(null, "unexpected_fixture_action")
            }
        }, {}, {})

    init {
        assign(controller, "page", if (reading) "reading" else "library")
        invoke(controller, "frame")
        invoke(controller, "books")
    }

    fun page(
        saved: JSONObject = session(),
        count: Int = if (empty) 0 else 1,
        categoryCount: Int = if (empty) 0 else 1,
    ) = JSONObject()
        .put(
            "ok",
            true,
        ).put("allCount", count)
        .put("readingSeconds", 95)
        .put("total", count)
        .put("page", 1)
        .put("pageSize", 12)
        .put("totalPages", 1)
        .put("session", JSONObject(saved.toString()))
        .put("selectionToken", "synthetic-token")
        .put(
            "tabCounts",
            JSONObject()
                .put("reading", count)
                .put("recent", count)
                .put("wanted", 0)
                .put("paused", 0)
                .put("finished", 0)
                .put("abandoned", 0),
        ).put(
            "facets",
            JSONObject().put("tagFilter", JSONArray().put(JSONObject().put("value", "合成标签"))).put(
                "categoryFilter",
                JSONArray().apply {
                    if (!empty) put(JSONObject().put("value", "category-a").put("label", "类别A").put("count", categoryCount))
                    if (withZero) put(JSONObject().put("value", "category-zero").put("label", "空类别").put("count", 0))
                },
            ),
        ).put("items", if (empty) JSONArray() else JSONArray().put(sample()))

    val panel get() = field(controller, "libraryPanel") as NativeLibraryPanel

    @Suppress("UNCHECKED_CAST")
    val dialogs get() = (field(panel, "dialogs") as Collection<AlertDialog>).toList()
    val root get() = field(controller, "shell") as View
    val body get() = field(panel, "root") as View
    val header get() = field(controller, "pageTitle") as TextView

    fun row(book: JSONObject = sample()) = invoke(controller, "bookRow", book, null, null) as View

    @Suppress("UNCHECKED_CAST")
    fun actions(): List<Pair<String, () -> Unit>> =
        panel.javaClass.declaredMethods.firstOrNull { it.name == "menuActions" }?.let {
            it.isAccessible = true
            it.invoke(panel) as List<Pair<String, () -> Unit>>
        } ?: emptyList()

    fun summary(
        owner: Long,
        value: String?,
    ): Boolean {
        val method = controller.javaClass.declaredMethods.firstOrNull { it.name == "updateLibrarySummary" } ?: return false
        method.isAccessible = true
        method.invoke(controller, owner, value)
        return true
    }
}

private fun runPresentationTests(
    owner: NativeLibraryPresentationActivity,
    base: File,
) {
    check(!base.exists() && base.mkdirs())

    fun activity(font: Float = 1f): Activity {
        owner.configure(font)
        return owner
    }
    val cases = JSONArray()
    var failures = 0

    fun checkCase(
        name: String,
        action: () -> Unit,
    ) {
        try {
            action()
            cases.put(JSONObject().put("name", name).put("passed", true))
        } catch (error: Throwable) {
            failures++
            cases.put(
                JSONObject().put("name", name).put("passed", false).put(
                    "error",
                    (error.cause ?: error).javaClass.simpleName + ":" + (error.cause ?: error).message,
                ),
            )
        }
    }
    checkCase("library search is ahead of result rows") {
        val p = Presentation(activity(), false)
        val page = field(p.panel, "pageRoot") as LinearLayout
        val input = nodes(page).filterIsInstance<EditText>().single()
        check(nodes(page.getChildAt(0)).contains(input))
        check(page.indexOfChild(p.body) == 1)
    }
    checkCase("library top search still submits and clears the existing session query") {
        val p = Presentation(activity(), false)
        val page = field(p.panel, "pageRoot") as View
        val input = nodes(page).filterIsInstance<EditText>().single()
        input.setText("synthetic query")
        input.onEditorAction(android.view.inputmethod.EditorInfo.IME_ACTION_SEARCH)
        check(
            p.requests
                .last { it.first == "action.libraryPage" }
                .second
                .getJSONObject("session")
                .getString("keyword") == "synthetic query",
        )
        nodes(page).first { it.contentDescription?.toString() == "清除搜索" }.performClick()
        input.onEditorAction(android.view.inputmethod.EditorInfo.IME_ACTION_SEARCH)
        check(input.text.isEmpty())
        check(
            p.requests
                .last { it.first == "action.libraryPage" }
                .second
                .getJSONObject("session")
                .getString("keyword")
                .isEmpty(),
        )
    }
    checkCase("search keeps its first slot during loading and failure") {
        val p = Presentation(activity(), false)
        val page = field(p.panel, "pageRoot") as LinearLayout
        val input = nodes(page).filterIsInstance<EditText>().single()
        p.hold = true
        invoke(p.panel, "load", false, false)
        check(nodes(page.getChildAt(0)).contains(input))
        invoke(p.panel, "showFailure", "query_failed")
        check(nodes(page.getChildAt(0)).contains(input))
    }
    checkCase("reading heading replaces status with classification tags exactly once") {
        val p = Presentation(activity(), true)
        val row = p.row()
        val heading = nodes(row).filterIsInstance<NativeBookHeading>().single()
        check(heading.childCount == 2)
        check((heading.getChildAt(1) as TextView).text.toString() == "文学 · 小说 · 合成分类")
        check(texts(row).count { it.contains("文学") } == 1)
        check(texts(row).none { it == "在读" || it.startsWith("标签:") })
    }
    checkCase("reading heading with no tags has no status or fabricated tag slot") {
        val p = Presentation(activity(), true)
        val row = p.row(sample().put("tags", JSONArray()))
        check(nodes(row).filterIsInstance<NativeBookHeading>().single().childCount == 1)
        check(texts(row).none { it == "在读" || it.startsWith("标签:") })
    }
    checkCase("long reading tags wrap without consuming the title across a width roundtrip") {
        val p = Presentation(activity(), true)
        val row = p.row(sample().put("tags", JSONArray().put("合成分类标签名称较长用于换行检查").put("第二个较长分类标签").put("第三个分类标签")))
        val heading = nodes(row).filterIsInstance<NativeBookHeading>().single()
        for (width in listOf(992, 320, 992)) {
            val w = NativeUi.dp(p.activity, width)
            row.measure(
                View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED),
            )
            row.layout(0, 0, w, row.measuredHeight)
            val title = heading.getChildAt(0) as TextView
            val labels = heading.getChildAt(1) as TextView
            check(title.width > 0 && labels.width > 0) { "width=$width; title=${title.width}; tags=${labels.width}" }
            check(labels.lineCount > 1) { "width=$width; tagLines=${labels.lineCount}" }
            check((0 until labels.lineCount).all { labels.layout.getEllipsisCount(it) == 0 }) { "width=$width; tag text ellipsized" }
            // Different font sizes share a first-line baseline, not identical top edges.
            if (width ==
                992
            ) {
                check(labels.left > title.left && labels.top + labels.baseline == title.top + title.baseline) {
                    "width=$width; title=[${title.left},${title.top},${title.right},${title.bottom}]; tags=[${labels.left},${labels.top},${labels.right},${labels.bottom}]"
                }
            }
        }
    }
    checkCase("library row retains its existing status format and tags") {
        val p = Presentation(activity(), false)
        val row = texts(p.row())
        check(row.any { it.contains("在读") && it.contains("25%") })
        check(row.any { it.contains("EPUB") && it.contains("文学") })
    }
    checkCase("library row renders author publisher and normalized publication date") {
        val p = Presentation(activity(), false)
        val row = texts(p.row())
        check(row.any { it.contains("合成作者") && it.contains("合成出版社") && it.contains("2021-03-04") })
    }
    checkCase("missing publisher/date does not leave dangling separators or literal null") {
        val p = Presentation(activity(), false)
        val row = texts(p.row(sample().put("publisher", JSONObject.NULL).put("publicationDate", JSONObject.NULL)))
        val author = row.first { it.contains("合成作者") }
        check(author == "合成作者")
    }
    checkCase("reading last-read duration and percentage share one text node") {
        val p = Presentation(activity(), true)
        val row = p.row()
        check(
            texts(row).any {
                it.contains("上次读过") && it.contains("累计") &&
                    it.contains("25%")
            },
        )
        check(nodes(row).none { it is ProgressBar })
        check(texts(row).count { it.contains("25%") } == 1)
    }
    checkCase("unknown progress and duration are not fabricated as zero") {
        val p = Presentation(activity(), true)
        val row = texts(p.row(sample().put("progress", JSONObject.NULL).put("readingSeconds", JSONObject.NULL).put("lastReadAt", 0)))
        check(row.any { it.contains("尚无阅读进度") })
        check(row.none { it.contains("0%") || it.contains("累计") })
    }
    checkCase("positive sub-minute duration is labelled honestly") {
        val p = Presentation(activity(), true)
        check(texts(p.row(sample().put("readingSeconds", 17))).any { it.contains("不足1 min") })
    }
    checkCase("library summary follows title rather than repeating in body") {
        val p = Presentation(activity(), false)
        check(
            p.header.text
                .toString()
                .startsWith("藏书  1 本/篇"),
        )
        check(p.header.text.contains("1 min"))
        check(texts(p.body).none { it.contains("累计阅读") })
    }
    checkCase("old controller generation cannot replace the current summary") {
        val p = Presentation(activity(), false)
        val before = p.header.text.toString()
        assign(p.controller, "generation", 4L)
        check(p.summary(0L, "999 stale"))
        check(p.header.text.toString() == before)
    }
    checkCase("summary cannot leak to reading page or disposed owner") {
        val p = Presentation(activity(), false)
        val before = p.header.text.toString()
        assign(p.controller, "page", "reading")
        check(p.summary(0L, "stale"))
        check(p.header.text.toString() == before)
        assign(p.controller, "page", "library")
        assign(p.controller, "disposed", true)
        check(p.summary(0L, "stale"))
        check(p.header.text.toString() == before)
    }
    checkCase("sole nonempty category remains visible and zero counts are hidden") {
        val p = Presentation(activity(), false)
        val visible = texts(p.body)
        check(visible.any { it == "类别A (1)" })
        check(visible.none { it.contains("空类别") })
        check(visible.any { it.contains("全库数量") })
    }
    checkCase("zero category counts do not appear as active chips") {
        val p = Presentation(activity(), false, withZero = true)
        check(texts(p.body).any { it == "类别A (1)" })
        check(texts(p.body).none { it.contains("空类别") })
    }
    checkCase("invalid category count fails visibly rather than pretending empty data") {
        val p = Presentation(activity(), false)
        p.hold = true
        invoke(p.panel, "load", false, false)
        p.pending.single()(p.page(categoryCount = -1), null)
        check(!p.panel.canOperate() && p.header.text.toString() == "藏书")
        check(texts(p.panel.notice).any { it.contains("invalid_response") })
    }
    checkCase("body toolbar moves to guarded More actions without deleting capabilities") {
        val p = Presentation(activity(), false)
        check(p.actions().map { it.first } == listOf("排序", "筛选", "管理"))
        val visible = nodes(p.body).filterIsInstance<Button>().map { it.text.toString() }
        check(
            visible.none {
                it in
                    listOf("排序", "筛选", "管理")
            },
        )
    }
    checkCase("old More actions cannot open or modify a newer panel epoch") {
        val p = Presentation(activity(), false)
        val actions = p.actions()
        check(actions.size == 3)
        val before = p.requests.size
        val beforeDialogs = p.dialogs
        assign(p.panel, "epoch", 99L)
        actions.forEach { it.second() }
        check(p.requests.size == before)
        check(p.dialogs == beforeDialogs && p.dialogs.none { it.isShowing })
    }
    checkCase("nested page-size choice cannot change a newer session") {
        val p = Presentation(activity(), false)
        p.actions().last().second()
        p.dialogs
            .single()
            .listView
            .performItemClick(null, 0, 0)
        val size = p.dialogs.single { it.isShowing }
        val state = field(p.panel, "state") as NativeLibraryUiState
        val beforeSession = state.library.toString()
        val beforeRequests = p.requests.size
        assign(p.panel, "epoch", 99L)
        size.listView.performItemClick(null, 1, 1)
        check(state.library.toString() == beforeSession && p.requests.size == beforeRequests)
        p.dialogs.forEach { it.dismiss() }
    }
    for (which in listOf(AlertDialog.BUTTON_POSITIVE, AlertDialog.BUTTON_NEUTRAL)) {
        checkCase("stale advanced ${if (which == AlertDialog.BUTTON_POSITIVE) "apply" else "clear"} cannot commit") {
            val p = Presentation(activity(), false)
            p.actions()[1].second()
            val dialog = p.dialogs.single()
            val state = field(p.panel, "state") as NativeLibraryUiState
            val beforeSession = state.library.toString()
            val beforeRequests = p.requests.size
            assign(p.panel, "epoch", 99L)
            dialog.getButton(which).performClick()
            check(state.library.toString() == beforeSession && p.requests.size == beforeRequests)
            p.dialogs.forEach { it.dismiss() }
        }
    }
    checkCase("stale nested tag adoption and outer apply cannot commit session") {
        val p = Presentation(activity(), false)
        p.actions()[1].second()
        val parent = p.dialogs.single()
        nodes(parent.window!!.decorView).filterIsInstance<Button>().first { it.text.startsWith("主题 / 特征") }.performClick()
        val tags = p.dialogs.first { it !== parent }
        tags.listView.performItemClick(null, 0, 0)
        val state = field(p.panel, "state") as NativeLibraryUiState
        val beforeSession = state.library.toString()
        val beforeRequests = p.requests.size
        assign(p.panel, "epoch", 99L)
        tags.getButton(AlertDialog.BUTTON_POSITIVE).performClick()
        parent.getButton(AlertDialog.BUTTON_POSITIVE).performClick()
        check(state.library.toString() == beforeSession && p.requests.size == beforeRequests)
        p.dialogs.forEach { it.dismiss() }
    }
    checkCase("reading body is compact but original capabilities move to More") {
        val p = Presentation(activity(), true)
        val visible = texts(p.root)
        check(visible.none { it.contains("快速接续") || it.contains("筛选与管理") })
        check(p.actions().map { it.first } == listOf("筛选", "显示数量", "管理 / 多选"))
    }
    checkCase("loading and failure clear header summary while retaining error/back safety") {
        val p = Presentation(activity(), false)
        p.hold = true
        invoke(p.panel, "load", false, false)
        check(p.header.text.toString() == "藏书")
        invoke(p.panel, "showFailure", "library_database_corrupt")
        check(p.header.text.toString() == "藏书")
        check(!p.panel.canOperate() && p.panel.canLeave())
    }
    checkCase("late page reply does not overwrite new header summary") {
        val p = Presentation(activity(), false)
        p.hold = true
        invoke(p.panel, "load", false, false)
        invoke(p.panel, "load", false, false)
        check(p.pending.size == 2)
        p.pending[1](p.page(count = 1), null)
        val before = p.header.text.toString()
        p.pending[0](p.page(count = 999), null)
        check(p.header.text.toString() == before && !before.contains("999"))
    }
    checkCase("category change resets page/order and old selection through existing session command") {
        val p = Presentation(activity(), false)
        val state = field(p.panel, "state") as NativeLibraryUiState
        state.selected.add("synthetic-book")
        state.library.put("page", 4)
        p.hold =
            true
        val button = nodes(p.body).filterIsInstance<Button>().first { it.text.toString() == "类别A (1)" }
        button.performClick()
        check(state.selected.isEmpty())
        val saved =
            p.requests
                .last {
                    it.first ==
                        "action.librarySessionSave"
                }.second
                .getJSONObject("session")
        ;check(saved.getInt("page") == 1 && saved.getJSONArray("orderedBookIds").length() == 0)
    }
    checkCase("empty library has no fake category chips") {
        val p = Presentation(activity(), false, true)
        check(texts(p.body).none { it.contains("类别A") || it.contains("空类别") })
        check(p.header.text.contains("0 本/篇"))
    }
    val renderCases =
        listOf(false, true).flatMap { reading ->
            listOf(320 to 1f, 992 to 1f, 320 to 1.8f).map { Triple(reading, it.first, it.second) }
        }
    val main = android.os.Handler(Looper.getMainLooper())
    val renderEvidence = JSONArray()

    fun renderNext(index: Int) {
        if (index == renderCases.size) {
            File(base, "result.json").writeText(
                JSONObject()
                    .put("passed", failures == 0)
                    .put("failures", failures)
                    .put("cases", cases)
                    .put("renders", renderEvidence)
                    .put("runtimeApi", android.os.Build.VERSION.SDK_INT)
                    .put("testPackage", owner.packageName)
                    .put("uid", android.os.Process.myUid())
                    .put(
                        "runtime",
                        "API32 real test Activity, production Views and controlled transport; not the production APK or physical panel",
                    ).toString(),
            )
            owner.finish()
            return
        }
        main.post {
            val (reading, width, font) = renderCases[index]
            val p = Presentation(activity(font), reading)
            // This runs after the production metadata queue has delivered its first synthetic card.
            main.post {
                val mode = if (reading) "reading" else "library"
                checkCase("render hydrated $mode width-$width font-$font") {
                    val w = NativeUi.dp(p.activity, width)
                    val h = NativeUi.dp(p.activity, if (width > 500) 560 else 800)
                    p.root.measure(
                        View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY),
                        View.MeasureSpec.makeMeasureSpec(h, View.MeasureSpec.EXACTLY),
                    )
                    p.root.layout(0, 0, w, h)
                    val ellipsis = (0 until p.header.lineCount).map { p.header.layout.getEllipsisCount(it) }
                    val byline =
                        nodes(p.body).filterIsInstance<TextView>().first {
                            it.text.contains("合成出版社") &&
                                it.text.contains("2021-03-04")
                        }
                    val wordWidth = byline.paint.measureText("合成作者")
                    renderEvidence.put(
                        JSONObject()
                            .put("mode", mode)
                            .put("widthDp", width)
                            .put("fontScale", font)
                            .put("headerText", p.header.text.toString())
                            .put("headerWidth", p.header.width)
                            .put("headerHeight", p.header.height)
                            .put("lineCount", p.header.lineCount)
                            .put("ellipsis", JSONArray(ellipsis))
                            .put("bylineWidth", byline.width)
                            .put("minimumWordWidth", wordWidth),
                    )
                    val bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
                    bitmap.eraseColor(Color.WHITE)
                    p.root.draw(Canvas(bitmap))
                    File(base, "$mode-$width-$font.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
                    bitmap.recycle()
                    check(p.header.width > 0 && p.header.height > 0) { "header geometry invalid" }
                    if (!reading) check(ellipsis.all { it == 0 }) { "header ellipsis: $ellipsis; lines=${p.header.lineCount}" }
                    check(byline.width >= wordWidth) { "metadata squeezed to ${byline.width}px below one author word ${wordWidth}px" }
                    check(texts(p.body).any { it.contains("合成出版社") && it.contains("2021-03-04") }) { "hydrated metadata absent" }
                }
                renderNext(index + 1)
            }
        }
    }
    renderNext(0)
}
