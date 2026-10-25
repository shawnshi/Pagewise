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
import android.text.TextUtils
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
    private val body = NativeContentColumn(activity)
    private val scroll =
        ScrollView(activity).apply {
            isFillViewport = true
            addView(
                body,
                FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                    Gravity.TOP or Gravity.CENTER_HORIZONTAL,
                ),
            )
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
    private val settingsUiState = NativeSettingsUiState()
    private var statsPanel: NativeStatsPanel? = null
    private val libraryState = NativeLibraryUiState()
    private var libraryPanel: NativeLibraryPanel? = null
    private var recommendationPanel: NativeBookRecommendationsPanel? = null
    private var readingRecommendations = false
    private var libraryNoticeHost: NativeContentColumn? = null
    private var currentDialog: AlertDialog? = null
    private var errorDialog: AlertDialog? = null
    private var noteEditor: NativeNoteEditor? = null
    private var introductionEditor: NativeBookIntroductionEditor? = null
    private var settingsPanel: NativeSettingsPanel? = null
    private val obscuredAccessibility = linkedMapOf<View, Int>()
    private var pageTitle: TextView? = null
    private var sectionScrollListener: android.view.ViewTreeObserver.OnScrollChangedListener? = null
    private var sectionNavHost: NativeContentColumn? = null

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
            "更多" to "More",
            "更多操作" to "More actions",
            "选择" to "Select",
            "继续阅读" to "Continue reading",
            "重新关联文件" to "Relink file",
            "重新授权" to "Reauthorize",
            "重新扫描" to "Rescan",
            "移除书目" to "Remove from library",
            "源文件由监控文件夹管理" to "Source file is managed by its monitored folder",
            "未知作者" to "Unknown author",
            "未知出版社" to "Unknown publisher",
            "日期未知" to "Unknown date",
            "未标记" to "Unmarked",
            "在读" to "Reading",
            "想读" to "Want to read",
            "暂缓" to "Paused",
            "已读" to "Finished",
            "弃读" to "Abandoned",
            "文件丢失" to "File missing",
            "需要文件权限" to "File permission required",
            "上次读过" to "Last read",
            "累计" to "Total",
            "阅读进度" to "Reading progress",
            "概览信息" to "Overview",
            "书目" to "Books",
            "推荐" to "Recommendations",
            "相关与拓展" to "Related & extended",
            "目录结构" to "Table of contents",
            "阅读记录" to "Reading records",
            "暂无笔记与高亮标注" to "No notes or highlights",
            "暂无标签" to "No tags",
            "分类" to "Classification",
            "未分类" to "Unclassified",
            "想法" to "Thoughts",
            "标注" to "Highlights",
            "书签" to "Bookmarks",
            "本书笔记" to "Book notes",
            "选择章节" to "Choose chapter",
            "通用" to "General",
            "监控文件夹" to "Monitored folder",
            "藏书显示" to "Library display",
            "阅读与声音" to "Reading and speech",
            "AI 服务" to "AI services",
            "网络" to "Network",
            "数据" to "Data",
            "关于" to "About",
            "选择/重新授权" to "Choose / reauthorize",
            "书库位置" to "Library location",
            "应用私有目录" to "Private app directory",
            "本页按书籍分组，点击查看该书全部记录" to "Grouped by book within this page; open a book for all its records",
            "已移除的书籍" to "Removed book",
            "本页" to "This page",
            "查看记录" to "View records",
            "标注记录总数" to "Annotation record count",
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
            "生成简介" to "Generate introduction",
            "暂无简介，可按书目信息生成。" to "No introduction yet. Generate one from the book metadata.",
            "置顶" to "Pin",
            "取消置顶" to "Unpin",
            "全部" to "All",
            "没有匹配记录" to "No matching records",
            "笔记与标注" to "Notes and highlights",
            "尚无阅读进度" to "No reading progress yet",
            "还没有笔记" to "No notes yet",
            "本书还没有笔记" to "No notes in this book yet",
            "在阅读器中选中文字，即可划线或写下想法。" to "Select text in the reader to highlight it or write a note.",
            "前往藏书" to "Go to Library",
            "文件信息" to "File information",
            "收起文件信息" to "Hide file information",
            "可用" to "Available",
            "格式" to "Format",
            "阅读时长" to "Reading time",
            "加入时间" to "Added",
            "编辑书目信息" to "Edit book details",
            "AI 分类" to "AI classification",
            "秒" to "seconds",
            "分钟" to "minutes",
            "小时" to "hours",
            "需要权限" to "Permission required",
            "页面加载失败，未将读取错误当作空数据。" to "This page could not be loaded. A read error is not an empty result.",
            "目录加载失败，请重试或返回阅读器。" to "The table of contents could not be loaded. Retry or return to the reader.",
        )[zh]
            ?: zh
    }

    private fun text(
        value: String,
        size: Float = 15f,
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
    ) = NativeUi.button(activity, label(title), foreground, background, onClick)

    private fun actions(
        parent: LinearLayout,
        items: List<Pair<String, () -> Unit>>,
    ) {
        val row = NativeActionFlow(activity)
        items.forEach { (title, action) -> row.addView(button(title, action)) }
        parent.addView(row)
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
        if (settingsPanel?.canLeave() == false || statsPanel?.canLeave() == false || libraryPanel?.canLeave() == false ||
            introductionEditor?.canLeave() == false || recommendationPanel?.canLeave() == false
        ) {
            reply("native_operation_pending")
            return
        }
        val editor = noteEditor
        if (editor != null) editor.flushForLeave(reply) else reply(null)
    }

    private fun closeEditorsAfterLeave(closeSettings: Boolean = true) {
        if (introductionEditor?.closeForLeave() == false) throw NativeStateFailure("native_operation_pending")
        if (noteEditor?.closeConfirmed() == false) throw NativeStateFailure("draft_unconfirmed")
        if (closeSettings) {
            recommendationPanel?.close()
            recommendationPanel = null
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
            if (page == "settings") settingsUiState.requested = params.optString("section").takeIf { it.isNotEmpty() }
        }
        this.page = page
        this.params = JSONObject(params.toString())
        if (!mounted) {
            overlay.addView(shell, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            overlay.isFocusableInTouchMode = true
            overlay.isClickable = true
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
        (overlay.parent as? ViewGroup)?.let { parent ->
            for (index in 0 until parent.childCount) {
                val sibling = parent.getChildAt(index)
                if (sibling !== overlay) {
                    obscuredAccessibility.putIfAbsent(sibling, sibling.importantForAccessibility)
                    sibling.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
                }
            }
        }
        overlay.requestApplyInsets()
        overlay.requestFocus()
        refresh()
    }

    fun hide(force: Boolean = false) {
        if (!force) {
            closeEditorsAfterLeave()
        } else {
            recommendationPanel?.close()
            recommendationPanel = null
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
        clearSectionScrollListener()
        overlay.visibility = View.GONE
        obscuredAccessibility.forEach { (view, original) -> view.importantForAccessibility = original }
        obscuredAccessibility.clear()
    }

    fun handleBack(): Boolean {
        if (disposed || !mounted || overlay.visibility != View.VISIBLE) return false
        if (settingsPanel?.handleBack() == true || statsPanel?.handleBack() == true || libraryPanel?.handleBack() == true ||
            recommendationPanel?.handleBack() == true
        ) {
            return true
        }
        if (errorDialog?.isShowing == true) {
            errorDialog?.dismiss()
            return true
        }
        if (currentDialog?.isShowing == true) {
            if (introductionEditor != null) {
                introductionEditor?.requestClose()
                return true
            }
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
        if (event.action == KeyEvent.ACTION_DOWN) {
            if (page == "settings") settingsPanel?.pageScroll(direction) else scroll.pageScroll(direction)
        }
        return true
    }

    fun dispose() {
        if (disposed) return
        disposed = true
        introductionEditor?.dispose()
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
        clearSectionScrollListener()
        shell.removeAllViews()
        body.removeAllViews()
        overlay.setBackgroundColor(background)
        shell.setBackgroundColor(background)
        val rootPage = page in nativeBottomPages
        val contentWidth =
            when (page) {
                "reading", "book" -> 960
                "settings" -> 1200
                "stats" -> 1160
                else -> 1200
            }
        val sidePadding = if (page == "manual") 20 else 24
        body.maxContentDp = contentWidth
        val toolbar =
            LinearLayout(activity).apply {
                gravity = Gravity.CENTER_VERTICAL
                setPadding(dp(sidePadding), dp(12), dp(sidePadding), dp(8))
            }
        if (!rootPage) {
            toolbar.addView(
                NativeUi.iconTextButton(activity, label("返回"), "back", foreground, background) { navigate("@back") },
            )
        }
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
                when (page) {
                    "book" -> 16f
                    "manual" -> 20f
                    "stats", "settings" -> 26f
                    else -> 22f
                },
                true,
            ).apply {
                pageTitle = this
                maxLines = if (page in listOf("library", "stats", "settings")) Int.MAX_VALUE else 1
                if (page in listOf("stats", "settings")) setTypeface(Typeface.SERIF, Typeface.NORMAL)
                ellipsize = TextUtils.TruncateAt.END
                setPadding(if (rootPage) 0 else dp(12), 0, dp(8), 0)
            },
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f),
        )
        if (page !=
            "settings"
        ) {
            toolbar.addView(NativeUi.iconButton(activity, label("核对恢复"), "recovery", foreground, background, ::showSettingsRecovery))
        }
        toolbar.addView(
            NativeUi.iconButton(activity, label("更多操作"), "more", foreground, background) {
                val owner = generation
                val actions =
                    (if (page in listOf("library", "reading")) libraryPanel?.menuActions().orEmpty() else emptyList()) +
                        listOf(label("刷新") to { refresh() }) +
                        pages.map { (key, title) -> label(title) to { navigate(pathFor(key)) } }
                choose(label("菜单"), actions.map { it.first }) { index ->
                    if (!disposed && owner == generation) actions.getOrNull(index)?.second?.invoke()
                }
            },
        )
        val header = FrameLayout(activity)
        header.addView(
            NativeContentColumn(activity).apply {
                orientation = LinearLayout.VERTICAL
                maxContentDp = contentWidth
                addView(toolbar)
            },
            FrameLayout.LayoutParams(-1, -2, Gravity.CENTER_HORIZONTAL),
        )
        shell.addView(header)
        sectionNavHost = null
        libraryNoticeHost = null
        if (page == "library" || page == "reading") {
            val pinned =
                NativeContentColumn(activity).apply {
                    maxContentDp = contentWidth
                    setPadding(dp(sidePadding), 0, dp(sidePadding), 0)
                }
            libraryNoticeHost = pinned
            shell.addView(FrameLayout(activity).apply { addView(pinned, FrameLayout.LayoutParams(-1, -2, Gravity.CENTER_HORIZONTAL)) })
        }
        body.setPadding(dp(sidePadding), dp(8), dp(sidePadding), dp(32))
        (scroll.parent as? ViewGroup)?.removeView(scroll)
        if (page == "settings") {
            (body.parent as? ViewGroup)?.removeView(body)
            val host = FrameLayout(activity).apply { addView(body, FrameLayout.LayoutParams(-1, -1, Gravity.CENTER_HORIZONTAL)) }
            shell.addView(host, LinearLayout.LayoutParams(-1, 0, 1f))
        } else {
            if (body.parent !== scroll) {
                (body.parent as? ViewGroup)?.removeView(body)
                scroll.addView(body, FrameLayout.LayoutParams(-1, -2, Gravity.TOP or Gravity.CENTER_HORIZONTAL))
            }
            shell.addView(scroll, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        }
        shell.addView(line())
        val selected =
            when (page) {
                "book" -> "library"
                "manual" -> "settings"
                else -> page
            }
        val bottom = LinearLayout(activity).apply { setPadding(dp(8), dp(4), dp(8), dp(4)) }
        for (key in nativeBottomPages) {
            bottom.addView(
                NativeUi.navigationItem(activity, label(pages.getValue(key)), key, key == selected, foreground, background) {
                    if (key != page) navigate(pathFor(key))
                },
                LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f),
            )
        }
        shell.addView(bottom)
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

    private fun updateLibrarySummary(
        owner: Long,
        detail: String?,
    ) {
        if (disposed || owner != generation || page != "library") return
        val title = pageTitle ?: return
        val caption = label("藏书")
        val value = if (detail.isNullOrBlank()) caption else "$caption  $detail"
        val styled = android.text.SpannableString(value)
        styled.setSpan(android.text.style.StyleSpan(Typeface.BOLD), 0, caption.length, android.text.Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        if (value.length > caption.length) {
            styled.setSpan(
                android.text.style.RelativeSizeSpan(0.7f),
                caption.length,
                value.length,
                android.text.Spanned.SPAN_EXCLUSIVE_EXCLUSIVE,
            )
            styled.setSpan(
                android.text.style.ForegroundColorSpan(NativeUi.secondary(background)),
                caption.length,
                value.length,
                android.text.Spanned.SPAN_EXCLUSIVE_EXCLUSIVE,
            )
        }
        title.setTypeface(null, Typeface.NORMAL)
        title.text = styled
    }

    private fun books() {
        val owner = generation
        if (page == "reading") {
            val modes = NativeActionFlow(activity)
            for ((recommended, title) in listOf(false to "书目", true to "推荐")) {
                modes.addView(
                    button(title) {
                        if (!disposed && owner == generation && readingRecommendations != recommended) {
                            readingRecommendations = recommended
                            refresh()
                        }
                    }.apply {
                        NativeUi.styleTab(
                            this,
                            readingRecommendations == recommended,
                            this@NativePagesController.foreground,
                            this@NativePagesController.background,
                        )
                    },
                )
            }
            body.addView(modes)
            if (readingRecommendations) {
                val target = column()
                body.addView(target)
                renderRecommendations(target, "reading", null)
                return
            }
        }
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
                ::disableLibraryDialogOperations,
                { detail -> updateLibrarySummary(owner, detail) },
            )
        libraryPanel = panel
        libraryNoticeHost?.addView(panel.notice)
        body.addView(panel.render())
    }

    private fun renderRecommendations(
        target: LinearLayout,
        mode: String,
        referenceId: String?,
        onCount: (Int?) -> Unit = {},
    ) {
        recommendationPanel?.close()
        val owner = generation
        val ownerPage = page
        lateinit var panel: NativeBookRecommendationsPanel
        panel =
            NativeBookRecommendationsPanel(
                activity,
                foreground,
                background,
                preferences.optString("language") == "en",
                mode,
                referenceId,
                request,
                { !disposed && owner == generation && page == ownerPage && recommendationPanel === panel },
                { id -> if (!disposed && owner == generation && recommendationPanel === panel) navigate("/book/${Uri.encode(id)}") },
                { image, id ->
                    request("library.book", JSONObject().put("id", id)) { value, failure ->
                        activity.runOnUiThread {
                            if (!disposed && owner == generation && recommendationPanel === panel && failure == null) {
                                val path = value?.optJSONObject("book")?.optString("coverPath").orEmpty()
                                if (path.isNotBlank() && path != "null") loadCover(image, path)
                            }
                        }
                    }
                },
                { count -> if (!disposed && owner == generation && recommendationPanel === panel) onCount(count) },
            )
        recommendationPanel = panel
        target.removeAllViews()
        target.addView(panel.render())
    }

    private fun bookRow(
        book: JSONObject,
        read: (() -> Unit)? = null,
        details: (() -> Unit)? = null,
    ): View {
        val reading = page == "reading"
        val row =
            object : LinearLayout(activity) {
                override fun onMeasure(
                    widthMeasureSpec: Int,
                    heightMeasureSpec: Int,
                ) {
                    val available = (View.MeasureSpec.getSize(widthMeasureSpec) - paddingLeft - paddingRight).coerceAtLeast(0)
                    val stacked = nativeStackForWidth(available, resources.displayMetrics.density, resources.configuration.fontScale, 480)
                    orientation = if (stacked) VERTICAL else HORIZONTAL
                    if (childCount == 2) {
                        (getChildAt(0).layoutParams as LayoutParams).apply {
                            width = if (stacked) ViewGroup.LayoutParams.MATCH_PARENT else 0
                            weight = if (stacked) 0f else 1f
                        }
                        (getChildAt(1).layoutParams as LayoutParams).apply {
                            width = if (stacked) ViewGroup.LayoutParams.MATCH_PARENT else ViewGroup.LayoutParams.WRAP_CONTENT
                            topMargin = if (stacked) dp(8) else 0
                        }
                    }
                    super.onMeasure(widthMeasureSpec, heightMeasureSpec)
                }
            }.apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(dp(if (reading) 16 else 4), dp(12), dp(if (reading) 16 else 4), dp(12))
                background = NativeUi.bookRowBackground(activity, this@NativePagesController.background, reading)
                layoutParams =
                    LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                        bottomMargin =
                            if (reading) dp(12) else 0
                    }
                isFocusable = true
                isSelected = book.optString("id") in libraryState.selected
                contentDescription = label(if (libraryState.manage) "选择" else "书籍详情") + ": " + book.optString("title")
                accessibilityDelegate =
                    object : View.AccessibilityDelegate() {
                        override fun onInitializeAccessibilityNodeInfo(
                            host: View,
                            info: android.view.accessibility.AccessibilityNodeInfo,
                        ) {
                            super.onInitializeAccessibilityNodeInfo(host, info)
                            info.className = if (libraryState.manage) android.widget.CheckBox::class.java.name else Button::class.java.name
                            info.isCheckable = libraryState.manage
                            info.isChecked = host.isSelected
                        }
                    }
            }
        val coverWidth = if (reading) 72 else 58
        val coverHeight = if (reading) 101 else 78
        val coverBox =
            FrameLayout(activity).apply {
                background =
                    NativeUi.shape(activity, this@NativePagesController.background).apply {
                        cornerRadius = 0f
                        setStroke(dp(1), this@NativePagesController.foreground)
                    }
                clipToOutline = true
                importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
            }
        coverBox.addView(
            text(book.optString("title"), if (reading) 11f else 12f).apply {
                setPadding(dp(4), dp(8), dp(4), dp(4))
                if (reading) gravity = Gravity.CENTER
                maxLines = 5
            },
            FrameLayout.LayoutParams(-1, -1),
        )
        val cover = ImageView(activity).apply { scaleType = ImageView.ScaleType.CENTER_CROP }
        coverBox.addView(cover, FrameLayout.LayoutParams(-1, -1))
        if (reading) {
            coverBox.addView(
                text(book.optString("format").uppercase(), 9f).apply {
                    setTextColor(Color.WHITE)
                    setBackgroundColor(Color.argb(180, 0, 0, 0))
                    setPadding(dp(3), 0, dp(3), 0)
                },
                FrameLayout.LayoutParams(-2, -2, Gravity.TOP or Gravity.START).apply { setMargins(dp(4), dp(4), dp(4), 0) },
            )
        }
        val selectionMark =
            if (libraryState.manage) {
                text(if (row.isSelected) "✓" else "□", 24f, true).apply {
                    gravity = Gravity.CENTER
                    setBackgroundColor(NativeUi.surface(this@NativePagesController.background))
                    setPadding(0, 0, 0, 0)
                }
            } else {
                null
            }
        selectionMark?.let { coverBox.addView(it, FrameLayout.LayoutParams(dp(30), dp(30), Gravity.TOP or Gravity.START)) }
        val content =
            LinearLayout(activity).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
            }
        content.addView(coverBox, LinearLayout.LayoutParams(dp(coverWidth), dp(coverHeight)))
        loadCover(cover, book.optString("coverPath"))
        val info = column()
        val statusName = label(statuses[book.optString("effectiveReadingStatus")] ?: "未标记")
        val hasProgress = !book.isNull("progress") && book.optDouble("progress").isFinite()
        val percent = if (hasProgress) (book.optDouble("progress").coerceIn(0.0, 1.0) * 100).toInt() else 0
        val problem =
            when (book.optString("fileAvailability")) {
                "missing" -> label("文件丢失")
                "permission-denied" -> label("需要文件权限")
                else -> ""
            }
        val tags = book.optJSONArray("tags") ?: JSONArray()
        val tagLabels = (0 until minOf(tags.length(), 3)).map { tags.optString(it) }.filter { it.isNotBlank() }
        val heading = NativeBookHeading(activity)
        heading.addView(
            text(book.optString("title"), if (reading) 16f else 18f, true).apply {
                maxLines = if (reading) 1 else 2
                ellipsize =
                    TextUtils.TruncateAt.END
            },
        )
        if (!reading || tagLabels.isNotEmpty()) {
            heading.addView(
                text(
                    if (reading) {
                        tagLabels.joinToString(" · ")
                    } else {
                        listOf(problem, statusName, if (hasProgress) "$percent%" else "")
                            .filter { it.isNotEmpty() }
                            .joinToString(" · ")
                    },
                    if (reading) 12f else 14f,
                ).apply {
                    if (reading) {
                        maxEms = 12
                        setTextColor(NativeUi.secondary(this@NativePagesController.background))
                    }
                },
            )
        }
        info.addView(heading)
        val author = book.optString("author").takeUnless { it.isBlank() || it == "null" } ?: label("未知作者")
        val byline =
            listOf(author, book.optString("publisher"), publicationDate(book.optString("publicationDate")))
                .filter { it.isNotBlank() && it != "null" }
                .joinToString(" · ")
        info.addView(text(byline, 14f).apply { setTextColor(NativeUi.secondary(this@NativePagesController.background)) })
        if (!reading) {
            info.addView(text(listOf(book.optString("format").uppercase()).plus(tagLabels).joinToString(" · "), 12f))
        }
        if (reading) {
            val metadata = mutableListOf<String>()
            if (book.optLong("lastReadAt") >
                0
            ) {
                metadata.add(label("上次读过") + ": " + dateTime(book.optLong("lastReadAt")).substringBefore(' '))
            }
            val seconds = book.optDouble("readingSeconds", Double.NaN)
            if (!book.isNull("readingSeconds") && seconds.isFinite() && seconds >= 0) {
                val elapsed =
                    if (seconds > 0 && seconds < 60) {
                        if (preferences.optString("language") == "en") "less than 1 min" else "不足1 min"
                    } else {
                        duration(seconds)
                    }
                metadata.add(label("累计") + ": " + elapsed)
            }
            metadata.add(if (hasProgress) label("阅读进度") + ": $percent%" else label("尚无阅读进度"))
            info.addView(
                text(metadata.joinToString(" · "), 12f).apply {
                    setTextColor(NativeUi.secondary(this@NativePagesController.background))
                },
            )
            if (problem.isNotEmpty()) info.addView(text(problem, 13f, true))
        }
        content.addView(
            info,
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { setMargins(dp(16), 0, dp(12), 0) },
        )
        row.addView(content, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        val tools = NativeBookActions(activity)
        val readable = !book.has("supported") || book.optBoolean("supported")
        if (readable) {
            tools.addView(
                NativeUi.primaryButton(
                    activity,
                    label(
                        if (problem.isNotEmpty()) {
                            if (book.optString("fileAvailability") == "permission-denied") "重新授权" else "重新关联文件"
                        } else if (reading ||
                            percent > 0
                        ) {
                            "继续阅读"
                        } else {
                            "阅读"
                        },
                    ),
                    foreground,
                    background,
                ) { bookPrimary(book) { if (read != null) read() else openReader(book) } },
            )
        }
        if (!reading) {
            tools.addView(
                NativeUi.iconTextButton(activity, label("更多"), "more", foreground, background) {
                    if (libraryPanel?.canOperate() != false) bookMenu(book, read, details)
                },
            )
        }
        tools.visibility = if (libraryState.manage) View.GONE else View.VISIBLE
        row.addView(tools)
        row.setOnClickListener {
            if (details != null) details() else navigate("/book/${Uri.encode(book.getString("id"))}")
            if (libraryState.manage) {
                row.isSelected = book.optString("id") in libraryState.selected
                selectionMark?.text = if (row.isSelected) "✓" else "□"
                row.sendAccessibilityEvent(android.view.accessibility.AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED)
            }
        }
        row.setOnKeyListener { _, keyCode, event ->
            if (keyCode in listOf(KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_SPACE)) {
                if (event.action == KeyEvent.ACTION_UP) row.performClick()
                true
            } else {
                false
            }
        }
        row.setOnLongClickListener {
            if (libraryPanel?.canOperate() != false) bookMenu(book, read, details)
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

    private fun bookPrimary(
        book: JSONObject,
        available: () -> Unit = { openReader(book) },
    ) {
        when (book.optString("fileAvailability")) {
            "missing" -> userAction("relinkBook", JSONObject().put("bookId", book.getString("id")))
            "permission-denied" -> navigate("/settings?section=folder")
            else -> available()
        }
    }

    private fun openReader(
        book: JSONObject,
        cfi: String = "",
        draftContextId: String = "",
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
        val query = mutableListOf<String>()
        if (cfi.isNotEmpty()) query.add("loc=${Uri.encode(cfi)}")
        if (draftContextId.isNotEmpty() && book.optString("format") != "pdf") query.add("draft=${Uri.encode(draftContextId)}")
        navigate(path + Uri.encode(book.getString("id")) + if (query.isEmpty()) "" else "?${query.joinToString("&")}")
    }

    private fun bookMenu(
        book: JSONObject,
        read: (() -> Unit)? = null,
        details: (() -> Unit)? = null,
    ) {
        if (libraryPanel?.canOperate() == false) return
        val ownerGeneration = generation
        val linked = !book.isNull("sourceRef")
        val entries = mutableListOf<Pair<String, () -> Unit>>()
        val icons = mutableListOf<String>()
        if (linked) {
            entries.add(label("重新扫描") to { userAction("recheckFolder") })
            icons.add("refresh")
        }
        entries.add(
            label(if (book.isNull("pinnedAt")) "置顶" else "取消置顶") to {
                patchBook(book, JSONObject().put("pinnedAt", if (book.isNull("pinnedAt")) System.currentTimeMillis() else JSONObject.NULL))
            },
        )
        icons.add("pin")
        if (!linked) {
            entries.add(label("移除书目") to { removeBook(book) })
            icons.add("delete")
        }
        val adapter =
            object : android.widget.ArrayAdapter<String>(activity, android.R.layout.simple_list_item_1, entries.map { it.first }) {
                override fun getView(
                    position: Int,
                    convertView: View?,
                    parent: ViewGroup,
                ): View =
                    (super.getView(position, convertView, parent) as TextView).apply {
                        setTextColor(this@NativePagesController.foreground)
                        setCompoundDrawablesRelative(
                            NativeUi.glyph(activity, icons[position], this@NativePagesController.foreground),
                            null,
                            null,
                            null,
                        )
                        compoundDrawablePadding = dp(12)
                        minHeight = dp(48)
                    }
            }
        replaceDialog {
            AlertDialog
                .Builder(activity)
                .setTitle(book.optString("title") + if (linked) "\n" + label("源文件由监控文件夹管理") else "")
                .setAdapter(adapter) { _, index ->
                    if (ownerGeneration == generation && libraryPanel?.canOperate() != false) entries[index].second()
                }.setNegativeButton(label("取消"), null)
                .create()
                .apply {
                    setOnDismissListener { if (currentDialog === this) currentDialog = null }
                    show()
                }
        }
    }

    private fun disableLibraryDialogOperations() {
        currentDialog?.let { dialog ->
            dialog.getButton(AlertDialog.BUTTON_POSITIVE)?.isEnabled = false
            dialog.getButton(AlertDialog.BUTTON_NEUTRAL)?.isEnabled = false
            dialog.listView?.isEnabled = false
        }
    }

    private fun patchBook(
        book: JSONObject,
        patch: JSONObject,
    ) {
        if (libraryPanel?.canMutate() == false) return
        call("library.bookPatch", JSONObject().put("id", book.getString("id")).put("before", book).put("patch", patch)) {
            if (patch.has("pinnedAt")) {
                // Explicit pin/unpin requests a new order; ordinary reader return keeps its snapshot.
                call(
                    "action.librarySessionSave",
                    JSONObject().put("session", JSONObject().put("orderedBookIds", JSONArray())),
                ) { refresh() }
            } else {
                refresh()
            }
        }
    }

    private fun status(book: JSONObject) =
        choose("阅读状态", statuses.values.toList(), statuses.keys.indexOf(book.optString("readingStatus"))) {
            patchBook(book, JSONObject().put("readingStatus", statuses.keys.toList()[it]))
        }

    private fun removeBook(book: JSONObject) {
        if (libraryPanel?.canMutate() == false) return
        val ownerGeneration = generation
        if (!book.isNull("sourceRef") && book.optString("sourceRef").isNotEmpty()) {
            showError("source_linked_book")
            return
        }
        confirm("删除", "移除《${book.optString("title")}》的书目及关联笔记；保留实际书籍文件和阅读统计。此操作不会删除监控文件夹源文件。") {
            if (ownerGeneration != generation || libraryPanel?.canMutate() == false) return@confirm
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
        val epoch = generation
        val bookId = book.getString("id")
        pageTitle?.text = book.optString("title")
        val hero =
            NativeBookHero(activity).apply {
                background = NativeUi.shape(activity, this@NativePagesController.background)
                setPadding(dp(24), dp(24), dp(24), dp(24))
                layoutParams = LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(20) }
            }
        val coverBox =
            FrameLayout(activity).apply {
                background = NativeUi.shape(activity, this@NativePagesController.background)
                clipToOutline =
                    true
            }
        coverBox.addView(
            text(book.optString("title"), 13f, true).apply {
                gravity = Gravity.CENTER
                setPadding(dp(12), dp(12), dp(12), dp(12))
            },
            FrameLayout.LayoutParams(-1, -1),
        )
        val cover =
            ImageView(activity).apply {
                scaleType = ImageView.ScaleType.CENTER_CROP
                contentDescription = book.optString("title")
            }
        coverBox.addView(cover, FrameLayout.LayoutParams(-1, -1))
        loadCover(cover, book.optString("coverPath"))
        coverBox.addView(
            text(book.optString("format").uppercase(), 10f, true).apply {
                setTextColor(Color.WHITE)
                setBackgroundColor(Color.argb(190, 0, 0, 0))
                setPadding(dp(6), dp(2), dp(6), dp(2))
            },
            FrameLayout
                .LayoutParams(
                    -2,
                    -2,
                    Gravity.TOP or Gravity.START,
                ).apply { setMargins(dp(6), dp(6), 0, 0) },
        )
        hero.addView(coverBox, LinearLayout.LayoutParams(dp(140), dp(196)))
        val identity = column()
        identity.addView(
            text(book.optString("title"), 22f, true).apply {
                setTextIsSelectable(true)
                setPadding(0, 0, 0, dp(12))
            },
        )
        identity.addView(
            text(
                listOf("author", "publisher", "publicationDate")
                    .map { if (it == "publicationDate") publicationDate(book.optString(it)) else book.optString(it) }
                    .filter {
                        it.isNotEmpty() &&
                            it != "null"
                    }.joinToString(" · "),
                14f,
            ),
        )
        identity.addView(button(label("阅读状态") + ": " + label(statuses[book.optString("effectiveReadingStatus")] ?: "未标记")) { status(book) })
        if (!book.isNull("progress") && book.optDouble("progress").isFinite()) {
            val p = (book.optDouble("progress").coerceIn(0.0, 1.0) * 100).toInt()
            identity.addView(
                android.widget.ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal).apply {
                    max = 100
                    progress =
                        p
                    progressTintList =
                        android.content.res.ColorStateList
                            .valueOf(this@NativePagesController.foreground)
                    contentDescription =
                        label("阅读进度") + " $p%"
                },
                LinearLayout.LayoutParams(-1, dp(6)).apply { topMargin = dp(12) },
            )
            identity.addView(text("$p%", 12f))
        }
        val mainActions = NativeActionFlow(activity)
        mainActions.addView(
            NativeUi
                .primaryButton(
                    activity,
                    label(
                        if (book.optString("fileAvailability") in
                            setOf("missing", "permission-denied")
                        ) {
                            if (book.optString("fileAvailability") == "permission-denied") "重新授权" else "重新关联文件"
                        } else if (book.optDouble("progress", 0.0) >
                            0
                        ) {
                            "继续阅读"
                        } else {
                            "阅读"
                        },
                    ),
                    foreground,
                    background,
                ) { bookPrimary(book) }
                .apply {
                    isEnabled =
                        !book.has("supported") || book.optBoolean("supported")
                },
        )
        mainActions.addView(
            NativeUi.iconTextButton(
                activity,
                label(if (book.isNull("pinnedAt")) "置顶" else "取消置顶"),
                "pin",
                foreground,
                background,
            ) {
                patchBook(book, JSONObject().put("pinnedAt", if (book.isNull("pinnedAt")) System.currentTimeMillis() else JSONObject.NULL))
            },
        )
        if (book.isNull("sourceRef")) {
            mainActions.addView(NativeUi.iconTextButton(activity, label("移除书目"), "delete", foreground, background) { removeBook(book) })
        } else {
            identity.addView(text(label("源文件由监控文件夹管理"), 13f))
        }
        identity.addView(mainActions)
        hero.addView(identity, LinearLayout.LayoutParams(0, -2, 1f))
        body.addView(hero)
        if (book.optString("fileAvailability") in setOf("missing", "permission-denied")) {
            val recovery = NativeUi.card(activity, background, 16)
            recovery.addView(text(label(if (book.optString("fileAvailability") == "missing") "文件丢失" else "需要文件权限"), 15f, true))
            actions(
                recovery,
                listOf(
                    "重新扫描" to { userAction("recheckFolder") },
                    "设置" to { navigate("/settings?section=folder") },
                    "重新关联文件" to { userAction("relinkBook", JSONObject().put("bookId", bookId)) },
                ),
            )
            body.addView(recovery)
        }
        val tabs = LinearLayout(activity)
        val tabButtons = mutableListOf<Button>()
        val panels =
            listOf(
                NativeUi.card(activity, background),
                NativeUi.card(activity, background),
                NativeUi.card(activity, background),
                NativeUi.card(activity, background),
            )
        val overview = panels[0]
        val toc = panels[1]
        val records = panels[2]
        val recommendations = panels[3]
        var recommendationsStarted = false
        var selected = 0
        var recordsIntent = 0

        fun recordPage(offset: Int) {
            val intent = ++recordsIntent
            records.removeAllViews()
            records.addView(text(label("正在加载…")))
            records.addView(button("重试") { recordPage(offset) })
            call("library.annotations", JSONObject().put("bookId", bookId).put("offset", offset).put("limit", 20)) { value ->
                if (generation != epoch || recordsIntent != intent) return@call
                val items = value.getJSONArray("items")
                val total = value.getInt("total")
                tabButtons.getOrNull(2)?.apply {
                    text = label("笔记与标注") + " ($total)"
                    contentDescription = text
                }
                records.removeAllViews()
                if (items.length() == 0) records.addView(text(label("暂无笔记与高亮标注"), 14f))
                for (i in 0 until items.length()) {
                    val note = items.getJSONObject(i)
                    val row = column().apply { setPadding(0, dp(10), 0, dp(10)) }
                    row.addView(
                        text(
                            label(if (note.optString("kind") == "bookmark") "书签" else "高亮") + " · " + dateTime(note.optLong("createdAt")),
                            12f,
                        ),
                    )
                    if (note
                            .optString(
                                "text",
                            ).isNotEmpty()
                    ) {
                        row.addView(text("“${note.optString("text")}”", 14f).apply { setTextIsSelectable(true) })
                    }
                    if (!note.isNull("note") &&
                        note.optString("note").isNotEmpty()
                    ) {
                        row.addView(text(label("想法") + ": " + note.optString("note"), 13f).apply { setTextIsSelectable(true) })
                    }
                    records.addView(row)
                    records.addView(line())
                }
                if (total > 20) {
                    val pager = LinearLayout(activity)
                    pager.addView(button("上页") { recordPage((offset - 20).coerceAtLeast(0)) }.apply { isEnabled = offset > 0 })
                    pager.addView(button("下页") { recordPage(offset + 20) }.apply { isEnabled = offset + items.length() < total })
                    records.addView(pager)
                }
                actions(records, listOf("本书笔记" to { navigate("/notes?bookId=${Uri.encode(bookId)}") }))
            }
        }

        fun select(index: Int) {
            if (disposed || epoch != generation || recommendationPanel?.canLeave() == false) return
            if (index != 3 && selected == 3) {
                recommendationPanel?.close()
                recommendationPanel = null
                recommendationsStarted = false
                recommendations.removeAllViews()
            }
            selected = index
            panels.forEachIndexed { i, view -> view.visibility = if (i == index) View.VISIBLE else View.GONE }
            tabButtons.forEachIndexed { i, view -> NativeUi.styleTab(view, i == index, foreground, background) }
            if (index == 1) bookToc(bookId, toc) { selected == 1 && epoch == generation }
            if (index == 2) recordPage(0)
            if (index == 3 && !recommendationsStarted) {
                recommendationsStarted = true
                renderRecommendations(recommendations, "detail", bookId) { count ->
                    tabButtons.getOrNull(3)?.apply {
                        text = label("相关与拓展") + if (count == null) "" else " ($count)"
                        contentDescription = text
                    }
                }
            }
        }
        listOf("概览信息", "目录结构", "笔记与标注", "相关与拓展").forEachIndexed { index, title ->
            val tab = button(title) { select(index) }
            tabButtons.add(tab)
            tabs.addView(tab)
        }
        body.addView(
            android.widget.HorizontalScrollView(activity).apply {
                isHorizontalScrollBarEnabled = false
                addView(tabs)
            },
        )
        body.addView(line())
        panels.forEach { body.addView(it) }
        val details =
            listOf(
                "格式" to book.optString("format"),
                "作者" to book.optString("author"),
                "出版社" to book.optString("publisher"),
                "出版日期" to publicationDate(book.optString("publicationDate")),
                "语言" to languageName(book.optString("language")),
                "阅读状态" to label(statuses[book.optString("effectiveReadingStatus")] ?: "未标记"),
                "阅读时长" to duration(book.optDouble("readingSeconds", 0.0)),
                "最近阅读" to dateTime(book.optLong("lastReadAt")),
                "加入时间" to dateTime(book.optLong("addedAt")),
                "文件状态" to
                    label(
                        when (val value = book.optString("fileAvailability")) {
                            "available" -> "可用"
                            "missing" -> "文件丢失"
                            "permission-denied" -> "需要权限"
                            else -> value
                        },
                    ),
                "来源" to book.optString("source"),
                "文件名" to book.optString("fileName"),
                "源相对路径" to (book.optJSONObject("sourceRef")?.optString("relativePath") ?: ""),
            )
        val metadata = NativeMetadataGrid(activity)
        val fileMetadata = NativeMetadataGrid(activity).apply { visibility = View.GONE }
        val fileKeys = setOf("文件状态", "来源", "文件名", "源相对路径")
        details.filter { it.second.isNotEmpty() && it.second != "null" }.forEach { (key, value) ->
            (if (key in fileKeys) fileMetadata else metadata).addView(
                text(label(key) + ": " + value, 14f).apply { setTextIsSelectable(true) },
            )
        }
        overview.addView(metadata)
        if (fileMetadata.childCount > 0) {
            val toggle = button("文件信息") {}
            toggle.setOnClickListener {
                fileMetadata.visibility = if (fileMetadata.visibility == View.VISIBLE) View.GONE else View.VISIBLE
                toggle.text = label(if (fileMetadata.visibility == View.VISIBLE) "收起文件信息" else "文件信息")
                toggle.contentDescription = toggle.text
            }
            overview.addView(toggle)
            overview.addView(fileMetadata)
        }
        val tags = book.optJSONArray("tags") ?: JSONArray()
        overview.addView(
            text(
                label("标签") + ": " +
                    if (tags.length() == 0) label("暂无标签") else (0 until tags.length()).joinToString(" · ") { tags.optString(it) },
                14f,
            ),
        )
        val description = book.optString("description")
        overview.addView(text(label("简介"), 16f, true))
        overview.addView(
            text(
                if (description.isNotEmpty() &&
                    description != "null"
                ) {
                    description
                } else {
                    label("暂无简介，可按书目信息生成。")
                },
                14f,
            ).apply { setTextIsSelectable(true) },
        )
        actions(overview, listOf("生成简介" to { openBookIntroduction(book) }))
        val classification = book.optJSONObject("classification")
        if (classification != null) {
            overview.addView(text(label("分类"), 18f, true))
            overview.addView(text(classification.optJSONObject("category")?.optString("value") ?: label("未分类"), 14f))
            val topics = classification.optJSONArray("topics") ?: JSONArray()
            if (topics.length() >
                0
            ) {
                overview.addView(
                    text((0 until topics.length()).joinToString(" · ") { topics.getJSONObject(it).getString("value") }, 14f),
                )
            }
            classification.optJSONObject("feature")?.let { overview.addView(text(it.optString("value"), 14f)) }
            classification.optJSONObject("facets")?.let { facets ->
                overview.addView(
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
            overview,
            listOf("编辑书目信息" to { editBook(book) }, "标签" to { editTags(book) }, "AI 分类" to { openClassification(bookId, true) }),
        )
        select(0)
        recordPage(0)
    }

    private fun bookToc(
        bookId: String,
        target: LinearLayout? = null,
        isCurrent: () -> Boolean = { true },
    ) {
        val epoch = generation
        var intent = if (target == null) ++dialogIntent else dialogIntent
        val instance = Any()
        target?.tag = instance
        var busy = false
        var context = ""
        var window: AlertDialog? = null
        val form = target ?: column()
        if (target != null) {
            form.removeAllViews()
            form.addView(text(label("正在加载…")))
        }

        fun fetch(offset: Int) {
            if (busy) return
            busy = true
            val payload = JSONObject().put("bookId", bookId).put("offset", offset).put("limit", 50)
            if (context.isNotEmpty()) payload.put("token", context)
            request("action.bookToc", payload) { result, error ->
                activity.runOnUiThread {
                    busy = false
                    if (disposed || epoch != generation || !isCurrent() ||
                        (target != null && target.tag !== instance) ||
                        (target == null && intent != dialogIntent) ||
                        (window != null && window?.isShowing != true)
                    ) {
                        return@runOnUiThread
                    }
                    if (error != null || result == null) {
                        if (target == null) {
                            showError(error ?: "invalid_response")
                        } else {
                            form.removeAllViews()
                            form.addView(text(label("目录加载失败，请重试或返回阅读器。") + "\n" + (error ?: "invalid_response")))
                            form.addView(button("重试") { fetch(offset) })
                        }
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
                    if (window == null && target == null) {
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

    private fun openBookIntroduction(book: JSONObject) {
        val owner = generation
        val id = book.getString("id")
        replaceDialog {
            lateinit var editor: NativeBookIntroductionEditor
            editor =
                NativeBookIntroductionEditor(
                    activity,
                    book,
                    foreground,
                    background,
                    preferences.optString("language") == "en",
                    request,
                    { !disposed && owner == generation && page == "book" && params.optString("id") == id && introductionEditor === editor },
                    { if (!disposed && owner == generation && page == "book" && params.optString("id") == id) refresh() },
                    { closedDialog ->
                        if (introductionEditor === editor) introductionEditor = null
                        if (currentDialog === closedDialog) currentDialog = null
                    },
                )
            introductionEditor = editor
            editor.show()
        }
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
        val bookId = params.optString("bookId")
        if (bookId.isNotEmpty()) {
            body.addView(
                NativeUi.iconTextButton(activity, label("全部笔记"), "back", foreground, background) {
                    navigate("/notes")
                },
            )
        }
        showDrafts()
        val filterRow = LinearLayout(activity)
        listOf("all" to "全部", "thoughts" to "想法", "highlights" to "标注", "bookmarks" to "书签").forEach { (id, title) ->
            filterRow.addView(
                button(title) {
                    noteFilter = id
                    offset = 0
                    refresh()
                }.apply {
                    NativeUi.styleTab(
                        this,
                        noteFilter == id,
                        this@NativePagesController.foreground,
                        this@NativePagesController.background,
                    )
                },
            )
        }
        body.addView(
            android.widget.HorizontalScrollView(activity).apply {
                isHorizontalScrollBarEnabled = false
                addView(filterRow)
            },
        )
        search(hint = "搜索选区原文、想法或书名")
        val payload =
            JSONObject()
                .put("query", query)
                .put("filter", noteFilter)
                .put("offset", offset)
                .put("limit", PAGE_SIZE)
        if (bookId.isNotEmpty()) payload.put("bookId", bookId)
        call("library.annotations", payload) { response ->
            val items = response.getJSONArray("items")
            if (items.length() == 0) {
                val unfiltered = query.isBlank() && noteFilter == "all"
                body.addView(
                    text(
                        label(
                            if (!unfiltered) {
                                "没有匹配记录"
                            } else if (bookId.isEmpty()) {
                                "还没有笔记"
                            } else {
                                "本书还没有笔记"
                            },
                        ),
                        18f,
                        true,
                    ),
                )
                if (unfiltered) {
                    body.addView(text(label("在阅读器中选中文字，即可划线或写下想法。")))
                    body.addView(button("前往藏书") { navigate("/library") })
                }
            }
            if (bookId.isNotEmpty()) {
                if (items.length() > 0) pageTitle?.text = items.getJSONObject(0).optString("bookTitle", label("全部笔记"))
                for (i in 0 until items.length()) noteRow(items.getJSONObject(i))
            } else {
                // Native backend pages annotation records, not all books. Never present a page-local count as a global count.
                if (items.length() > 0) body.addView(text(label("本页按书籍分组，点击查看该书全部记录"), 12f))
                val groups = linkedMapOf<String, MutableList<JSONObject>>()
                for (i in 0 until items.length()) {
                    val note = items.getJSONObject(i)
                    groups.getOrPut(note.optString("bookId")) { mutableListOf() }.add(note)
                }
                for ((id, records) in groups) {
                    if (id.isEmpty()) {
                        records.forEach(::noteRow)
                        continue
                    }
                    val card = NativeUi.card(activity, background, 16)
                    card.addView(text(records[0].optString("bookTitle", label("已移除的书籍")), 18f, true))
                    val highlightCount = records.count { it.optString("kind") != "bookmark" }
                    val thoughtCount = records.count { !it.isNull("note") && it.optString("note").isNotEmpty() }
                    val bookmarkCount = records.count { it.optString("kind") == "bookmark" }
                    card.addView(
                        text(
                            label("本页") + ": " + label("标注") + " $highlightCount · " + label("想法") + " $thoughtCount · " + label("书签") +
                                " $bookmarkCount",
                            13f,
                        ),
                    )
                    card.addView(text(dateTime(records.maxOf { it.optLong("createdAt") }), 12f))
                    val open = { navigate("/notes?bookId=${Uri.encode(id)}") }
                    card.addView(NativeUi.iconTextButton(activity, label("查看记录"), "next", foreground, background, open))
                    card.isFocusable = true
                    card.contentDescription = records[0].optString("bookTitle") + ", " + label("查看记录")
                    card.setOnClickListener { open() }
                    body.addView(card)
                }
            }
            body.addView(text(label("标注记录总数") + ": " + response.getInt("total"), 12f))
            if (response.getInt("total") > PAGE_SIZE || offset > 0) pageControls(response.getInt("total"), items.length())
        }
    }

    private fun noteRow(note: JSONObject) {
        val card =
            column().apply {
                setPadding(dp(16), dp(12), dp(16), dp(12))
                background = NativeUi.shape(activity, this@NativePagesController.background)
                layoutParams = LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(12) }
            }
        val header = LinearLayout(activity).apply { gravity = Gravity.CENTER_VERTICAL }
        header.addView(
            ImageView(activity).apply {
                setImageDrawable(
                    NativeUi.glyph(
                        activity,
                        if (note.optString("kind") ==
                            "bookmark"
                        ) {
                            "bookmark"
                        } else {
                            "annotations"
                        },
                        this@NativePagesController.foreground,
                    ),
                )
                ; importantForAccessibility =
                    View.IMPORTANT_FOR_ACCESSIBILITY_NO
            },
            LinearLayout.LayoutParams(dp(20), dp(20)).apply { marginEnd = dp(8) },
        )
        header.addView(
            text(
                label(
                    if (note.optString("kind") ==
                        "bookmark"
                    ) {
                        "书签"
                    } else {
                        "标注"
                    },
                ),
                13f,
                true,
            ),
            LinearLayout.LayoutParams(0, -2, 1f),
        )
        header.addView(text(dateTime(note.optLong("createdAt")), 12f))
        card.addView(header)
        if (params.optString("bookId").isEmpty()) card.addView(text(note.optString("bookTitle", label("已移除的书籍")), 15f, true))
        if (note.optString("text").isNotEmpty()) {
            val quote = LinearLayout(activity).apply { setBackgroundColor(NativeUi.mutedSurface(this@NativePagesController.background)) }
            quote.addView(
                View(activity).apply { setBackgroundColor(this@NativePagesController.foreground) },
                LinearLayout.LayoutParams(dp(3), -1),
            )
            quote.addView(
                text("“${note.optString("text")}”", 15f).apply {
                    setPadding(dp(12), dp(8), dp(8), dp(8))
                    setTextIsSelectable(true)
                },
                LinearLayout.LayoutParams(0, -2, 1f),
            )
            card.addView(quote)
        }
        if (!note.isNull("note") &&
            note.optString("note").isNotEmpty()
        ) {
            card.addView(text(label("想法") + ": " + note.getString("note"), 14f).apply { setTextIsSelectable(true) })
        } else if (note.optString("kind") != "bookmark") {
            card.addView(button("添加想法") { editNote(note) })
        }
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
            body.addView(text("本机草稿：${start + 1}–$end / ${drafts.length()}", 19f, true))
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
                            dialog("本机草稿（保存状态需核对）", ScrollView(activity).apply { addView(content) })
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
                                    val book = it.getJSONObject("book")
                                    if (contextId.startsWith("sel:") &&
                                        book.optString("format") != "pdf"
                                    ) {
                                        openReader(book, draftContextId = contextId)
                                    } else {
                                        openReader(book, draft.optString("sourceLoc"))
                                    }
                                }
                            }
                        },
                        "明确放弃此草稿" to {
                            confirm("删除", "只删除这一份本机草稿，不改动已保存的批注。") {
                                val contextId = draft.getString("contextId")
                                val payload = JSONObject().put("bookId", draft.getString("bookId"))
                                if (contextId.startsWith("anno:")) {
                                    payload.put("id", contextId.removePrefix("anno:"))
                                } else if (contextId.startsWith("sel:")) {
                                    payload.put("contextId", contextId)
                                } else {
                                    showError("use_reader_for_this_draft")
                                    return@confirm
                                }
                                userAction("noteDraftDiscard", payload.put("confirmDiscard", true))
                            }
                        },
                    ),
                )
            }
        }
    }

    private fun statistics() {
        val panel =
            NativeStatsPanel(
                activity,
                request,
                navigate,
                foreground,
                statisticsState,
                { DailyBars(it) },
                repaint,
                ::showSettingsRecovery,
                initialEnglish =
                    preferences.optString("language") == "en",
            )
        statsPanel = panel
        body.addView(panel.render())
    }

    private fun showSettingsRecovery() {
        if (disposed || !mounted || overlay.visibility != View.VISIBLE) return
        val panel =
            settingsPanel
                ?: NativeSettingsPanel(activity, request, preferences, foreground, background, { refresh() }, repaint).also {
                    settingsPanel =
                        it
                }
        panel.showRecovery()
    }

    private inner class DailyBars(
        private val values: List<Pair<String, Double>>,
    ) : View(activity) {
        private val paint = Paint(Paint.ANTI_ALIAS_FLAG)

        override fun onDraw(canvas: Canvas) {
            super.onDraw(canvas)
            if (values.isEmpty() || width <= 0) return
            val max = values.maxOf { it.second }.coerceAtLeast(1.0)
            val step = width.toFloat() / values.size
            paint.color = this@NativePagesController.foreground
            paint.textSize = 14f * resources.displayMetrics.scaledDensity
            val metrics = paint.fontMetrics
            val base = height - (metrics.bottom - metrics.top) - dp(12)
            val topInset = (metrics.bottom - metrics.top) + dp(12)
            paint.textAlign = Paint.Align.LEFT
            canvas.drawText(String.format(java.util.Locale.ROOT, "%.0f s", max), 0f, -metrics.top, paint)
            val labelWidth = values.maxOf { paint.measureText(it.first) }
            val stride =
                kotlin.math
                    .ceil((labelWidth + dp(12)) / step)
                    .toInt()
                    .coerceAtLeast(1)
            paint.textAlign = Paint.Align.CENTER
            values.forEachIndexed { i, value ->
                val left = i * step + dp(3)
                val right = (i + 1) * step - dp(3)
                val top = base - (base - topInset).coerceAtLeast(0f) * (value.second / max).toFloat()
                canvas.drawRect(left, top, right.coerceAtLeast(left + 1), base, paint)
                if (i % stride == 0) canvas.drawText(value.first, (left + right) / 2, height - metrics.bottom, paint)
            }
        }
    }

    private fun clearSectionScrollListener() {
        sectionScrollListener?.let { if (scroll.viewTreeObserver.isAlive) scroll.viewTreeObserver.removeOnScrollChangedListener(it) }
        sectionScrollListener = null
    }

    private fun settings() {
        val folder = column()
        folder.addView(text("选择或重新授权后扫描；原文件任务入口保留真实进度和错误。", 13f))
        val folderActions = NativeActionFlow(activity)
        folderActions.addView(
            NativeUi.iconTextButton(activity, label("选择/重新授权"), "folder", foreground, background) { userAction("selectFolder") },
        )
        folderActions.addView(
            NativeUi.iconTextButton(activity, label("重新扫描"), "refresh", foreground, background) { userAction("recheckFolder") },
        )
        folderActions.addView(button("检查任务") { userAction("fileJobStatus") })
        folder.addView(folderActions)
        val data = column()
        data.addView(text(label("书库位置") + ": " + preferences.optString("libraryRoot").ifEmpty { label("应用私有目录") }, 14f))
        actions(
            data,
            listOf(
                "导出书库备份" to { userAction("backupExport") },
                "导入书库备份" to { confirm("导入书库备份", "先选择备份；预览只显示文件大小。确认导入后再由恢复服务校验并合并数据。") { userAction("backupImport") } },
            ),
        )
        val about = column()
        about.addView(text("Pagewise · Android", 16f, true))
        about.addView(text("设置由 Android 原生存储统一管理；旧副本仅供迁移前恢复，不再双写。", 13f))
        actions(about, listOf("使用手册" to { navigate("/manual") }))

        val panel = NativeSettingsPanel(activity, request, preferences, foreground, background, { refresh() }, repaint)
        settingsPanel = panel
        val requested = settingsUiState.requested
        settingsUiState.requested = null
        body.addView(panel.renderPage(mapOf("folder" to folder, "data" to data, "about" to about), requested, settingsUiState))
    }

    private fun manual() {
        body.addView(text("离线手册。历史实验功能以当前应用实际可用入口为准。", 12f))
        val pane = NativeReferencePane(activity)
        val rail = column()
        val article = NativeUi.card(activity, background, 20)
        val names = manualFiles.map { file -> if (file == "README.md") label("目录") else file.removeSuffix(".md").substringAfter('-') }

        fun select(index: Int) {
            if (index !in manualFiles.indices || manualFiles[index] == manual) return
            manual = manualFiles[index]
            manualAnchor = ""
            refresh()
        }
        names.forEachIndexed { index, title ->
            rail.addView(
                button(title) { select(index) }.apply {
                    gravity = Gravity.START or Gravity.CENTER_VERTICAL
                    NativeUi.styleTab(
                        this,
                        manualFiles[index] == manual,
                        this@NativePagesController.foreground,
                        this@NativePagesController.background,
                    )
                },
            )
        }
        val selector =
            android.widget.Spinner(activity).apply {
                contentDescription = label("选择章节")
                adapter =
                    object : android.widget.ArrayAdapter<String>(activity, android.R.layout.simple_spinner_dropdown_item, names) {
                        override fun getView(
                            position: Int,
                            convertView: View?,
                            parent: ViewGroup,
                        ): View =
                            (super.getView(position, convertView, parent) as TextView).apply {
                                setTextColor(this@NativePagesController.foreground)
                                minHeight =
                                    dp(48)
                            }
                    }
                setSelection(manualFiles.indexOf(manual).coerceAtLeast(0))
                onItemSelectedListener =
                    object : android.widget.AdapterView.OnItemSelectedListener {
                        override fun onNothingSelected(parent: android.widget.AdapterView<*>?) = Unit

                        override fun onItemSelected(
                            parent: android.widget.AdapterView<*>?,
                            view: View?,
                            position: Int,
                            id: Long,
                        ) {
                            select(position)
                        }
                    }
            }
        pane.addView(rail)
        pane.addView(selector)
        pane.addView(article)
        body.addView(pane)
        call("manual.get", JSONObject().put("file", manual)) { result ->
            val renderer = NativeManualRenderer(activity, foreground, background) { href -> manualLink(href) }
            article.addView(renderer.render(result.getString("markdown")))
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

    private fun publicationDate(value: String): String {
        val raw = value.trim().takeUnless { it == "null" } ?: return ""
        return if (Regex("^[0-9]{4}-[0-9]{2}-[0-9]{2}T").containsMatchIn(raw)) raw.take(10) else raw
    }

    private fun languageName(value: String): String {
        if (value.isEmpty() || value == "null") return ""
        val locale = if (preferences.optString("language") == "en") java.util.Locale.ENGLISH else java.util.Locale.CHINESE
        return java.util.Locale
            .forLanguageTag(value)
            .getDisplayName(locale)
            .ifEmpty { value }
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
