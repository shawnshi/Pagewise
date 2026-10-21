package io.pagewise.reader

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.text.InputType
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.InputMethodManager
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Locale
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

internal typealias NativePageReply = (JSONObject?, String?) -> Unit

/** Native Views only. Persistence/jobs belong to the app-scoped dispatcher, never the view lifecycle. */
internal class NativePagesController(
    private val activity: Activity,
    private val request: (String, JSONObject, NativePageReply) -> Unit,
    private val navigate: (String) -> Unit,
    private val repaint: () -> Unit = {},
) {
    companion object {
        private const val PAGE_SIZE = 30
        private val images = ThreadPoolExecutor(2, 2, 10L, TimeUnit.SECONDS, ArrayBlockingQueue<Runnable>(64))
        private val pages =
            linkedMapOf(
                "library" to "藏书",
                "reading" to "正在阅读",
                "annotations" to "全部笔记",
                "stats" to "阅读统计",
                "settings" to "设置",
                "manual" to "使用手册",
            )
        private val statuses =
            linkedMapOf(
                "unmarked" to "未标记",
                "wanted" to "想读",
                "reading" to "在读",
                "paused" to "搁置",
                "finished" to "读完",
                "abandoned" to "弃读",
            )
        private val manualFiles = listOf("README.md", "01-读书方法.md", "02-阅读模式.md", "03-声音.md", "04-使用说明.md", "05-伴读.md")
    }

    private val overlay = FrameLayout(activity)
    private val shell = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }
    private val body = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }
    private val scroll =
        ScrollView(activity).apply {
            isFillViewport = true
            addView(body)
        }
    private var mounted = false
    private var disposed = false
    private var generation = 0L
    private var refreshIntent = 0L
    private var dialogIntent = 0L
    private var page = "library"
    private var params = JSONObject()
    private var preferences = JSONObject()
    private var foreground = Color.BLACK
    private var background = Color.WHITE
    private var query = ""
    private var offset = 0
    private var sort = "recent"
    private var statusFilter = ""
    private var kindFilter = ""
    private var noteFilter = "all"
    private val draftPager = NativeDraftPager()
    private var manual = "README.md"
    private var manualAnchor = ""
    private val statisticsState = NativeStatsUiState()
    private var statsPanel: NativeStatsPanel? = null
    private val libraryState = NativeLibraryUiState()
    private var libraryPanel: NativeLibraryPanel? = null
    private var currentDialog: AlertDialog? = null
    private var errorDialog: AlertDialog? = null
    private var noteEditor: NativeNoteEditor? = null
    private var settingsPanel: NativeSettingsPanel? = null

    private fun dp(n: Int) = (n * activity.resources.displayMetrics.density).toInt()

    private fun label(zh: String): String {
        if (preferences.optString("language") != "en") return zh
        return mapOf(
            "藏书" to "Library",
            "正在阅读" to "Reading",
            "全部笔记" to "All notes",
            "阅读统计" to "Statistics",
            "设置" to "Settings",
            "使用手册" to "Manual",
            "书籍详情" to "Book details",
            "目录" to "Table of contents",
            "菜单" to "Menu",
            "返回" to "Back",
            "刷新" to "Refresh",
            "核对恢复" to "Recovery",
            "搜索" to "Search",
            "上页" to "Previous",
            "下页" to "Next",
            "取消" to "Cancel",
            "保存" to "Save",
            "删除" to "Remove",
            "阅读" to "Read",
            "编辑" to "Edit",
            "导入" to "Import",
            "排序" to "Sort",
            "筛选" to "Filter",
            "正在加载…" to "Loading…",
            "重试" to "Retry",
            "书名" to "Title",
            "作者" to "Author",
            "出版社" to "Publisher",
            "出版日期" to "Publication date",
            "语言" to "Language",
            "简介" to "Description",
            "文件名" to "Original filename",
            "源相对路径" to "Source-relative path",
            "标签" to "Tags",
            "阅读状态" to "Reading status",
            "置顶" to "Pin",
            "取消置顶" to "Unpin",
            "全部" to "All",
            "没有匹配记录" to "No matching records",
        )[zh]
            ?: zh
    }

    private fun text(
        value: String,
        size: Float = 17f,
        bold: Boolean = false,
    ) = TextView(activity).apply {
        this.text = value
        textSize = size
        setTextColor(this@NativePagesController.foreground)
        setPadding(dp(4), dp(7), dp(4), dp(7))
        setLineSpacing(dp(2).toFloat(), 1.06f)
        if (bold) setTypeface(null, Typeface.BOLD)
    }

    private fun column() = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }

    private fun line() =
        View(activity).apply {
            setBackgroundColor(this@NativePagesController.foreground)
            alpha = 0.22f
            layoutParams =
                LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(1))
        }

    private fun button(
        title: String,
        onClick: () -> Unit,
    ) = Button(activity).apply {
        text = label(title)
        textSize = 15f
        isAllCaps = false
        minHeight = dp(48)
        minimumHeight = dp(48)
        setTextColor(this@NativePagesController.foreground)
        background =
            GradientDrawable().apply {
                setColor(this@NativePagesController.background)
                setStroke(dp(1).coerceAtLeast(1), this@NativePagesController.foreground)
                cornerRadius =
                    dp(5).toFloat()
            }
        setPadding(dp(13), dp(5), dp(13), dp(5))
        contentDescription = text
        setOnClickListener { onClick() }
        layoutParams =
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                setMargins(dp(3), dp(3), dp(3), dp(3))
            }
    }

    private fun actions(
        parent: LinearLayout,
        items: List<Pair<String, () -> Unit>>,
    ) {
        val row =
            LinearLayout(activity).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
            }
        items.forEach { (title, action) -> row.addView(button(title, action)) }
        parent.addView(
            HorizontalScrollView(activity).apply {
                isHorizontalScrollBarEnabled = true
                addView(row)
            },
        )
    }

    private fun input(
        value: String,
        hint: String,
        multiline: Boolean = false,
        secret: Boolean = false,
    ) = EditText(activity).apply {
        setText(value)
        this.hint = label(hint)
        contentDescription = label(hint)
        setTextColor(this@NativePagesController.foreground)
        setHintTextColor(this@NativePagesController.foreground)
        textSize = 17f
        minHeight = dp(48)
        setPadding(dp(8), dp(8), dp(8), dp(8))
        isSingleLine = !multiline
        inputType =
            if (secret) {
                InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            } else {
                InputType.TYPE_CLASS_TEXT or
                    if (multiline) InputType.TYPE_TEXT_FLAG_MULTI_LINE else 0
            }
        if (multiline) minLines = 3
    }

    fun prepareLeave(reply: (String?) -> Unit) {
        if (settingsPanel?.canLeave() == false || statsPanel?.canLeave() == false || libraryPanel?.canLeave() == false) {
            reply("native_operation_pending")
            return
        }
        val editor = noteEditor
        if (editor != null) editor.flushForLeave(reply) else reply(null)
    }

    private fun closeEditorsAfterLeave(closeSettings: Boolean = true) {
        if (noteEditor?.closeConfirmed() == false) throw NativeStateFailure("draft_unconfirmed")
        if (closeSettings) {
            settingsPanel?.close()
            settingsPanel = null
            statsPanel?.close()
            statsPanel = null
            libraryPanel?.close()
            libraryPanel = null
        }
        currentDialog?.dismiss()
        currentDialog = null
    }

    private fun replaceDialog(open: () -> AlertDialog) {
        val epoch = generation
        val intent = ++dialogIntent
        prepareLeave { error ->
            if (disposed || epoch != generation || intent != dialogIntent) return@prepareLeave
            if (error != null) {
                showError(error)
                return@prepareLeave
            }
            closeEditorsAfterLeave(closeSettings = false)
            currentDialog = open()
        }
    }

    private fun dialog(
        title: String,
        view: View,
        save: (() -> Unit)? = null,
    ) {
        replaceDialog {
            val result =
                AlertDialog
                    .Builder(activity)
                    .setTitle(label(title))
                    .setView(view)
                    .setNegativeButton(label("取消"), null)
                    .apply { if (save != null) setPositiveButton(label("保存"), null) }
                    .create()
            result.setOnShowListener { if (save != null) result.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener { save() } }
            result.show()
            result
        }
    }

    private fun choose(
        title: String,
        options: List<String>,
        selected: Int = -1,
        action: (Int) -> Unit,
    ) {
        replaceDialog {
            AlertDialog
                .Builder(activity)
                .setTitle(label(title))
                .setSingleChoiceItems(options.toTypedArray(), selected) { d, index ->
                    d.dismiss()
                    action(index)
                }.setNegativeButton(label("取消"), null)
                .show()
        }
    }

    private fun confirm(
        title: String,
        message: String,
        action: () -> Unit,
    ) {
        replaceDialog {
            AlertDialog
                .Builder(activity)
                .setTitle(label(title))
                .setMessage(message)
                .setNegativeButton(label("取消"), null)
                .setPositiveButton(label(title)) { _, _ -> action() }
                .show()
        }
    }

    private fun call(
        name: String,
        payload: JSONObject = JSONObject(),
        success: (JSONObject) -> Unit,
    ) {
        val epoch = generation
        request(name, payload) { result, error ->
            activity.runOnUiThread {
                if (!disposed && mounted && epoch == generation && overlay.visibility == View.VISIBLE) {
                    if (error != null || result == null) {
                        showError(error ?: "invalid_response")
                    } else {
                        try {
                            success(result)
                        } catch (_: org.json.JSONException) {
                            showError("invalid_response")
                        }
                    }
                    overlay.post { if (!disposed) repaint() }
                }
            }
        }
    }

    private fun showError(code: String) {
        val detail =
            when (code) {
                "settings_conflict", "book_conflict", "annotation_conflict", "conflict" -> "数据已被其他操作修改；请刷新后核对，不会覆盖较新的内容。"
                "source_linked_book" -> "此条目关联监控文件夹，不能单独移除；否则重新扫描会恢复条目并丢失关联。源文件和笔记未删除。"
                "commit_outcome_unknown", "unavailable" -> "未能确认提交结果。请刷新核对；不要将它视为未提交或重新累加。"
                "annotation_saved_draft_pending" -> "批注已保存，但旧草稿清理未确认；不要将它视为批注保存失败或重复提交。"
                "partial_restore" -> "恢复未全部完成，部分记录可能已经提交；请保留备份并核对，不能假定已完全回滚或自动重放。"
                "partial_import" -> "部分文件已入库，另有输入未完成；请核对批次回执，不要假定全部失败。"
                "native_settings_unsaved" -> "仍有未保存的本地设置或排版草稿；请保持应用开启并核对，不能自动丢弃。"
                "permission_denied", "permission-denied" -> "没有文件访问权限，请在设置中重新授权。"
                "ai_not_configured", "not_configured" -> "请先在设置中配置自己的 AI 服务、API Key 和模型。"
                else -> "操作未完成（${code.take(80).replace(Regex("[^a-zA-Z0-9_-]"), "")}）。已有数据不会被当成空数据替换。"
            }
        // Do not dismiss an editor on a failed/unknown commit: its unsaved text must survive.
        errorDialog?.dismiss()
        errorDialog =
            AlertDialog
                .Builder(activity)
                .setTitle("操作未完成")
                .setMessage(detail)
                .setPositiveButton(label("返回"), null)
                .show()
    }

    fun show(
        page: String,
        params: JSONObject,
    ) {
        check(!disposed)
        require(page in pages || page == "book")
        closeEditorsAfterLeave()
        if (this.page != page || this.params.toString() != params.toString()) {
            offset = 0
            query = ""
            noteFilter = "all"
            draftPager.reset()
        }
        this.page = page
        this.params = JSONObject(params.toString())
        if (!mounted) {
            overlay.addView(shell, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            overlay.isFocusableInTouchMode = true
            overlay.setOnApplyWindowInsetsListener {
                view,
                insets,
                ->
                view.setPadding(
                    insets.systemWindowInsetLeft,
                    insets.systemWindowInsetTop,
                    insets.systemWindowInsetRight,
                    insets.systemWindowInsetBottom,
                )
                insets
            }
            activity.addContentView(
                overlay,
                ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
            )
            mounted = true
        }
        overlay.visibility = View.VISIBLE
        overlay.requestApplyInsets()
        overlay.requestFocus()
        refresh()
    }

    fun hide(force: Boolean = false) {
        if (!force) {
            closeEditorsAfterLeave()
        } else {
            settingsPanel?.close()
            settingsPanel = null
            statsPanel?.close()
            statsPanel = null
            libraryPanel?.close()
            libraryPanel = null
        }
        refreshIntent++
        dialogIntent++
        generation++
        errorDialog?.dismiss()
        errorDialog = null
        currentDialog?.dismiss()
        currentDialog = null
        overlay.visibility = View.GONE
    }

    fun handleBack(): Boolean {
        if (disposed || !mounted || overlay.visibility != View.VISIBLE) return false
        if (settingsPanel?.handleBack() == true || statsPanel?.handleBack() == true || libraryPanel?.handleBack() == true) return true
        if (errorDialog?.isShowing == true) {
            errorDialog?.dismiss()
            return true
        }
        if (currentDialog?.isShowing == true) {
            if (noteEditor != null) {
                noteEditor?.requestClose()
                return true
            }
            currentDialog?.dismiss()
            return true
        }
        if (page != "library") {
            navigate("@back")
            return true
        }
        return false
    }

    fun handleKey(event: KeyEvent): Boolean {
        if (disposed || !mounted || overlay.visibility != View.VISIBLE || settingsPanel?.isEditing() == true ||
            statsPanel?.isEditing() == true ||
            libraryPanel?.isEditing() == true ||
            currentDialog?.isShowing == true ||
            errorDialog?.isShowing == true
        ) {
            return false
        }
        val direction =
            when (event.keyCode) {
                KeyEvent.KEYCODE_PAGE_DOWN -> View.FOCUS_DOWN
                KeyEvent.KEYCODE_PAGE_UP -> View.FOCUS_UP
                else -> return false
            }
        if (event.action == KeyEvent.ACTION_DOWN) scroll.pageScroll(direction)
        return true
    }

    fun dispose() {
        if (disposed) return
        disposed = true
        hide(force = true)
        body.removeAllViews()
        shell.removeAllViews()
        (overlay.parent as? ViewGroup)?.removeView(overlay)
        mounted =
            false
    }

    private fun refresh() {
        val intent = ++refreshIntent
        val epoch = generation
        prepareLeave { error ->
            if (disposed || intent != refreshIntent || epoch != generation) return@prepareLeave
            if (error != null) {
                showError(error)
                return@prepareLeave
            }
            refreshReady()
        }
    }

    private fun refreshReady() {
        closeEditorsAfterLeave()
        dialogIntent++
        generation++
        shell.removeAllViews()
        body.removeAllViews()
        overlay.setBackgroundColor(background)
        shell.addView(text(label("正在加载…")))
        call("state.settingsGet") { state ->
            preferences = JSONObject(state.getString("raw"))
            val eink = preferences.optJSONObject("readingMode")?.optJSONObject("eink")?.optBoolean("enabled") == true
            val dark =
                !eink &&
                    (
                        preferences.optString("appearance") == "dark" ||
                            (preferences.optString("appearance") == "system" && activity.resources.configuration.uiMode and 0x30 == 0x20)
                    )
            foreground = if (dark) Color.WHITE else Color.BLACK
            background = if (dark) Color.BLACK else Color.WHITE
            frame()
            when (page) {
                "library", "reading" -> books()
                "book" -> book()
                "annotations" -> notes()
                "stats" -> statistics()
                "settings" -> settings()
                "manual" -> manual()
            }
        }
    }

    private fun frame() {
        shell.removeAllViews()
        body.removeAllViews()
        overlay.setBackgroundColor(background)
        shell.setBackgroundColor(background)
        val toolbar =
            LinearLayout(activity).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(dp(8), dp(4), dp(8), dp(4))
            }
        toolbar.addView(
            button(if (page == "library") "菜单" else "返回") {
                if (page ==
                    "library"
                ) {
                    choose("菜单", pages.values.map(::label)) { navigate(pathFor(pages.keys.toList()[it])) }
                } else {
                    navigate("/library")
                }
            },
        )
        toolbar.addView(
            text(
                label(
                    if (page ==
                        "book"
                    ) {
                        "书籍详情"
                    } else {
                        pages.getValue(page)
                    },
                ),
                22f,
                true,
            ),
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f),
        )
        if (page != "settings") toolbar.addView(button("核对恢复", ::showSettingsRecovery))
        toolbar.addView(button("刷新") { refresh() })
        shell.addView(toolbar)
        shell.addView(line())
        body.setPadding(dp(12), dp(8), dp(12), dp(32))
        (scroll.parent as? ViewGroup)?.removeView(scroll)
        shell.addView(scroll, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
    }

    private fun pathFor(page: String) =
        when (page) {
            "annotations" -> "/notes"
            else -> "/$page"
        }

    private fun search(
        parent: LinearLayout = body,
        hint: String = "搜索书名、作者、笔记",
    ) {
        val edit = input(query, hint)
        parent.addView(edit)
        actions(
            parent,
            listOf(
                "搜索" to
                    {
                        query = edit.text.toString()
                        offset = 0
                        (
                            activity.getSystemService(
                                Activity.INPUT_METHOD_SERVICE,
                            ) as InputMethodManager
                        ).hideSoftInputFromWindow(edit.windowToken, 0)
                        refresh()
                    },
            ),
        )
    }

    private fun pageControls(
        total: Int,
        shown: Int,
    ) {
        body.addView(text("${if (total == 0) 0 else offset + 1}–${offset + shown} / $total", 14f))
        val row = LinearLayout(activity)
        row.addView(
            button("上页") {
                offset = (offset - PAGE_SIZE).coerceAtLeast(0)
                refresh()
            }.apply { isEnabled = offset > 0 },
        )
        row.addView(
            button("下页") {
                offset += PAGE_SIZE
                refresh()
            }.apply { isEnabled = offset + shown < total },
        )
        body.addView(row)
    }

    private fun userAction(
        name: String,
        payload: JSONObject = JSONObject(),
    ) {
        call("action.$name", payload) { result ->
            if (result.optBoolean("cancelled")) return@call
            val code = result.optString("code")
            if (code == "backup_preview") {
                val token = result.getString("token")
                var decided = false
                replaceDialog {
                    val preview =
                        AlertDialog
                            .Builder(activity)
                            .setTitle("导入书库备份")
                            .setMessage("已选择 ${result.optLong("size") / 1024} KiB。此预览仅核对选择信息，尚未校验内容。确认后调用既有恢复服务；失败可能有部分已提交记录，不能假定完全回滚。")
                            .setPositiveButton("校验并导入") { _, _ ->
                                decided = true
                                userAction("backupImport", JSONObject().put("mode", "commit").put("token", token).put("confirm", true))
                            }.setNegativeButton("取消") { _, _ ->
                                decided = true
                                userAction("backupImport", JSONObject().put("mode", "discard").put("token", token))
                            }.create()
                    preview.setOnDismissListener {
                        if (!decided) request("action.backupImport", JSONObject().put("mode", "discard").put("token", token)) { _, _ -> }
                    }
                    preview.show()
                    preview
                }
                return@call
            }
            if (code == "relink_candidates") {
                val files = result.getJSONArray("files")
                if (files.length() == 0) {
                    showError("no_relink_candidates")
                    return@call
                }
                choose("选择相同版本的原文件", (0 until files.length()).map { files.getJSONObject(it).getString("name") }) { index ->
                    val selected = files.getJSONObject(index)
                    confirm("重新关联", "只有确认属于相同版本才可继续；错误版本可能使原标注位置失效。保留原书籍 ID、笔记和进度。") {
                        userAction(
                            "relinkBookCommit",
                            JSONObject()
                                .put(
                                    "bookId",
                                    payload.getString("bookId"),
                                ).put(
                                    "folderId",
                                    result.getString("folderId"),
                                ).put("documentId", selected.getString("documentId"))
                                .put("confirmSameEdition", true),
                        )
                    }
                }
                return@call
            }
            if (code == "folder_status" || code == "folder_incomplete") {
                val status = result.optJSONObject("status") ?: JSONObject()
                replaceDialog {
                    AlertDialog
                        .Builder(activity)
                        .setTitle("文件夹状态")
                        .setMessage(
                            "状态：${status.optString(
                                "state",
                            )}\n${status.optString("message")}\n错误：${status.optString("error")}\n此为管理器当前快照，不是持久任务完成回执。",
                        ).setPositiveButton("返回", null)
                        .show()
                }
                return@call
            }
            if (result.optString("outcome") ==
                "unknown"
            ) {
                showError(if (code == "partial_restore") "partial_restore" else "commit_outcome_unknown")
                return@call
            }
            if (!result.optBoolean("ok", true)) {
                showError(code.ifEmpty { "operation_failed" })
                return@call
            }
            refresh()
        }
    }

    private fun books() {
        val panel =
            NativeLibraryPanel(
                activity,
                request,
                foreground,
                preferences.optString("language") == "en",
                page == "reading",
                libraryState,
                { title, action -> button(title, action) },
                { book, read, details -> bookRow(book, read, details) },
                { openReader(it) },
                { navigate("/book/${Uri.encode(it.getString("id"))}") },
                { name -> userAction(name) },
                repaint,
            )
        libraryPanel = panel
        body.addView(panel.render())
    }

    private fun bookRow(
        book: JSONObject,
        read: (() -> Unit)? = null,
        details: (() -> Unit)? = null,
    ): View {
        val row =
            LinearLayout(activity).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(0, dp(7), 0, dp(7))
            }
        val cover =
            ImageView(activity).apply {
                contentDescription = "${book.optString("title")} 封面"
                scaleType =
                    ImageView.ScaleType.FIT_CENTER
            }
        row.addView(cover, LinearLayout.LayoutParams(dp(54), dp(78)))
        loadCover(cover, book.optString("coverPath"))
        val info = column()
        info.addView(text(book.optString("title"), 18f, true))
        info.addView(text(book.optString("author").ifEmpty { "未知作者" }, 14f))
        val progress =
            if (book.has("progress") &&
                !book.isNull("progress")
            ) {
                " · ${(book.optDouble("progress") * 100).coerceIn(0.0, 100.0).toInt()}%"
            } else {
                ""
            }
        info.addView(
            text(
                "${statuses[
                    book.optString(
                        "effectiveReadingStatus",
                        book.optString("readingStatus"),
                    ),
                ] ?: "未标记"} · ${book.optString("format").uppercase(Locale.ROOT)}$progress",
                13f,
            ),
        )
        row.addView(info, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        row.addView(
            button("阅读") {
                if (read !=
                    null
                ) {
                    read()
                } else {
                    openReader(book)
                }
            }.apply { isEnabled = !book.has("supported") || book.optBoolean("supported") },
        )
        row.setOnClickListener { if (details != null) details() else navigate("/book/${Uri.encode(book.getString("id"))}") }
        row.setOnLongClickListener {
            bookMenu(book, read, details)
            true
        }
        return row
    }

    private fun loadCover(
        view: ImageView,
        path: String,
    ) {
        if (path.isEmpty()) return
        val epoch = generation
        try {
            images.execute {
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeFile(path, bounds)
                val options =
                    BitmapFactory.Options().apply {
                        inPreferredConfig = Bitmap.Config.RGB_565
                        var sample = 1
                        while (bounds.outWidth /
                            sample >
                            256 ||
                            bounds.outHeight / sample > 256
                        ) {
                            sample *= 2
                        }
                        inSampleSize = sample
                    }
                val bitmap = BitmapFactory.decodeFile(path, options)
                activity.runOnUiThread {
                    if (!disposed && epoch == generation &&
                        view.isAttachedToWindow
                    ) {
                        view.setImageBitmap(bitmap)
                    } else {
                        bitmap?.recycle()
                    }
                }
            }
        } catch (_: java.util.concurrent.RejectedExecutionException) {
            // Decoration only; metadata remains visible.
        }
    }

    private fun openReader(
        book: JSONObject,
        cfi: String = "",
    ) {
        if (book.has("supported") && !book.optBoolean("supported")) {
            showError("retired_format")
            return
        }
        if (book.optString("fileAvailability") in
            setOf("missing", "permission-denied")
        ) {
            navigate("/book/${Uri.encode(book.getString("id"))}?recover=1")
            return
        }
        val path = if (book.optString("format") == "pdf") "/read-pdf/" else "/read/"
        navigate(path + Uri.encode(book.getString("id")) + if (cfi.isEmpty()) "" else "?loc=${Uri.encode(cfi)}")
    }

    private fun bookMenu(
        book: JSONObject,
        read: (() -> Unit)? = null,
        details: (() -> Unit)? = null,
    ) {
        choose(book.optString("title"), listOf("阅读", "书籍详情", "阅读状态", if (book.isNull("pinnedAt")) "置顶" else "取消置顶", "移除书目")) { index ->
            when (index) {
                0 -> {
                    if (read != null) read() else openReader(book)
                }

                1 -> {
                    if (details != null) details() else navigate("/book/${Uri.encode(book.getString("id"))}")
                }

                2 -> {
                    status(book)
                }

                3 -> {
                    patchBook(
                        book,
                        JSONObject().put("pinnedAt", if (book.isNull("pinnedAt")) System.currentTimeMillis() else JSONObject.NULL),
                    )
                }

                4 -> {
                    removeBook(book)
                }
            }
        }
    }

    private fun patchBook(
        book: JSONObject,
        patch: JSONObject,
    ) = call("library.bookPatch", JSONObject().put("id", book.getString("id")).put("before", book).put("patch", patch)) {
        if (patch.has("pinnedAt")) {
            // Explicit pin/unpin requests a new order; ordinary reader return keeps its snapshot.
            call("action.librarySessionSave", JSONObject().put("session", JSONObject().put("orderedBookIds", JSONArray()))) { refresh() }
        } else {
            refresh()
        }
    }

    private fun status(book: JSONObject) =
        choose("阅读状态", statuses.values.toList(), statuses.keys.indexOf(book.optString("readingStatus"))) {
            patchBook(book, JSONObject().put("readingStatus", statuses.keys.toList()[it]))
        }

    private fun removeBook(book: JSONObject) {
        if (!book.isNull("sourceRef") && book.optString("sourceRef").isNotEmpty()) {
            showError("source_linked_book")
            return
        }
        confirm("删除", "移除《${book.optString("title")}》的书目及关联笔记；保留实际书籍文件和阅读统计。此操作不会删除监控文件夹源文件。") {
            call("library.bookRemove", JSONObject().put("id", book.getString("id")).put("before", book)) {
                if (page ==
                    "library"
                ) {
                    refresh()
                } else {
                    navigate("/library")
                }
            }
        }
    }

    private fun book() {
        call("library.book", JSONObject().put("id", params.getString("id"))) { response ->
            val book = response.getJSONObject("book")
            call("action.libraryBookInfo", JSONObject().put("bookId", book.getString("id"))) { info ->
                book.put("effectiveReadingStatus", info.getString("effectiveReadingStatus")).put("supported", info.getBoolean("supported"))
                renderBook(book)
            }
        }
    }

    private fun renderBook(book: JSONObject) {
        if (book.optString("coverPath").isNotEmpty()) {
            val image =
                ImageView(activity).apply {
                    contentDescription = book.optString("title") + " cover"
                    scaleType =
                        ImageView.ScaleType.FIT_CENTER
                }
            body.addView(image, LinearLayout.LayoutParams(dp(150), dp(200)))
            loadCover(image, book.getString("coverPath"))
        }
        body.addView(text(book.optString("title"), 26f, true).apply { setTextIsSelectable(true) })
        body.addView(text(book.optString("author")))
        actions(
            body,
            listOf(
                "阅读" to { openReader(book) },
                "编辑" to { editBook(book) },
                (if (book.isNull("pinnedAt")) "置顶" else "取消置顶") to {
                    patchBook(
                        book,
                        JSONObject().put("pinnedAt", if (book.isNull("pinnedAt")) System.currentTimeMillis() else JSONObject.NULL),
                    )
                },
                "阅读状态" to { status(book) },
                "标签" to { editTags(book) },
                "AI 分类" to { openClassification(book.getString("id"), true) },
                "目录" to { bookToc(book.getString("id")) },
            ),
        )
        val details =
            listOf(
                "格式" to book.optString("format"),
                "出版社" to book.optString("publisher"),
                "出版日期" to book.optString("publicationDate"),
                "语言" to book.optString("language"),
                "阅读状态" to (statuses[book.optString("effectiveReadingStatus")] ?: "未标记"),
                "阅读时长" to duration(book.optDouble("readingSeconds", 0.0)),
                "阅读进度" to (if (book.isNull("progress")) "—" else "${(book.optDouble("progress") * 100).toInt()}%"),
                "最近阅读" to dateTime(book.optLong("lastReadAt")),
                "加入时间" to dateTime(book.optLong("addedAt")),
                "文件状态" to book.optString("fileAvailability"),
                "来源" to book.optString("source"),
                "文件名" to book.optString("fileName"),
                "源相对路径" to (book.optJSONObject("sourceRef")?.optString("relativePath") ?: ""),
            )
        details.filter { it.second.isNotEmpty() && it.second != "null" }.forEach {
            body.addView(
                text("${label(it.first)}：${it.second}", 15f),
            )
        }
        val description = book.optString("description")
        if (description.isNotEmpty() &&
            description != "null"
        ) {
            body.addView(text(description))
        }
        val tags =
            book.optJSONArray("tags") ?: JSONArray()
        if (tags.length() >
            0
        ) {
            body.addView(text("标签：${(0 until tags.length()).joinToString("、") { tags.optString(it) }}"))
        }
        if (book.has("classification") &&
            !book.isNull("classification")
        ) {
            body.addView(text("分类", 19f, true))
            val classification = book.getJSONObject("classification")
            body.addView(text("主分类：" + (classification.optJSONObject("category")?.optString("value") ?: "未分类"), 15f))
            val topics = classification.optJSONArray("topics") ?: JSONArray()
            body.addView(text("主题：" + (0 until topics.length()).joinToString("、") { topics.getJSONObject(it).getString("value") }, 15f))
            classification.optJSONObject("feature")?.let { body.addView(text("特征：" + it.getString("value"), 15f)) }
            classification.optJSONObject("facets")?.let { facets ->
                body.addView(
                    text(
                        facets
                            .keys()
                            .asSequence()
                            .filter { !facets.isNull(it) }
                            .joinToString(" · ") { "$it: ${facets.get(it)}" },
                        14f,
                    ),
                )
            }
        }
        actions(
            body,
            listOf(
                "本书笔记" to { navigate("/notes?bookId=${Uri.encode(book.getString("id"))}") },
                "重新关联文件" to { userAction("relinkBook", JSONObject().put("bookId", book.getString("id"))) },
                "删除" to { removeBook(book) },
            ),
        )
        body.addView(text("本书笔记", 20f, true))
        call("library.annotations", JSONObject().put("bookId", book.getString("id")).put("offset", 0).put("limit", 10)) { notes ->
            val items = notes.getJSONArray("items")
            if (items.length() == 0) body.addView(text("没有笔记", 15f))
            for (i in 0 until items.length()) noteRow(items.getJSONObject(i))
        }
    }

    private fun bookToc(bookId: String) {
        val epoch = generation
        var intent = ++dialogIntent
        var busy = false
        var context = ""
        var window: AlertDialog? = null
        val form = column()

        fun fetch(offset: Int) {
            if (busy) return
            busy = true
            val payload = JSONObject().put("bookId", bookId).put("offset", offset).put("limit", 50)
            if (context.isNotEmpty()) payload.put("token", context)
            request("action.bookToc", payload) { result, error ->
                activity.runOnUiThread {
                    busy = false
                    if (disposed || epoch != generation || intent != dialogIntent ||
                        (window != null && window?.isShowing != true)
                    ) {
                        return@runOnUiThread
                    }
                    if (error != null || result == null) {
                        showError(error ?: "invalid_response")
                        return@runOnUiThread
                    }
                    form.removeAllViews()
                    if (!result.getBoolean("supported")) {
                        form.addView(text("此格式不支持提取目录；不是读取失败或空书库。"))
                    } else {
                        context = result.getString("token")
                        val entries = result.getJSONArray("items")
                        val total = result.getInt("total")
                        form.addView(
                            text(
                                "目录快照 · ${if (total == 0) 0 else offset + 1}–${(offset + entries.length()).coerceAtMost(total)} / $total",
                                14f,
                            ),
                        )
                        if (total == 0) form.addView(text("原文件没有可提取的目录。"))
                        for (i in 0 until entries.length()) {
                            val entry = entries.getJSONObject(i)
                            form.addView(
                                text(entry.getString("title")).apply {
                                    setPadding(dp(minOf(entry.getInt("depth"), 8) * 12), dp(6), dp(4), dp(6))
                                    setTextIsSelectable(true)
                                },
                            )
                        }
                        val pager = LinearLayout(activity)
                        pager.addView(button("上页") { fetch((offset - 50).coerceAtLeast(0)) }.apply { isEnabled = offset > 0 })
                        pager.addView(button("下页") { fetch(offset + 50) }.apply { isEnabled = offset + entries.length() < total })
                        form.addView(pager)
                    }
                    if (window == null) {
                        replaceDialog {
                            intent = dialogIntent
                            AlertDialog
                                .Builder(activity)
                                .setTitle(label("目录"))
                                .setView(
                                    ScrollView(activity).apply {
                                        addView(form)
                                    },
                                ).setPositiveButton(label("返回"), null)
                                .create()
                                .also {
                                    window =
                                        it
                                    ; it.show()
                                }
                        }
                    }
                    repaint()
                }
            }
        }
        fetch(0)
    }

    private fun editBook(book: JSONObject) {
        val fields =
            linkedMapOf(
                "title" to "书名",
                "author" to "作者",
                "publisher" to "出版社",
                "publicationDate" to "出版日期",
                "language" to "语言",
                "description" to "简介",
            )
        val form = column()
        val editors = linkedMapOf<String, EditText>()
        fields.forEach { (key, title) ->
            form.addView(text(label(title), 14f))
            val editor =
                input(
                    if (book.isNull(key)) "" else book.optString(key),
                    title,
                    key == "description",
                )
            ; editors[key] = editor
            form.addView(editor)
        }
        dialog("编辑书目信息", ScrollView(activity).apply { addView(form) }) {
            val patch = JSONObject()
            editors.forEach { (key, editor) ->
                val value = editor.text.toString()
                if (value !=
                    if (book.isNull(key)) "" else book.optString(key)
                ) {
                    patch.put(key, value)
                }
            }
            if (patch.has("title") && patch.getString("title").isBlank()) {
                editors["title"]?.error = "书名不能为空"
                return@dialog
            }
            if (patch.length() == 0) currentDialog?.dismiss() else patchBook(book, patch)
        }
    }

    private fun editTags(book: JSONObject) = openClassification(book.getString("id"), false)

    private fun openClassification(
        bookId: String,
        autoGenerate: Boolean,
    ) {
        call("action.classificationGet", JSONObject().put("bookId", bookId)) { result ->
            if (!result.optBoolean("ok", true)) {
                showError(result.optString("code"))
                return@call
            }
            replaceDialog { NativeClassificationEditor(activity, result, request, { refresh() }, ::showError).show(autoGenerate) }
        }
    }

    private fun notes() {
        showDrafts()
        search(hint = "搜索选区原文、笔记或书名")
        actions(
            body,
            listOf(
                "筛选" to
                    {
                        choose(
                            "笔记类型",
                            listOf("全部", "想法", "标注", "书签"),
                            listOf("all", "thoughts", "highlights", "bookmarks").indexOf(noteFilter),
                        ) {
                            noteFilter =
                                listOf("all", "thoughts", "highlights", "bookmarks")[it]
                            ; offset = 0
                            refresh()
                        }
                    },
            ),
        )
        val payload =
            JSONObject()
                .put("query", query)
                .put("filter", noteFilter)
                .put("offset", offset)
                .put("limit", PAGE_SIZE)
        if (params.optString("bookId").isNotEmpty()) payload.put("bookId", params.getString("bookId"))
        call("library.annotations", payload) { response ->
            val items = response.getJSONArray("items")
            if (items.length() == 0) body.addView(text(label("没有匹配记录")))
            for (i in 0 until items.length()) noteRow(items.getJSONObject(i))
            pageControls(response.getInt("total"), items.length())
        }
    }

    private fun noteRow(note: JSONObject) {
        val card = column().apply { setPadding(dp(4), dp(8), dp(4), dp(8)) }
        card.addView(text(note.optString("bookTitle", "已移除的书籍"), 15f, true))
        card.addView(text(note.optString("text"), 17f))
        if (!note.isNull("note") && note.optString("note").isNotEmpty()) card.addView(text(note.getString("note"), 17f))
        card.addView(text(dateTime(note.optLong("createdAt")), 12f))
        actions(
            card,
            listOf(
                "回到原文" to {
                    if (note.optBoolean("sourceMissing")) {
                        showError("book_missing")
                    } else if (note.optString("readerJumpUrl").isNotEmpty()) {
                        navigate(note.getString("readerJumpUrl"))
                    } else {
                        call(
                            "library.book",
                            JSONObject().put("id", note.getString("bookId")),
                        ) { openReader(it.getJSONObject("book"), note.optString("cfi")) }
                    }
                },
                "编辑" to { editNote(note) },
                "删除" to {
                    confirm("删除", "仅删除这条笔记/标注，不修改原书内容。") {
                        call("library.annotationRemove", JSONObject().put("id", note.getString("id")).put("before", note)) { refresh() }
                    }
                },
            ),
        )
        card.addView(line())
        body.addView(card)
    }

    private fun editNote(note: JSONObject) {
        call("action.noteDraftGet", JSONObject().put("bookId", note.getString("bookId")).put("id", note.getString("id"))) { result ->
            if (!result.optBoolean("ok", true)) {
                showError(result.optString("code"))
                return@call
            }
            replaceDialog {
                lateinit var editor: NativeNoteEditor
                editor =
                    NativeNoteEditor(activity, note, result, request, { refresh() }, ::showError, {
                        if (noteEditor ===
                            editor
                        ) {
                            noteEditor = null
                        }
                    })
                noteEditor = editor
                editor.show()
            }
        }
    }

    private fun showDrafts() {
        val payload = JSONObject()
        if (params.optString("bookId").isNotEmpty()) payload.put("bookId", params.getString("bookId"))
        call("action.noteDraftList", payload) { result ->
            if (!result.optBoolean("ok", true)) {
                showError(result.optString("code"))
                return@call
            }
            val drafts = result.getJSONArray("drafts")
            if (drafts.length() == 0) return@call
            val window = draftPager.window(drafts.length())
            val start = window.first
            val end = window.last + 1
            body.addView(text("未保存的本机草稿：${start + 1}–$end / ${drafts.length()}", 19f, true))
            val pager = LinearLayout(activity)
            pager.addView(
                button("上一页草稿") {
                    draftPager.previous()
                    refresh()
                }.apply {
                    isEnabled =
                        start > 0
                },
            )
            pager.addView(
                button("下一页草稿") {
                    draftPager.next()
                    refresh()
                }.apply { isEnabled = end < drafts.length() },
            )
            body.addView(pager)
            for (i in window) {
                val draft = drafts.getJSONObject(i)
                val view = text(draft.optString("text").take(200), 15f)
                view.setTextIsSelectable(true)
                body.addView(view)
                actions(
                    body,
                    listOf(
                        "查看完整草稿" to {
                            val content = text(draft.getString("text"))
                            content.setTextIsSelectable(true)
                            dialog("本机草稿（尚未提交批注）", ScrollView(activity).apply { addView(content) })
                        },
                        "恢复编辑" to {
                            val contextId = draft.getString("contextId")
                            if (contextId.startsWith("anno:")) {
                                call(
                                    "library.annotation",
                                    JSONObject().put("id", contextId.removePrefix("anno:")),
                                ) { editNote(it.getJSONObject("annotation")) }
                            } else {
                                call("library.book", JSONObject().put("id", draft.getString("bookId"))) {
                                    openReader(it.getJSONObject("book"), draft.optString("sourceLoc"))
                                }
                            }
                        },
                        "明确放弃此草稿" to {
                            confirm("删除", "只删除这一份本机草稿，不改动已保存的批注。") {
                                val contextId = draft.getString("contextId")
                                if (!contextId.startsWith("anno:")) {
                                    showError("use_reader_for_this_draft")
                                    return@confirm
                                }
                                userAction(
                                    "noteDraftDiscard",
                                    JSONObject()
                                        .put(
                                            "bookId",
                                            draft.getString("bookId"),
                                        ).put("id", contextId.removePrefix("anno:"))
                                        .put("confirmDiscard", true),
                                )
                            }
                        },
                    ),
                )
            }
        }
    }

    private fun statistics() {
        val panel = NativeStatsPanel(activity, request, navigate, foreground, statisticsState, { DailyBars(it) }, repaint, ::showSettingsRecovery)
        statsPanel = panel
        body.addView(panel.render())
    }

    private fun showSettingsRecovery() {
        if (disposed || !mounted || overlay.visibility != View.VISIBLE) return
        val panel = settingsPanel ?: NativeSettingsPanel(activity, request, preferences, foreground, background, { refresh() }, repaint).also { settingsPanel = it }
        panel.showRecovery()
    }

    private inner class DailyBars(
        private val values: List<Pair<String, Double>>,
    ) : View(activity) {
        private val paint = Paint(Paint.ANTI_ALIAS_FLAG)

        override fun onDraw(canvas: Canvas) {
            super.onDraw(canvas)
            if (values.isEmpty()) return
            val max = values.maxOf { it.second }.coerceAtLeast(1.0)
            val width =
                width.toFloat() / values.size
            val base = height - dp(30).toFloat()
            paint.color = this@NativePagesController.foreground
            paint.textSize = dp(10).toFloat()
            paint.textAlign = Paint.Align.CENTER
            values.forEachIndexed { i, value ->
                val left =
                    i * width + dp(3)
                val right =
                    (i + 1) * width - dp(3)
                val top = base - (base - dp(15)) * (value.second / max).toFloat()
                canvas.drawRect(left, top, right.coerceAtLeast(left + 1), base, paint)
                if (values.size <= 7 || i % 2 == 0) canvas.drawText(value.first, (left + right) / 2, height - dp(10).toFloat(), paint)
            }
        }
    }

    private fun settings() {
        body.addView(text("设置由 Android 原生存储统一管理；旧副本仅供迁移前恢复，不再双写。", 14f))
        body.addView(text("监控文件夹", 20f, true))
        actions(
            body,
            listOf(
                "选择/重新授权" to { userAction("selectFolder") },
                "重新扫描" to { userAction("recheckFolder") },
                "检查任务" to { userAction("fileJobStatus") },
            ),
        )
        val panel = NativeSettingsPanel(activity, request, preferences, foreground, background, { refresh() }, repaint)
        settingsPanel = panel
        body.addView(panel.render())
        body.addView(text("数据", 21f, true))
        body.addView(text("书库位置：${preferences.optString("libraryRoot").ifEmpty { "应用私有目录" }}", 14f))
        actions(
            body,
            listOf(
                "导出书库备份" to { userAction("backupExport") },
                "导入书库备份" to { confirm("导入书库备份", "先选择备份；预览只显示文件大小。确认导入后再由恢复服务校验并合并数据。") { userAction("backupImport") } },
            ),
        )
        body.addView(text("关于", 21f, true))
        body.addView(text("Pagewise · Android 原生管理界面", 16f))
        actions(body, listOf("使用手册" to { navigate("/manual") }))
    }

    private fun manual() {
        actions(
            body,
            manualFiles.map { file ->
                (if (file == "README.md") "目录" else file.removeSuffix(".md").substringAfter('-')) to
                    {
                        manual = file
                        manualAnchor = ""
                        refresh()
                    }
            },
        )
        body.addView(text("离线手册。历史实验功能以当前应用实际可用入口为准。", 13f))
        call("manual.get", JSONObject().put("file", manual)) { result ->
            val renderer = NativeManualRenderer(activity, foreground, background) { href -> manualLink(href) }
            body.addView(renderer.render(result.getString("markdown")))
            if (manualAnchor.isNotEmpty()) renderer.scrollToAnchor(scroll, manualAnchor)
        }
    }

    private fun manualLink(href: String) {
        if (href.startsWith("#")) {
            manualAnchor = href.removePrefix("#")
            refresh()
            return
        }
        val uri = Uri.parse(href)
        if (uri.scheme == null) {
            val file = uri.path.orEmpty().substringAfterLast('/')
            if (file in manualFiles && !href.contains("../")) {
                manual = file
                manualAnchor = uri.fragment.orEmpty()
                refresh()
            } else {
                showError("manual_link_not_packaged")
            }
            return
        }
        if (uri.scheme != "https") {
            showError("blocked_link")
            return
        }
        confirm("打开网页", "将在系统浏览器打开：${uri.host.orEmpty()}。离线手册本身不会联网。") {
            try {
                activity.startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE))
            } catch (
                _: android.content.ActivityNotFoundException,
            ) {
                showError("browser_unavailable")
            }
        }
    }

    private fun duration(seconds: Double): String {
        val minutes = (seconds / 60).toLong()
        return if (minutes >=
            60
        ) {
            "${minutes / 60} 小时 ${minutes % 60} 分钟"
        } else if (minutes > 0) {
            "$minutes 分钟"
        } else {
            "${seconds.toInt()} 秒"
        }
    }

    private fun day(calendar: Calendar) = SimpleDateFormat("yyyy-MM-dd", Locale.ROOT).format(calendar.time)

    private fun dateTime(ms: Long) =
        if (ms <=
            0
        ) {
            ""
        } else {
            SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.getDefault()).format(java.util.Date(ms))
        }
}
