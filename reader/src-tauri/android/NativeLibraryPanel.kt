package io.pagewise.reader

import android.app.Activity
import android.app.AlertDialog
import android.graphics.Rect
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject

internal fun nativeLibraryCanAct(
    closed: Boolean,
    failed: Boolean,
    loading: Boolean,
    mutating: Boolean,
    navigating: Boolean,
    fatalDatabase: Boolean,
) = !closed && !failed && !loading && !mutating && !navigating && !fatalDatabase

internal class NativeLibrarySearch {
    private var desired: String? = null
    private var inFlight = false
    private var closed = false
    val hasPending: Boolean get() = desired != null
    val canLeave: Boolean get() = desired == null && !inFlight

    fun edit(value: String) {
        if (!closed) desired = value
    }

    fun take(
        current: String,
        busy: Boolean,
    ): String? {
        if (closed || busy || inFlight) return null
        val value = desired ?: return null
        desired = null
        if (value == current) return null
        inFlight = true
        return value
    }

    fun settled() {
        inFlight = false
    }

    fun close() {
        closed = true
        desired = null
        inFlight = false
    }
}

/** UI selection/filter state only. Existing services/SQLite remain the sole persistent owners. */
internal class NativeLibraryUiState {
    var library = JSONObject()
    var reading = JSONObject()
    var mode = ""
    var tab = "reading"
    var manage = false
    var returnToId = ""
    var outcomeUnknown = false
    val selected = linkedSetOf<String>()
}

internal class NativeLibraryPanel(
    private val activity: Activity,
    private val request: (String, JSONObject, NativePageReply) -> Unit,
    private val ink: Int,
    private val english: Boolean,
    private val reading: Boolean,
    private val state: NativeLibraryUiState,
    private val makeButton: (String, () -> Unit) -> Button,
    private val makeCard: (JSONObject, () -> Unit, () -> Unit) -> View,
    private val openReader: (JSONObject) -> Unit,
    private val openDetails: (JSONObject) -> Unit,
    private val userAction: (String) -> Unit,
    private val repaint: () -> Unit,
    private val onFailure: () -> Unit = {},
    private val onSummary: (String?) -> Unit = {},
) {
    private val main = Handler(Looper.getMainLooper())
    private val root = column()
    private val pageRoot = column()
    private var keywordInput: EditText? = null
    private val keywordSearch = NativeLibrarySearch()
    private val searchCommit = Runnable { commitSearch() }
    private val status = text("")
    private val dialogs = linkedSetOf<AlertDialog>()
    private var closed = false
    private var loading = false
    private var failed = false
    private var fatalDatabase = false
    private val retry by lazy {
        makeButton(tr("重新加载", "Reload")) {
            if (!closed && !loading && !mutating && !navigating && !fatalDatabase) load()
        }.apply { visibility = View.GONE }
    }
    val notice: View by lazy {
        column().apply {
            addView(status)
            addView(retry)
            status.addTextChangedListener(
                object : TextWatcher {
                    override fun beforeTextChanged(
                        s: CharSequence?,
                        start: Int,
                        count: Int,
                        after: Int,
                    ) = Unit

                    override fun onTextChanged(
                        s: CharSequence?,
                        start: Int,
                        before: Int,
                        count: Int,
                    ) {
                        visibility =
                            if (s.isNullOrEmpty()) View.GONE else View.VISIBLE
                    }

                    override fun afterTextChanged(s: Editable?) = Unit
                },
            )
        }
    }
    private var mutating = false
    private var navigating = false
    private var epoch = 0L
    private var current = JSONObject()
    private var defaults = JSONObject()
    private val selectionStatus = text("")
    private var batch: NativeSelectionBatch? = null
    private val session: JSONObject get() = if (reading) state.reading else state.library

    private fun tr(
        zh: String,
        en: String,
    ) = if (english) en else zh

    private fun column() = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }

    private fun text(
        value: String,
        size: Float = 16f,
        bold: Boolean = false,
    ) = TextView(activity).apply {
        this.text = value
        textSize = size
        setTextColor(ink)
        setPadding(4, 10, 4, 10)
        if (bold) setTypeface(null, android.graphics.Typeface.BOLD)
    }

    private fun canAct() = nativeLibraryCanAct(closed, failed, loading, mutating, navigating, fatalDatabase)

    private fun button(
        value: String,
        action: () -> Unit,
    ) = makeButton(value) {
        if (canAct()) {
            action()
        }
    }

    private fun controls(
        parent: LinearLayout,
        values: List<Pair<String, () -> Unit>>,
    ) {
        val row = NativeActionFlow(activity)
        values.forEach { row.addView(button(it.first, it.second)) }
        parent.addView(row)
    }

    private fun tabs(
        parent: LinearLayout,
        values: List<Pair<String, () -> Unit>>,
        selected: Int = 0,
    ) {
        val row = LinearLayout(activity)
        values.forEachIndexed { index, (title, action) ->
            row.addView(
                button(title, action).apply {
                    isSelected = index == selected
                    if (isSelected) {
                        setTypeface(null, android.graphics.Typeface.BOLD)
                        background =
                            NativeUi.shape(
                                activity,
                                if (ink ==
                                    android.graphics.Color.BLACK
                                ) {
                                    android.graphics.Color.BLACK
                                } else {
                                    android.graphics.Color.WHITE
                                },
                            )
                        setTextColor(
                            if (ink ==
                                android.graphics.Color.BLACK
                            ) {
                                android.graphics.Color.WHITE
                            } else {
                                android.graphics.Color.BLACK
                            },
                        )
                    }
                },
                LinearLayout.LayoutParams(-2, -2).apply {
                    marginEnd =
                        NativeUi.dp(activity, 6)
                },
            )
        }
        parent.addView(
            android.widget.HorizontalScrollView(activity).apply {
                isHorizontalScrollBarEnabled = false
                addView(row)
            },
        )
    }

    private fun track(dialog: AlertDialog): AlertDialog {
        if (closed || failed) return dialog
        dialogs.add(dialog)
        dialog.setOnDismissListener { dialogs.remove(dialog) }
        dialog.show()
        return dialog
    }

    private fun settled(
        action: String,
        payload: JSONObject = JSONObject(),
        reply: NativePageReply,
    ) {
        try {
            request(action, payload) { result, error -> activity.runOnUiThread { reply(result, error) } }
        } catch (
            _: Exception,
        ) {
            reply(null, "request_outcome_unknown")
        }
    }

    private fun ask(
        action: String,
        payload: JSONObject = JSONObject(),
        reply: NativePageReply,
    ) {
        settled(action, payload) { result, error ->
            if (!closed) {
                reply(result, error)
                if (unsafeDatabase(error)) showFailure(error!!)
                repaint()
            }
        }
    }

    private fun installSearch() {
        if (reading || keywordInput != null) return
        val input =
            EditText(activity).apply {
                setText(session.optString("keyword"))
                setTextColor(ink)
                setHintTextColor(ink)
                hint = tr("搜索书名、作者、标签", "Search title, author, tags")
                isSingleLine = true
                imeOptions = EditorInfo.IME_ACTION_SEARCH
            }
        keywordInput = input
        val row = LinearLayout(activity).apply { gravity = android.view.Gravity.CENTER_VERTICAL }
        row.addView(input, LinearLayout.LayoutParams(0, -2, 1f))
        val clear =
            NativeUi.iconButton(
                activity,
                tr("清除搜索", "Clear search"),
                "close",
                ink,
                if (ink ==
                    android.graphics.Color.BLACK
                ) {
                    android.graphics.Color.WHITE
                } else {
                    android.graphics.Color.BLACK
                },
            ) { input.setText("") }
        clear.visibility = if (input.text.isEmpty()) View.GONE else View.VISIBLE
        row.addView(clear)
        input.addTextChangedListener(
            object : TextWatcher {
                override fun beforeTextChanged(
                    s: CharSequence?,
                    start: Int,
                    count: Int,
                    after: Int,
                ) = Unit

                override fun onTextChanged(
                    s: CharSequence?,
                    start: Int,
                    before: Int,
                    count: Int,
                ) {
                    if (closed) return
                    clear.visibility = if (s.isNullOrEmpty()) View.GONE else View.VISIBLE
                    keywordSearch.edit(s?.toString() ?: "")
                    main.removeCallbacks(searchCommit)
                    main.postDelayed(searchCommit, 250)
                }

                override fun afterTextChanged(s: Editable?) = Unit
            },
        )
        input.setOnEditorActionListener { _, action, _ ->
            if (action ==
                EditorInfo.IME_ACTION_SEARCH
            ) {
                main.removeCallbacks(searchCommit)
                keywordSearch.edit(input.text.toString())
                commitSearch()
                true
            } else {
                false
            }
        }
        pageRoot.addView(row, 0)
    }

    private fun disableOldResult(view: View = root) {
        view.isEnabled = false
        if (view is ViewGroup) for (i in 0 until view.childCount) disableOldResult(view.getChildAt(i))
    }

    private fun unsafeDatabase(code: String?) =
        code in
            setOf(
                "library_database_corrupt",
                "library_database_missing",
                "library_schema_mismatch",
                "canonical_state_missing",
                "native_state_schema_mismatch",
            )

    private fun showFailure(code: String) {
        epoch++
        failed = true
        loading = false
        keywordSearch.settled()
        fatalDatabase = fatalDatabase || unsafeDatabase(code)
        status.text = if (fatalDatabase) {
            tr(
                "书库数据异常，已停止本页写入。请先保留备份，勿清数据或反复重试。",
                "Library data is unsafe. Writes on this page are blocked. Preserve a backup; do not clear data or repeatedly retry.",
            )
        } else {
            tr("加载未成功；下面是上次结果，不能继续操作。请重新加载。", "Load failed; the previous results below are inactive. Reload to continue.")
        } + " [$code]"
        notice.visibility = View.VISIBLE
        status.accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_ASSERTIVE
        retry.visibility = if (fatalDatabase) View.GONE else View.VISIBLE
        keywordInput?.isEnabled = false
        disableOldResult()
        dialogs.forEach { dialog ->
            dialog.getButton(AlertDialog.BUTTON_POSITIVE)?.isEnabled = false
            dialog.getButton(AlertDialog.BUTTON_NEUTRAL)?.isEnabled = false
            dialog.listView?.isEnabled = false
        }
        onSummary(null)
        onFailure()
    }

    private fun commitSearch() {
        if (closed || loading || mutating || navigating || failed) return
        val value = keywordSearch.take(session.optString("keyword"), loading || mutating || navigating) ?: return
        session.put("keyword", value)
        filtersChanged()
    }

    private fun resumeSearchWhenIdle() {
        if (!closed && !loading && !mutating && !navigating && !failed && keywordSearch.hasPending) {
            main.removeCallbacks(searchCommit)
            main.post(searchCommit)
        }
    }

    fun render(): View {
        onSummary(null)
        pageRoot.addView(root)
        val mode = if (reading) "reading" else "library"
        if (state.mode != mode) {
            state.mode = mode
            state.manage = false
            state.selected.clear()
        }
        ask("action.librarySessionGet") { result, error ->
            if (error != null || result == null) {
                showFailure(error ?: "invalid_response")
                return@ask
            }
            defaults = JSONObject(result.getJSONObject("defaults").toString())
            val saved = JSONObject(result.getJSONObject("session").toString()).apply { remove("unavailableReturn") }
            if (!reading) state.library = saved
            if (state.returnToId.isNotEmpty() &&
                saved.optString("lastViewedBookId").isNotEmpty()
            ) {
                state.returnToId = saved.getString("lastViewedBookId")
            }
            installSearch()
            load(restore = state.returnToId.isNotEmpty())
        }
        return pageRoot
    }

    private fun load(
        persist: Boolean = false,
        restore: Boolean = false,
    ) {
        if (closed || fatalDatabase) return
        val token = ++epoch
        onSummary(null)
        loading = true
        failed = false
        notice.visibility = View.VISIBLE
        retry.visibility = View.GONE
        keywordInput?.isEnabled = true
        disableOldResult()
        status.text = tr("正在检索书库…", "Querying library…")

        fun query() {
            ask(
                "action.libraryPage",
                JSONObject()
                    .put(
                        "mode",
                        if (reading) "reading" else "library",
                    ).put("tab", state.tab)
                    .put("session", session)
                    .put("restore", restore),
            ) { result, error ->
                if (token != epoch) return@ask
                loading = false
                keywordSearch.settled()
                if (error != null || result == null || !result.optBoolean("ok")) {
                    showFailure(error ?: "invalid_response")
                    return@ask
                }

                fun present(value: JSONObject) {
                    if (closed || token != epoch) return
                    loading = false
                    try {
                        current = value
                        val next = JSONObject(value.getJSONObject("session").toString()).apply { remove("unavailableReturn") }
                        if (reading) state.reading = next else state.library = next
                        draw(value, token)
                    } catch (_: org.json.JSONException) {
                        showFailure("invalid_response")
                    }
                    resumeSearchWhenIdle()
                    repaint()
                }
                try {
                    if (reading && result.optInt("page", 1) > 1) collectReadingPages(result, token, ::present) else present(result)
                } catch (_: org.json.JSONException) {
                    showFailure("invalid_response")
                    resumeSearchWhenIdle()
                }
            }
        }
        if (persist && !reading) {
            ask("action.librarySessionSave", JSONObject().put("session", session)) { _, error ->
                if (token != epoch) return@ask
                if (error != null) {
                    loading = false
                    keywordSearch.settled()
                    showFailure(error)
                    return@ask
                }
                query()
            }
        } else {
            query()
        }
    }

    private fun collectReadingPages(
        last: JSONObject,
        token: Long,
        present: (JSONObject) -> Unit,
    ) {
        loading = true
        val all = linkedMapOf<String, JSONObject>()
        val lastPage = last.getInt("page")
        val prefixSession = JSONObject(last.getJSONObject("session").toString())
        var selectionToken = last.getString("selectionToken")
        var page = 1

        fun fail(code: String) {
            showFailure(code)
            repaint()
        }

        fun next() {
            if (closed || epoch != token) return
            if (page == lastPage) {
                try {
                    val tail = last.getJSONArray("items")
                    for (i in 0 until tail.length()) {
                        val item = tail.getJSONObject(i)
                        all[item.getString("id")] = item
                    }
                    val expected = minOf(last.getLong("total"), lastPage.toLong() * last.getInt("pageSize"))
                    if (all.size.toLong() != expected) {
                        fail("reading_catalog_changed_refresh_required")
                        return
                    }
                    present(JSONObject(last.toString()).put("items", JSONArray(all.values.toList())).put("selectionToken", selectionToken))
                } catch (_: org.json.JSONException) {
                    fail("invalid_response")
                }
                return
            }
            status.text = tr("正在加载此前页面：", "Loading preceding pages: ") + "$page / $lastPage"
            ask(
                "action.libraryPage",
                JSONObject()
                    .put(
                        "mode",
                        "reading",
                    ).put("tab", state.tab)
                    .put("session", JSONObject(prefixSession.toString()).put("page", page))
                    .put("restore", false),
            ) { value, error ->
                if (closed || token != epoch) return@ask
                if (error != null || value?.optBoolean("ok") != true) {
                    fail(error ?: "invalid_response")
                    return@ask
                }
                try {
                    if (value.getInt("total") != last.getInt("total")) {
                        fail("reading_catalog_changed_refresh_required")
                        return@ask
                    }
                    val items = value.getJSONArray("items")
                    for (i in 0 until items.length()) {
                        val item = items.getJSONObject(i)
                        all[item.getString("id")] = item
                    }
                    selectionToken = value.getString("selectionToken")
                    page++
                    main.post { next() }
                } catch (_: org.json.JSONException) {
                    fail("invalid_response")
                }
            }
        }
        next()
    }

    private fun filtersChanged() {
        session.put("page", 1).put("orderedBookIds", JSONArray()).put("returnedFromReader", false)
        session.remove("lastViewedBookId")
        state.returnToId =
            ""
        state.selected.clear()
        load(persist = true)
    }

    private fun choose(
        title: String,
        values: List<Pair<String, String>>,
        action: (String) -> Unit,
    ) {
        if (values.isEmpty() || !canAct()) return
        val owner = epoch
        track(
            AlertDialog
                .Builder(activity)
                .setTitle(title)
                .setItems(
                    values
                        .map {
                            it.second
                        }.toTypedArray(),
                ) { _, index -> if (owner == epoch && canAct()) action(values[index].first) }
                .setNegativeButton(tr("取消", "Cancel"), null)
                .create(),
        )
    }

    fun menuActions(): List<Pair<String, () -> Unit>> {
        if (!canAct()) return emptyList()
        val facets = current.optJSONObject("facets") ?: return emptyList()
        val owner = epoch
        val commands =
            listOf<Pair<String, () -> Unit>>(
                tr("排序", "Sort") to {
                    choose(
                        tr("排序", "Sort"),
                        listOf(
                            "added" to tr("加入时间", "Added"),
                            "recent" to tr("最近阅读", "Last read"),
                            "published" to tr("出版时间", "Publication"),
                            "title" to tr("书名", "Title"),
                            "author" to tr("作者", "Author"),
                            "progress" to tr("进度", "Progress"),
                        ),
                    ) {
                        session.put("sortBy", it)
                        filtersChanged()
                    }
                },
                tr("筛选", "Filters") to { advanced(facets) },
                tr("显示数量", "Page size") to {
                    choose(tr("每页数量", "Page size"), listOf("12" to "12", "24" to "24")) {
                        session.put("pageSize", it.toInt())
                        filtersChanged()
                    }
                },
                tr("管理 / 多选", "Manage / select") to {
                    state.manage = !state.manage
                    state.selected.clear()
                    load()
                },
            )
        val management =
            commands.drop(2) +
                listOf(
                    tr("导入", "Import") to { userAction("importBooks") },
                    tr("文件夹", "Folder") to { userAction("selectFolder") },
                    tr("重新扫描", "Rescan") to { userAction("recheckFolder") },
                )
        val actions =
            if (reading) {
                commands.drop(1)
            } else {
                commands.take(2) +
                    listOf(
                        tr("管理", "Manage") to {
                            choose(tr("管理", "Manage"), management.mapIndexed { index, entry -> index.toString() to entry.first }) {
                                management[it.toInt()].second()
                            }
                        },
                    )
            }
        return actions.map { action -> action.first to { if (owner == epoch && canAct()) action.second() } }
    }

    private fun draw(
        result: JSONObject,
        token: Long,
    ) {
        root.removeAllViews()
        root.isEnabled = true
        failed = false
        keywordInput?.isEnabled = true
        retry.visibility = View.GONE
        status.text =
            if (state.outcomeUnknown) {
                tr(
                    "上次批量结果未确认；不自动重放。请保留应用并核对。",
                    "Previous batch outcome is unconfirmed; it will not be replayed.",
                )
            } else {
                ""
            }
        notice.visibility = if (status.text.isEmpty()) View.GONE else View.VISIBLE
        onSummary(
            if (reading) {
                null
            } else {
                "${result.getInt("allCount")} " + tr("本/篇", "books/papers") + " · " + tr("累计阅读", "Cumulative reading") +
                    " ${(result.getDouble("readingSeconds") / 60).toInt()} min"
            },
        )
        if (reading) {
            val counts = result.getJSONObject("tabCounts")
            tabs(
                root,
                listOf(
                    "reading" to tr("在读", "Reading"),
                    "recent" to tr("最近", "Recent"),
                    "wanted" to tr("想读", "Wanted"),
                    "paused" to tr("暂缓", "Paused"),
                    "finished" to tr("已读", "Finished"),
                    "abandoned" to tr("弃读", "Abandoned"),
                ).map { (id, label) ->
                    (if (id == "recent") tr("最近阅读", "Recent reading") else "$label (${counts.getInt(id)})") to
                        {
                            state.tab = id
                            session.put("page", 1)
                            state.selected.clear()
                            load()
                        }
                },
                listOf("reading", "recent", "wanted", "paused", "finished", "abandoned").indexOf(state.tab),
            )
        }
        if (!reading) {
            val values = result.getJSONObject("facets").getJSONArray("categoryFilter")
            val categories =
                (0 until values.length()).map { values.getJSONObject(it) }.filter {
                    val count = it.getInt("count")
                    if (count < 0) throw org.json.JSONException("invalid_category_count")
                    count > 0
                }
            if (categories.isNotEmpty()) {
                root.addView(text(tr("类别（全库数量）", "Categories (library totals)"), 13f))
                tabs(
                    root,
                    listOf(
                        (tr("全部", "All") + " (${result.getInt("allCount")})") to {
                            session.put("categoryFilter", "")
                            filtersChanged()
                        },
                    ) +
                        categories.map { category ->
                            "${category.getString("label")} (${category.getInt("count")})" to {
                                session.put("categoryFilter", category.getString("value"))
                                filtersChanged()
                            }
                        },
                    if (session.optString("categoryFilter").isEmpty()) {
                        0
                    } else {
                        1 +
                            categories.indexOfFirst {
                                it.getString("value") == session.optString("categoryFilter")
                            }
                    },
                )
            }
        }
        val items = result.getJSONArray("items")
        if (state.manage) management(result, items)
        if (items.length() == 0) {
            val emptyLibrary = result.getInt("allCount") == 0
            root.addView(text(if (emptyLibrary) tr("还没有藏书", "Your library is empty") else tr("没有匹配记录。", "No matching records."), 18f, true))
            root.addView(
                text(
                    if (emptyLibrary) {
                        tr(
                            "从管理菜单导入书籍，或添加监控文件夹。",
                            "Import books or add a monitored folder from Manage.",
                        )
                    } else {
                        tr("试试其他关键词、筛选条件或阅读状态。", "Try another search, filter or reading status.")
                    },
                ),
            )
        }
        val metadataQueue = java.util.ArrayDeque<() -> Unit>()
        val advance: () -> Unit = { if (!closed && token == epoch && metadataQueue.isNotEmpty()) metadataQueue.removeFirst().invoke() }
        for (i in 0 until items.length()) {
            val view = items.getJSONObject(i)
            val id = view.getString("id")
            val wrapper = column()
            val check =
                CheckBox(activity).apply {
                    text = tr("选择", "Select") + " · " + view.getString("title")
                    setTextColor(ink)
                    isChecked =
                        id in state.selected
                    visibility = View.GONE
                    setOnCheckedChangeListener {
                        _,
                        checked,
                        ->
                        if (!canAct()) return@setOnCheckedChangeListener
                        if (checked) state.selected.add(id) else state.selected.remove(id)
                        selectionStatus.text = tr("已选择", "Selected") + " ${state.selected.size}"
                        wrapper.getChildAt(wrapper.childCount - 1)?.isSelected = checked
                    }
                }
            wrapper.addView(check)
            val metadata =
                listOf(view.optString("author"), view.optString("publisher"), view.optString("publicationDate"))
                    .filter { it.isNotBlank() && it != "null" }
                    .joinToString(" · ")
            val placeholder = text(view.getString("title") + if (metadata.isEmpty()) "" else "\n$metadata")
            wrapper.addView(placeholder)
            root.addView(wrapper)
            metadataQueue.add {
                ask("library.book", JSONObject().put("id", id)) { metadata, error ->
                    if (token != epoch) return@ask
                    if (error != null ||
                        metadata == null
                    ) {
                        placeholder.text = view.getString("title") + " · " + (error ?: "metadata_unavailable")
                        main.post { advance() }
                        return@ask
                    }
                    val book =
                        metadata
                            .getJSONObject(
                                "book",
                            ).put("effectiveReadingStatus", view.getString("effectiveReadingStatus"))
                            .put("supported", view.getBoolean("supported"))
                    val card =
                        makeCard(book, {
                            if (!book.getBoolean("supported")) {
                                status.text =
                                    tr("此旧格式已停止阅读支持；元数据保留。", "This legacy format is no longer readable; metadata is retained.")
                            } else {
                                remember(id) { openReader(book) }
                            }
                        }, { if (state.manage) check.isChecked = !check.isChecked else remember(id) { openDetails(book) } })
                    wrapper.removeView(placeholder)
                    wrapper.addView(card)
                    if (state.returnToId ==
                        id
                    ) {
                        card.post {
                            if (!closed && token == epoch &&
                                card.isAttachedToWindow
                            ) {
                                card.requestRectangleOnScreen(Rect(0, 0, card.width, card.height), true)
                                state.returnToId =
                                    ""
                            }
                        }
                    }
                    main.post { advance() }
                }
            }
        }
        main.post { advance() }
        val page = result.getInt("page")
        val pages = result.getInt("totalPages")
        if (reading) {
            root.addView(text("${items.length()} / ${result.getInt("total")} " + tr("项", "items")))
            if (page < pages) {
                root.addView(
                    button(tr("显示更多", "Load more")) {
                        session.put("page", page + 1)
                        load()
                    },
                )
            }
            return
        }
        if (result.getInt("total") == 0) return
        root.addView(text("$page / $pages · ${result.getInt("total")} " + tr("项", "items")))
        val pager = LinearLayout(activity)
        pager.addView(
            button(tr("上页", "Previous")) {
                session.put("page", page - 1)
                load(persist = true)
            }.apply { isEnabled = page > 1 },
        )
        pager.addView(
            button(tr("下页", "Next")) {
                session.put("page", page + 1)
                load(persist = true)
            }.apply { isEnabled = page < pages },
        )
        root.addView(pager)
    }

    private fun filterTitle(key: String) =
        when (key) {
            "statusFilter" -> tr("阅读状态", "Reading status")
            "availabilityFilter" -> tr("文件状态", "File availability")
            "classificationStatusFilter" -> tr("分类状态", "Classification status")
            "textbookFilter" -> tr("教材", "Textbook")
            "ancientTextFilter" -> tr("古籍", "Ancient text")
            else -> key
        }

    private fun filterSummary(value: String) =
        when (value) {
            "", "all" -> tr("全部", "All")
            "unmarked" -> tr("未标记", "Unmarked")
            "wanted" -> tr("想读", "Want to read")
            "reading" -> tr("在读", "Reading")
            "paused" -> tr("暂缓", "Paused")
            "finished" -> tr("已读", "Finished")
            "abandoned" -> tr("弃读", "Abandoned")
            "available" -> tr("可用", "Available")
            "unavailable" -> tr("不可用", "Unavailable")
            "missing" -> tr("缺失", "Missing")
            "permission-denied" -> tr("未授权", "Permission denied")
            "complete" -> tr("已分类", "Complete")
            "incomplete" -> tr("待完善", "Incomplete")
            "unclassified" -> tr("未分类", "Unclassified")
            "true" -> tr("是", "Yes")
            "false" -> tr("否", "No")
            "unknown" -> tr("未知", "Unknown")
            else -> value
        }

    private fun advanced(facets: JSONObject) {
        if (!canAct()) return
        val owner = epoch

        fun ownsDraft() = owner == epoch && canAct()

        fun filterButton(
            value: String,
            action: () -> Unit,
        ) = button(value) { if (ownsDraft()) action() }
        val session = JSONObject(this.session.toString()) // Cancel never applies a partially edited filter draft.
        val form = column()
        val options =
            listOf(
                "formatFilter" to tr("格式", "Format"),
                "languageFilter" to tr("语言", "Language"),
                "audienceFilter" to tr("受众", "Audience"),
                "workCountryFilter" to tr("作品国家", "Work country"),
                "workPeriodFilter" to tr("作品时期", "Work period"),
            )
        for ((key, title) in options) {
            form.addView(
                filterButton("$title: ${session.optString(key).ifEmpty { tr("全部", "All") }}") {
                    val values = facets.getJSONArray(key)
                    choose(
                        title,
                        listOf("" to tr("全部", "All")) +
                            (0 until values.length()).map {
                                val v = values.getJSONObject(it)
                                v.getString("value") to
                                    "${v.getString("label")} (${v.getInt("count")})"
                            },
                    ) { session.put(key, it) }
                },
            )
        }
        for ((key, values) in listOf(
            "statusFilter" to listOf("", "unmarked", "wanted", "reading", "paused", "finished", "abandoned"),
            "availabilityFilter" to listOf("", "available", "unavailable", "missing", "permission-denied"),
            "classificationStatusFilter" to listOf("", "complete", "incomplete", "unclassified"),
            "textbookFilter" to listOf("", "true", "false", "unknown"),
            "ancientTextFilter" to listOf("", "true", "false", "unknown"),
        )) {
            form.addView(
                filterButton("${filterTitle(key)}: ${filterSummary(session.optString(key))}") {
                    choose(
                        filterTitle(key),
                        values.map { it to filterSummary(it) },
                    ) { session.put(key, it) }
                },
            )
        }
        form.addView(
            filterButton(tr("主题 / 特征 / 旧标签筛选", "Topic / feature / legacy tag filter")) {
                val tags = facets.getJSONArray("tagFilter")
                val selected =
                    session.optJSONArray("tagFilter") ?: JSONArray()
                val chosen = (0 until selected.length()).map { selected.getString(it) }.toMutableSet()
                val names = Array(tags.length()) { tags.getJSONObject(it).getString("value") }
                track(
                    AlertDialog
                        .Builder(activity)
                        .setTitle(tr("标签", "Tags"))
                        .setMultiChoiceItems(
                            names,
                            BooleanArray(names.size) {
                                names[it] in
                                    chosen
                            },
                        ) { _, i, checked ->
                            if (!ownsDraft()) return@setMultiChoiceItems
                            if (checked) {
                                chosen.add(
                                    names[i],
                                )
                            } else {
                                chosen.remove(
                                    names[i],
                                )
                            }
                        }.setPositiveButton(
                            tr("采用", "Apply"),
                        ) { _, _ ->
                            if (!ownsDraft()) return@setPositiveButton
                            session.put(
                                "tagFilter",
                                JSONArray(chosen.toList()),
                            )
                        }.setNegativeButton(tr("取消", "Cancel"), null)
                        .create(),
                )
            },
        )
        form.addView(
            filterButton(tr("标签条件：", "Tag mode: ") + session.optString("tagMode", "and")) {
                choose(
                    tr("标签条件", "Tag mode"),
                    listOf("and" to "AND", "or" to "OR"),
                ) { session.put("tagMode", it) }
            },
        )
        track(
            AlertDialog
                .Builder(activity)
                .setTitle(tr("高级筛选", "Advanced filters"))
                .setView(
                    ScrollView(activity).apply {
                        addView(form)
                    },
                ).setPositiveButton(
                    tr("应用筛选", "Apply filters"),
                ) { _, _ ->
                    if (!ownsDraft()) return@setPositiveButton
                    if (reading) state.reading = session else state.library = session
                    filtersChanged()
                }.setNeutralButton(tr("清除筛选", "Clear filters")) { _, _ ->
                    if (!ownsDraft()) return@setNeutralButton
                    val reset =
                        JSONObject(
                            defaults.toString(),
                        ).put(
                            "pageSize",
                            session.optInt("pageSize", 12),
                        ).put("orderedBookIds", JSONArray())
                            .put("lastViewedBookId", "")
                            .put("returnedFromReader", false)
                    if (reading) state.reading = reset else state.library = reset
                    keywordInput?.setText(this.session.optString("keyword"))
                    state.selected.clear()
                    load(persist = true)
                }.setNegativeButton(tr("取消", "Cancel"), null)
                .create(),
        )
    }

    private fun ids(
        token: String,
        limit: Int = Int.MAX_VALUE,
        done: (List<String>?, String?) -> Unit,
    ) {
        val all = mutableListOf<String>()

        fun next() {
            ask("action.librarySelectionPage", JSONObject().put("token", token).put("offset", all.size).put("limit", 500)) { value, error ->
                if (error != null || value == null) {
                    done(null, error ?: "invalid_response")
                    return@ask
                }
                val page = value.getJSONArray("ids")
                for (i in 0 until page.length()) if (all.size < limit) all.add(page.getString(i))
                if (all.size < minOf(value.getInt("total"), limit) && page.length() > 0) next() else done(all, null)
            }
        }
        next()
    }

    private fun remember(
        id: String,
        next: () -> Unit,
    ) {
        if (navigating || failed || !canLeave()) return
        val token = epoch
        navigating = true
        val p =
            JSONObject(
                session.toString(),
            ).put("orderedBookIds", JSONArray()).put("lastViewedBookId", id).put("returnedFromReader", true)
        val payload = JSONObject().put("session", p).put("selectionToken", current.getString("selectionToken"))
        ask("action.librarySessionSave", payload) { _, failure ->
            navigating = false
            if (token != epoch || !canAct()) return@ask
            if (failure != null) {
                showFailure(failure)
            } else if (!keywordSearch.hasPending) {
                state.returnToId = id
                state.manage = false
                state.selected.clear()
                next()
            }
            // New typing is a newer stay/search intent; do not navigate with the old open intent.
            resumeSearchWhenIdle()
        }
    }

    private fun management(
        result: JSONObject,
        items: JSONArray,
    ) {
        selectionStatus.text = tr("已选择", "Selected") + " ${state.selected.size}"
        root.addView(selectionStatus)
        controls(
            root,
            listOf(
                tr("选择本页", "Select page") to
                    {
                        for (i in 0 until items.length()) state.selected.add(items.getJSONObject(i).getString("id"))
                        load()
                    },
                tr("选择全部筛选结果", "Select all matches") to
                    {
                        loading = true
                        ids(result.getString("selectionToken")) { selected, error ->
                            loading = false
                            if (error != null ||
                                selected == null
                            ) {
                                status.text = error
                            } else {
                                state.selected.addAll(selected)
                                load()
                            }
                            resumeSearchWhenIdle()
                        }
                    },
                tr("清空选择", "Clear selection") to {
                    state.selected.clear()
                    load()
                },
            ),
        )
        if (state.outcomeUnknown) return
        controls(
            root,
            listOf(
                tr("阅读状态", "Reading status") to
                    {
                        choose(
                            tr("设置阅读状态", "Set reading status"),
                            listOf("unmarked", "wanted", "reading", "paused", "finished", "abandoned").map {
                                it to
                                    it
                            },
                        ) { mutate("status", it) }
                    },
                tr("置顶", "Pin") to { mutate("pin", "true") },
                tr("取消置顶", "Unpin") to { mutate("pin", "false") },
                tr("添加旧标签", "Add legacy tags") to { tagDialog(false) },
                tr("清除分类", "Clear classification") to { tagDialog(true) },
                tr("移除书目", "Remove books") to { confirmRemove() },
            ),
        )
    }

    private fun confirmRemove() {
        if (state.selected.isEmpty()) return
        track(
            AlertDialog
                .Builder(activity)
                .setTitle(tr("确认移除书目", "Confirm removal"))
                .setMessage(
                    "${state.selected.size} " +
                        tr(
                            "本/篇及关联笔记将逐书提交移除；保留实际文件与阅读统计，关联监控文件夹的条目不移除。关闭应用不等于撤销，可能部分完成。",
                            "books/papers and notes are removed per book. Actual files/statistics remain; source-linked books are protected. Closing is not rollback; partial completion is possible.",
                        ),
                ).setNegativeButton(tr("取消", "Cancel"), null)
                .setPositiveButton(tr("确认移除", "Remove")) { _, _ -> mutate("remove", "") }
                .create(),
        )
    }

    private fun mutate(
        operation: String,
        value: String,
    ) {
        if (!canAct() || state.selected.isEmpty() || state.outcomeUnknown) return
        val selected = state.selected.toList()
        val stamp = System.currentTimeMillis()
        mutating = true
        batch =
            NativeSelectionBatch(selected, { task -> main.post { task() } }, { id, reply ->
                settled("library.book", JSONObject().put("id", id)) { result, error ->
                    if (error != null ||
                        result == null
                    ) {
                        reply(if (error == "book_not_found") error else "read:${error ?: "invalid_response"}")
                        return@settled
                    }
                    if (closed) {
                        reply("read:host_closed")
                        return@settled
                    }
                    val book = result.getJSONObject("book")
                    val payload = JSONObject().put("id", id).put("before", book)
                    if (operation !=
                        "remove"
                    ) {
                        payload.put(
                            "patch",
                            JSONObject().apply {
                                if (operation ==
                                    "status"
                                ) {
                                    put("readingStatus", value)
                                } else {
                                    put("pinnedAt", if (value == "true") stamp else JSONObject.NULL)
                                }
                            },
                        )
                    }
                    settled(
                        if (operation ==
                            "remove"
                        ) {
                            "library.bookRemove"
                        } else {
                            "library.bookPatch"
                        },
                        payload,
                    ) { saved, failure ->
                        reply(failure ?: if (saved == null) "commit_outcome_unknown" else null)
                    }
                }
            }, { complete, total ->
                status.text = "$complete / $total"
                repaint()
            }, { results, unknown ->
                val succeeded = results.count { it.second == null }
                results.filter { it.second == null }.forEach { state.selected.remove(it.first) }
                state.outcomeUnknown = unknown

                fun finish(orderError: String? = null) {
                    mutating = false
                    if (!closed) {
                        load()
                        val errors = results.filter { it.second != null }.take(5).joinToString { it.first + ":" + it.second }
                        val orderStatus =
                            if (orderError ==
                                null
                            ) {
                                ""
                            } else {
                                tr("\n置顶提交已确认，但排序刷新未完成：", "\nPin commits confirmed; order refresh incomplete: ") + orderError
                            }
                        report(succeeded, results.size, unknown, errors + orderStatus)
                    }
                }
                if (operation == "pin" && succeeded > 0) {
                    state.library.put("orderedBookIds", JSONArray())
                    settled(
                        "action.librarySessionSave",
                        JSONObject().put("session", JSONObject().put("orderedBookIds", JSONArray())),
                    ) { _, error -> finish(error) }
                } else {
                    finish()
                }
            }).also { it.start() }
    }

    private fun report(
        succeeded: Int,
        total: Int,
        unknown: Boolean,
        errors: String,
    ) {
        track(
            AlertDialog
                .Builder(activity)
                .setTitle(tr("批量结果", "Batch result"))
                .setMessage(
                    "$succeeded / $total " + tr("项已确认成功。", "confirmed successful.") +
                        if (unknown) {
                            tr(
                                " 部分结果未知，未自动重放；请核对。",
                                " Some outcomes are unknown; no replay was attempted.",
                            ) + "\n$errors"
                        } else {
                            "\n$errors"
                        },
                ).setPositiveButton(tr("返回", "Back"), null)
                .create(),
        )
    }

    private fun tagDialog(clear: Boolean) {
        if (!canAct() || state.selected.isEmpty()) return
        val form = column()
        val input =
            EditText(activity).apply {
                inputType = InputType.TYPE_CLASS_TEXT
                hint =
                    tr("逗号或换行分隔", "Comma/newline separated")
            }
        val locked =
            CheckBox(activity).apply {
                text =
                    tr("明确允许清除现有分类、主题、特征及锁定项；保留旧标签。", "Explicitly clear categories/topics/features/locks; retain legacy tags.")
            }
        if (clear) form.addView(locked) else form.addView(input)
        val error = text("")
        form.addView(error)
        val alert =
            AlertDialog
                .Builder(
                    activity,
                ).setTitle(
                    if (clear) tr("清除分类", "Clear classification") else tr("添加旧标签", "Add legacy tags"),
                ).setView(form)
                .setNegativeButton(tr("取消", "Cancel"), null)
                .setPositiveButton(tr("执行", "Apply"), null)
                .create()
        alert.setOnShowListener {
            alert.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                if (!canAct()) return@setOnClickListener
                val tags =
                    input.text
                        .toString()
                        .split(Regex("[,，\\n]+"))
                        .map { it.trim() }
                        .filter { it.isNotEmpty() }
                if ((clear && !locked.isChecked) ||
                    (!clear && tags.isEmpty())
                ) {
                    error.text = "confirmation_or_tags_required"
                    return@setOnClickListener
                }
                alert.dismiss()
                tagBatch(clear, tags)
            }
        }
        track(alert)
    }

    private fun tagBatch(
        clear: Boolean,
        tags: List<String>,
    ) {
        if (!canAct() || state.outcomeUnknown) return
        val selected = state.selected.toList()
        mutating = true
        var succeeded = 0
        var position = 0

        fun finish(
            unknown: Boolean,
            error: String,
        ) {
            mutating = false
            state.outcomeUnknown = unknown
            if (!closed) {
                load()
                report(succeeded, selected.size, unknown, error)
            }
        }

        fun chunk() {
            if (position >= selected.size) {
                finish(false, "")
                return
            }
            val ids = selected.drop(position).take(128)
            val payload = JSONArray()
            var at = 0

            fun collect() {
                if (at == ids.size) {
                    ask(
                        "action.libraryTagBatch",
                        JSONObject()
                            .put(
                                "operation",
                                if (clear) "clear" else "add",
                            ).put("items", payload)
                            .put("tags", JSONArray(tags))
                            .put("confirmLockedChanges", clear),
                    ) { result, failure ->
                        if (failure != null || result == null) {
                            finish(true, failure ?: "commit_outcome_unknown")
                            return@ask
                        }
                        val rows = result.getJSONArray("results")
                        var readFailed = false
                        for (i in 0 until rows.length()) {
                            val row = rows.getJSONObject(i)
                            if (row.optBoolean("ok")) {
                                succeeded++
                                state.selected.remove(row.getString("id"))
                            }
                            if (row.optString("code") ==
                                "book_read_failed"
                            ) {
                                readFailed = true
                            }
                        }
                        if (result.optBoolean("outcomeUnknown") ||
                            readFailed
                        ) {
                            finish(result.optBoolean("outcomeUnknown"), result.toString().take(800))
                        } else {
                            position += ids.size
                            main.post { chunk() }
                        }
                    }
                    return
                }
                ask("library.book", JSONObject().put("id", ids[at])) { book, error ->
                    if (error != null || book == null) {
                        finish(false, "read:${error ?: "invalid_response"}")
                        return@ask
                    }
                    val dto = book.getJSONObject("book")
                    payload.put(
                        JSONObject().put("id", ids[at]).put("expectedTags", dto.getJSONArray("tags")).put(
                            "expectedRevision",
                            dto.optJSONObject("classification")?.optInt("revision") ?: 0,
                        ),
                    )
                    at++
                    collect()
                }
            }
            collect()
        }
        chunk()
    }

    fun canOperate() = canAct()

    fun canMutate() = canAct() && !state.outcomeUnknown

    fun canLeave() = !mutating && (failed || keywordSearch.canLeave)

    fun isEditing() = mutating || (!failed && !keywordSearch.canLeave) || dialogs.any { it.isShowing }

    fun handleBack(): Boolean {
        if (!canLeave()) return true
        if (dialogs.none { it.isShowing } && state.manage) {
            state.manage = false
            state.selected.clear()
            load()
            return true
        }
        val top =
            dialogs.lastOrNull { it.isShowing } ?: return false
        top.dismiss()
        return true
    }

    fun close() {
        closed = true
        main.removeCallbacks(searchCommit)
        keywordSearch.close()
        if (!mutating) {
            state.manage = false
            state.selected.clear()
        }
        epoch++
        batch?.stopAfterCurrent()
        dialogs.toList().forEach { it.dismiss() }
        dialogs.clear()
    }
}
