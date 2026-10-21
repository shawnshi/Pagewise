package io.pagewise.reader

import android.app.Activity
import android.app.AlertDialog
import android.graphics.Rect
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.view.View
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject

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
) {
    private val main = Handler(Looper.getMainLooper())
    private val root = column()
    private val status = text("")
    private val dialogs = linkedSetOf<AlertDialog>()
    private var closed = false
    private var loading = false
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
    ) = TextView(activity).apply {
        this.text = value
        textSize = size
        setTextColor(ink)
        setPadding(4, 10, 4, 10)
    }

    private fun button(
        value: String,
        action: () -> Unit,
    ) = makeButton(value) {
        if (!closed && !mutating && !loading &&
            !navigating
        ) {
            action()
        }
    }

    private fun controls(
        parent: LinearLayout,
        values: List<Pair<String, () -> Unit>>,
    ) {
        val row = LinearLayout(activity)
        values.forEach { row.addView(button(it.first, it.second)) }
        parent.addView(android.widget.HorizontalScrollView(activity).apply { addView(row) })
    }

    private fun track(dialog: AlertDialog): AlertDialog {
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
                repaint()
            }
        }
    }

    fun render(): View {
        val mode = if (reading) "reading" else "library"
        if (state.mode != mode) {
            state.mode = mode
            state.manage = false
            state.selected.clear()
        }
        root.addView(status)
        ask("action.librarySessionGet") { result, error ->
            if (error != null || result == null) {
                status.text = error ?: "invalid_response"
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
            load(restore = state.returnToId.isNotEmpty())
        }
        return root
    }

    private fun load(
        persist: Boolean = false,
        restore: Boolean = false,
    ) {
        if (closed) return
        val token = ++epoch
        loading = true
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
                if (error != null || result == null || !result.optBoolean("ok")) {
                    status.text = error ?: "invalid_response"
                    return@ask
                }
                try {
                    current = result
                    val next = JSONObject(result.getJSONObject("session").toString()).apply { remove("unavailableReturn") }
                    if (reading) state.reading = next else state.library = next
                    draw(result, token)
                } catch (_: org.json.JSONException) {
                    status.text = "invalid_response"
                }
                repaint()
            }
        }
        if (persist && !reading) {
            ask("action.librarySessionSave", JSONObject().put("session", session)) { _, error ->
                if (token != epoch) return@ask
                if (error != null) {
                    loading = false
                    status.text = error
                    return@ask
                }
                query()
            }
        } else {
            query()
        }
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
        if (values.isEmpty()) return
        track(
            AlertDialog
                .Builder(activity)
                .setTitle(title)
                .setItems(
                    values
                        .map {
                            it.second
                        }.toTypedArray(),
                ) { _, index -> action(values[index].first) }
                .setNegativeButton(tr("取消", "Cancel"), null)
                .create(),
        )
    }

    private fun draw(
        result: JSONObject,
        token: Long,
    ) {
        root.removeAllViews()
        status.text =
            if (state.outcomeUnknown) {
                tr(
                    "上次批量结果未确认；不自动重放。请保留应用并核对。",
                    "Previous batch outcome is unconfirmed; it will not be replayed.",
                )
            } else {
                ""
            }
        root.addView(status)
        root.addView(
            text(
                "${result.getInt("allCount")} " + tr("本/篇", "books/papers") + " · " + tr("累计阅读", "Cumulative reading") +
                    " ${(result.getDouble("readingSeconds") / 60).toInt()} min",
            ),
        )
        if (reading) {
            val counts = result.getJSONObject("tabCounts")
            controls(
                root,
                listOf(
                    "reading" to tr("在读", "Reading"),
                    "recent" to tr("最近", "Recent"),
                    "wanted" to tr("想读", "Wanted"),
                    "paused" to tr("暂缓", "Paused"),
                    "finished" to tr("已读", "Finished"),
                    "abandoned" to tr("弃读", "Abandoned"),
                ).map { (id, label) ->
                    "$label (${counts.getInt(id)})" to
                        {
                            state.tab = id
                            session.put("page", 1)
                            state.selected.clear()
                            load()
                        }
                },
            )
        }
        val search =
            EditText(activity).apply {
                setText(session.optString("keyword"))
                setTextColor(ink)
                hint =
                    tr("书名、作者、标签", "Title, author, tags")
                isSingleLine = true
                imeOptions = EditorInfo.IME_ACTION_SEARCH
            }
        val searchRow = LinearLayout(activity)
        searchRow.addView(search, LinearLayout.LayoutParams(0, -2, 1f))
        searchRow.addView(
            button(tr("搜索", "Search")) {
                session.put("keyword", search.text.toString())
                filtersChanged()
            },
        )
        root.addView(searchRow)
        search.setOnEditorActionListener { _, action, _ ->
            if (action ==
                EditorInfo.IME_ACTION_SEARCH
            ) {
                session.put("keyword", search.text.toString())
                filtersChanged()
                true
            } else {
                false
            }
        }
        val commands =
            mutableListOf<Pair<String, () -> Unit>>(
                tr("筛选", "Filters") to { advanced(result.getJSONObject("facets")) },
                tr("显示数量", "Page size") to
                    {
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
        if (!reading) {
            commands.add(
                0,
                tr("排序", "Sort") to
                    {
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
            )
        }
        controls(root, commands)
        if (!reading) {
            controls(
                root,
                listOf(
                    tr("导入", "Import") to { userAction("importBooks") },
                    tr("文件夹", "Folder") to { userAction("selectFolder") },
                    tr("重新扫描", "Rescan") to { userAction("recheckFolder") },
                ),
            )
        }
        if (!reading) {
            val categories = result.getJSONObject("facets").getJSONArray("categoryFilter")
            controls(
                root,
                listOf(
                    (tr("全部", "All") + " (${result.getInt("allCount")})") to {
                        session.put("categoryFilter", "")
                        filtersChanged()
                    },
                ) +
                    (0 until categories.length()).map { i ->
                        val c = categories.getJSONObject(i)
                        "${c.getString("label")} (${c.getInt("count")})" to
                            {
                                session.put("categoryFilter", c.getString("value"))
                                filtersChanged()
                            }
                    },
            )
        }
        val items = result.getJSONArray("items")
        if (state.manage) management(result, items)
        if (items.length() == 0) root.addView(text(tr("没有匹配记录。", "No matching records.")))
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
                    visibility = if (state.manage) View.VISIBLE else View.GONE
                    setOnCheckedChangeListener {
                        _,
                        checked,
                        ->
                        if (checked) state.selected.add(id) else state.selected.remove(id)
                        selectionStatus.text = tr("已选择", "Selected") + " ${state.selected.size}"
                    }
                }
            wrapper.addView(check)
            val placeholder = text(view.getString("title") + "\n" + view.optString("author"))
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

    private fun advanced(facets: JSONObject) {
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
                button("$title: ${session.optString(key)}") {
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
                button("$key: ${session.optString(key)}") {
                    choose(
                        key,
                        values.map {
                            it to
                                it.ifEmpty { tr("全部", "All") }
                        },
                    ) { session.put(key, it) }
                },
            )
        }
        form.addView(
            button(tr("主题 / 特征 / 旧标签筛选", "Topic / feature / legacy tag filter")) {
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
            button(tr("标签条件：", "Tag mode: ") + session.optString("tagMode", "and")) {
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
                    if (reading) state.reading = session else state.library = session
                    filtersChanged()
                }.setNeutralButton(tr("清除筛选", "Clear filters")) { _, _ ->
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
                    ; state.selected.clear()
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
        if (navigating || mutating) return
        navigating = true
        ids(current.getString("selectionToken"), 10000) { ordered, error ->
            if (error != null || ordered == null) {
                navigating = false
                status.text = error
                return@ids
            }
            val p =
                JSONObject(
                    session.toString(),
                ).put("orderedBookIds", JSONArray(ordered)).put("lastViewedBookId", id).put("returnedFromReader", true)
            ask("action.librarySessionSave", JSONObject().put("session", p)) { _, failure ->
                navigating = false
                if (failure !=
                    null
                ) {
                    status.text = failure
                } else {
                    state.returnToId = id
                    state.manage = false
                    state.selected.clear()
                    next()
                }
            }
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
        if (state.selected.isEmpty() || mutating || state.outcomeUnknown) return
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
        if (state.selected.isEmpty()) return
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
        if (mutating || state.outcomeUnknown) return
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

    fun canLeave() = !mutating

    fun isEditing() = mutating || dialogs.any { it.isShowing }

    fun handleBack(): Boolean {
        if (mutating) return true
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
