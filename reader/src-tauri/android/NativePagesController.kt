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
                "paused" to "暂缓",
                "finished" to "已读",
                "abandoned" to "弃读",
            )
        private val manualFiles = listOf("README.md", "01-读书方法.md", "02-阅读模式.md", "03-声音.md", "04-使用说明.md", "05-伴读.md")
    }

    private val overlay = FrameLayout(activity)
    private val shell = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }
    private val body = NativeContentColumn(activity)
    private val scroll =
        NativeUi.configureEinkScroll(
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
            },
        )
    private var mounted = false
    private var disposed = false
    private var generation = 0L
    private var refreshIntent = 0L
    private var dialogIntent = 0L
    private var page = "library"
    private var params = JSONObject()
    private var preferences = JSONObject()
    private var preferencesStale = true
    private var foreground = Color.BLACK
    private var background = Color.WHITE
    private var query = ""
    private var offset = 0
    private var pageTotal = 0
    private var pageShown = 0
    private var showTransitionCount = 0
    private var sort = "recent"
    private var statusFilter = ""
    private var kindFilter = ""
    private var noteFilter = "all"
    private var exportBusy = false
    private val savedQueries = mutableMapOf<String, String>()
    private val savedNoteFilters = mutableMapOf<String, String>()
    private val savedOffsets = mutableMapOf<String, Int>()
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
    private var recoveryNeeded = false
    private var recoveryToolbarButton: android.widget.ImageButton? = null
    private var sectionScrollListener: android.view.ViewTreeObserver.OnScrollChangedListener? = null
    private var sectionNavHost: NativeContentColumn? = null
    private var bottomNavBar: LinearLayout? = null
    private var activeManualRenderer: NativeManualRenderer? = null
    private val exportExecutor = java.util.concurrent.Executors.newSingleThreadExecutor()

    private fun dp(n: Int) = (n * activity.resources.displayMetrics.density).toInt()

    private fun isEnglish(): Boolean = preferences.optString("language") == "en"

    private fun tr(
        zh: String,
        en: String,
    ): String = if (isEnglish()) en else zh

    private fun routeStateKey(
        pageName: String,
        p: JSONObject,
    ): String =
        if ((pageName == "annotations" || pageName == "notes") && p.optString("bookId").isNotEmpty()) {
            "annotations:${p.optString("bookId")}"
        } else {
            pageName
        }

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
            "再次阅读" to "Read again",
            "开始阅读" to "Start reading",
            "核对未保存设置 / 恢复" to "Inspect unsaved settings / recovery",
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
            "搁置" to "Paused",
            "已读" to "Finished",
            "读完" to "Finished",
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
            "高亮" to "Highlight",
            "书签" to "Bookmarks",
            "重点" to "Key point",
            "核心" to "Core",
            "存疑" to "Question",
            "概念" to "Concept",
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
            "回到原文" to "Jump to source",
            "原文" to "Source",
            "标注记录总数" to "Annotation record count",
            "返回" to "Back",
            "关闭" to "Close",
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
            "补全元数据" to "Complete metadata",
            "著录元数据补全与精修" to "Metadata completion",
            "前情提要" to "Catch-up",
            "导出读书笔记" to "Export notes",
            "复制 Markdown" to "Copy Markdown",
            "系统分享" to "Share",
            "已复制到剪贴板" to "Copied to clipboard",
            "跨书对比预览" to "Cross-book matrix",
            "仅补全空白字段" to "Fill empty fields only",
            "覆盖已有字段" to "Overwrite existing fields",
            "推荐匹配" to "Recommended match",
            "AI 分类" to "AI classification",
            "秒" to "seconds",
            "分钟" to "minutes",
            "小时" to "hours",
            "需要权限" to "Permission required",
            "分类与标签" to "Classification and tags",
            "页面加载失败，未将读取错误当作空数据。" to "This page could not be loaded. A read error is not an empty result.",
            "目录加载失败，请重试或返回阅读器。" to "The table of contents could not be loaded. Retry or return to the reader.",
            "在阅读器内跳转章节" to "Jump to chapter in reader",
            "导出读书笔记" to "Export notes",
            "跨书对比预览" to "Cross-book matrix",
            "全部笔记" to "All notes",
            "搜索选区原文、想法或书名" to "Search quotes, thoughts or title",
            "前情提要" to "Catch-up",
            "正在导出…" to "Exporting…",
            "保存为 Markdown 文件" to "Save as Markdown file",
            "已保存到所选文件" to "Saved to selected file",
            "操作未完成" to "Operation incomplete",
            "状态" to "State",
            "文件夹状态" to "Folder status",
            "重新关联" to "Relink book",
            "打开网页" to "Open link",
            "恢复默认排版" to "Reset reader typography",
            "清除显示校准" to "Clear display calibration",
            "导出书库备份" to "Export library backup",
            "导入书库备份" to "Import library backup",
            "校验并导入" to "Verify and import",
            "检查任务" to "Check task",
            "来源" to "Source",
            "文件状态" to "File status",
            "最近阅读" to "Last read",
            "添加想法" to "Add thought",
            "上一页草稿" to "Previous drafts",
            "下一页草稿" to "Next drafts",
            "查看完整草稿" to "View full draft",
            "本机草稿（保存状态需核对）" to "Local draft (verify save state)",
            "恢复编辑" to "Resume editing",
            "明确放弃此草稿" to "Discard this draft",
            "搜索书名、作者、笔记" to "Search title, author, or notes",
            "清除搜索" to "Clear search",
            "空白" to "Empty",
            "已有" to "Set",
            "正在检查监控文件夹状态…" to "Checking monitored folder status…",
            "点击下方按钮发起公开书目并发检索或 AI 推理补全。" to "Search public catalogs or infer metadata with AI below.",
            "检索公开书目 (第一级)" to "Search public catalogs (Tier 1)",
            "正在检索 OpenLibrary / Google Books / 豆瓣…" to "Searching OpenLibrary / Google Books / Douban…",
            "公开书目库未检索到匹配项，可尝试第二级 AI 推理。" to "No catalog match found; try Tier 2 AI inference.",
            "AI 智能推理 (第二级)" to "AI Metadata Inference (Tier 2)",
            "AI 正在推理著录信息…请稍候。" to "Inferring metadata with AI…",
            "AI 推理未成功，请检查 AI 配置后重试。" to "AI inference failed; check AI settings and retry.",
            "AI 未能推断出更多有效著录字段。" to "AI did not infer additional metadata fields.",
            "AI 著录推理完成，已填入表单，核对后点击保存。" to "AI inference populated fields; review and save.",
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
            setBackgroundColor(NativeUi.divider(this@NativePagesController.background))
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
        setHintTextColor(NativeUi.disabled(this@NativePagesController.background))
        this.background = NativeUi.shape(activity, this@NativePagesController.background)
        textSize = 17f
        minHeight = dp(48)
        setPadding(dp(10), dp(8), dp(10), dp(8))
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
        positiveLabel: String = "保存",
        negativeLabel: String = "取消",
        cancelableOutside: Boolean = true,
        save: (() -> Unit)? = null,
    ) {
        replaceDialog {
            val captions =
                if (save != null) {
                    listOf(
                        AlertDialog.BUTTON_POSITIVE to label(positiveLabel),
                        AlertDialog.BUTTON_NEGATIVE to label(negativeLabel),
                    )
                } else {
                    listOf(AlertDialog.BUTTON_NEGATIVE to label(negativeLabel))
                }
            val result =
                NativeEinkDialog(
                    activity,
                    label(title),
                    view,
                    foreground,
                    background,
                    captions,
                    cancelableOutside = cancelableOutside,
                    onDismissed = repaint,
                )
            if (save != null) {
                result.setOnShowListener {
                    result.getButton(AlertDialog.BUTTON_POSITIVE)?.setOnClickListener { save() }
                }
            }
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
            val list = column()
            lateinit var result: NativeEinkDialog
            options.forEachIndexed { index, caption ->
                val itemBtn =
                    if (index == selected) {
                        NativeUi.primaryButton(activity, caption, foreground, background) {
                            result.dismiss()
                            action(index)
                        }
                    } else {
                        NativeUi.button(activity, caption, foreground, background) {
                            result.dismiss()
                            action(index)
                        }
                    }
                itemBtn.gravity = Gravity.START or Gravity.CENTER_VERTICAL
                list.addView(
                    itemBtn,
                    LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                        if (index < options.lastIndex) bottomMargin = dp(8)
                    },
                )
            }
            result =
                NativeEinkDialog(
                    activity,
                    label(title),
                    list,
                    foreground,
                    background,
                    listOf(AlertDialog.BUTTON_NEGATIVE to label("取消")),
                    onDismissed = repaint,
                )
            result.show()
            result
        }
    }

    private fun confirm(
        title: String,
        message: String,
        action: () -> Unit,
    ) {
        replaceDialog {
            val msgView =
                text(message, 15f).apply {
                    setLineSpacing(0f, 1.4f)
                }
            val result =
                NativeEinkDialog(
                    activity,
                    label(title),
                    msgView,
                    foreground,
                    background,
                    listOf(
                        AlertDialog.BUTTON_POSITIVE to label(title),
                        AlertDialog.BUTTON_NEGATIVE to label("取消"),
                    ),
                    cancelableOutside = false,
                    onDismissed = repaint,
                )
            result.setOnShowListener {
                result.getButton(AlertDialog.BUTTON_POSITIVE)?.setOnClickListener {
                    result.dismiss()
                    action()
                }
            }
            result.show()
            result
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
        val cleanCode = code.take(80).replace(Regex("[^a-zA-Z0-9_-]"), "")
        val detail =
            when (code) {
                "settings_conflict", "book_conflict", "annotation_conflict", "conflict" ->
                    tr(
                        "数据已被其他操作修改；请刷新后核对，不会覆盖较新的内容。",
                        "Data changed elsewhere. Refresh and inspect before retrying; newer content will not be overwritten.",
                    )
                "source_linked_book" ->
                    tr(
                        "此条目关联监控文件夹，不能单独移除；否则重新扫描会恢复条目并丢失关联。源文件和笔记未删除。",
                        "This item is linked to a monitored folder and cannot be removed alone. Source files and notes remain intact.",
                    )
                "commit_outcome_unknown", "unavailable" ->
                    tr(
                        "未能确认提交结果。请刷新核对；不要将它视为未提交或重新累加。",
                        "Commit outcome could not be confirmed. Refresh to verify before retrying.",
                    )
                "annotation_saved_draft_pending" ->
                    tr(
                        "批注已保存，但旧草稿清理未确认；不要将它视为批注保存失败或重复提交。",
                        "Annotation saved, but old draft cleanup was not confirmed; do not resubmit.",
                    )
                "partial_restore" ->
                    tr(
                        "恢复未全部完成，部分记录可能已经提交；请保留备份并核对，不能假定已完全回滚或自动重放。",
                        "Restore ended partially; keep the backup and verify committed records before retrying.",
                    )
                "partial_import" ->
                    tr(
                        "部分文件已入库，另有输入未完成；请核对批次回执，不要假定全部失败。",
                        "Some files were imported while others remained unfinished; review batch receipts.",
                    )
                "native_settings_unsaved" -> {
                    recoveryNeeded = true
                    recoveryToolbarButton?.visibility = View.VISIBLE
                    tr(
                        "仍有未保存的本地设置或排版草稿；请保持应用开启并核对，不能自动丢弃。",
                        "Unsaved local settings or typography drafts remain; inspect recovery before leaving.",
                    )
                }
                "permission_denied", "permission-denied" ->
                    tr(
                        "没有文件访问权限，请在设置中重新授权。",
                        "File access permission denied; reauthorize the folder in Settings.",
                    )
                "ai_not_configured", "not_configured" ->
                    tr(
                        "请先在设置中配置自己的 AI 服务、API Key 和模型。",
                        "Configure your own AI provider, API Key and model in Settings first.",
                    )
                "share_unavailable" ->
                    tr(
                        "当前系统没有可用的分享目标，请改用保存文件或复制。",
                        "No share target app found on device; save to file or copy instead.",
                    )
                else ->
                    tr(
                        "操作未完成（$cleanCode）。已有数据不会被当成空数据替换。",
                        "Operation incomplete ($cleanCode). Existing data has not been discarded.",
                    )
            }
        // Do not dismiss an editor on a failed/unknown commit: its unsaved text must survive.
        val detailView =
            text(detail, 15f).apply {
                setLineSpacing(0f, 1.4f)
            }
        errorDialog?.dismiss()
        errorDialog =
            NativeEinkDialog(
                activity,
                label("操作未完成"),
                detailView,
                foreground,
                background,
                listOf(AlertDialog.BUTTON_POSITIVE to label("返回")),
                onDismissed = repaint,
            ).apply { show() }
    }

    fun invalidatePreferences() {
        preferencesStale = true
    }

    private fun applyPreferencesTheme() {
        NativeUi.isSpeechActive = { SystemTtsService.isActivelySpeaking() }
        NativeUi.onDialogDismissRepaint = {
            (activity as? MainActivity)?.onyxBridgeInstance()?.scheduleOverlayRepaint(
                (activity as? MainActivity)?.managementWebView(),
                "regal",
                60,
            )
        }
        val volumeKeysPaging =
            preferences
                .optJSONObject("readingMode")
                ?.optJSONObject("eink")
                ?.optBoolean("volumeKeysEnabled", true) ?: true
        activity.getSharedPreferences("pagewise_native_ui", Activity.MODE_PRIVATE)
            .edit()
            .putBoolean("volume_keys_paging", volumeKeysPaging)
            .apply()
        val eink = preferences.optJSONObject("readingMode")?.optJSONObject("eink")?.optBoolean("enabled") == true
        val appearance = preferences.optString("appearance")
        val dark =
            appearance == "dark" ||
                (appearance == "system" && activity.resources.configuration.uiMode and 0x30 == 0x20)
        foreground = if (dark) Color.WHITE else Color.BLACK
        background =
            when {
                dark && eink -> 0xFF111111.toInt()
                dark -> Color.BLACK
                else -> Color.WHITE
            }
    }

    fun show(
        page: String,
        params: JSONObject,
    ) {
        check(!disposed)
        require(page in pages || page == "book")
        closeEditorsAfterLeave()
        if (this.page != page || this.params.toString() != params.toString()) {
            val prevKey = routeStateKey(this.page, this.params)
            savedQueries[prevKey] = query
            savedNoteFilters[prevKey] = noteFilter
            savedOffsets[prevKey] = offset
            val nextKey = routeStateKey(page, params)
            query = savedQueries[nextKey] ?: ""
            noteFilter = savedNoteFilters[nextKey] ?: "all"
            offset = savedOffsets[nextKey] ?: 0
            draftPager.reset()
            if (page == "settings") settingsUiState.requested = params.optString("section").takeIf { it.isNotEmpty() }
            showTransitionCount += 1
            if (showTransitionCount >= 10) {
                showTransitionCount = 0
                (activity as? MainActivity)?.repaintManagementNow("gc")
            }
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
                @Suppress("DEPRECATION")
                val bottomInset = insets.systemWindowInsetBottom
                @Suppress("DEPRECATION")
                view.setPadding(
                    insets.systemWindowInsetLeft,
                    insets.systemWindowInsetTop,
                    insets.systemWindowInsetRight,
                    bottomInset,
                )
                bottomNavBar?.visibility = if (bottomInset > dp(120)) View.GONE else View.VISIBLE
                insets
            }
            activity.addContentView(
                overlay,
                ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
            )
            (activity as? MainActivity)?.onyxBridgeInstance()?.attachManagementOverlay(overlay)
            mounted = true
        }
        val wasVisible = overlay.visibility == View.VISIBLE
        if (!wasVisible) invalidatePreferences()
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
        if (page == "reading" && readingRecommendations) {
            readingRecommendations = false
            refresh()
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
            libraryPanel?.isEditing() == true
        ) {
            return false
        }
        val audioActive =
            SystemTtsService.isActivelySpeaking() ||
                ((activity.getSystemService(android.content.Context.AUDIO_SERVICE) as? android.media.AudioManager)?.isMusicActive == true)
        val volumeKeysPaging =
            !audioActive &&
                (
                    preferences
                        .optJSONObject("readingMode")
                        ?.optJSONObject("eink")
                        ?.optBoolean("volumeKeysEnabled", true) ?: true
                )
        val direction =
            when (event.keyCode) {
                KeyEvent.KEYCODE_PAGE_DOWN -> View.FOCUS_DOWN
                KeyEvent.KEYCODE_PAGE_UP -> View.FOCUS_UP
                KeyEvent.KEYCODE_VOLUME_DOWN -> if (volumeKeysPaging) View.FOCUS_DOWN else return false
                KeyEvent.KEYCODE_VOLUME_UP -> if (volumeKeysPaging) View.FOCUS_UP else return false
                else -> return false
            }
        if (activity.currentFocus is EditText) return false
        if (event.action == KeyEvent.ACTION_DOWN) {
            if (page == "settings") {
                settingsPanel?.pageScroll(direction)
            } else {
                val scrolled = NativeUi.stepScroll(scroll, direction)
                if (!scrolled && (page == "library" || page == "annotations")) {
                    if (direction == View.FOCUS_DOWN && offset + pageShown < pageTotal) {
                        offset += PAGE_SIZE
                        scroll.scrollTo(0, 0)
                        refresh()
                    } else if (direction == View.FOCUS_UP && offset > 0) {
                        offset = (offset - PAGE_SIZE).coerceAtLeast(0)
                        scroll.scrollTo(0, 0)
                        refresh()
                    }
                }
            }
            repaint()
        }
        return true
    }

    fun dispose() {
        if (disposed) return
        disposed = true
        exportExecutor.shutdownNow()
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
        pageTotal = 0
        pageShown = 0
        val renderContent = {
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
        if (preferences.length() > 0 && !preferencesStale) {
            applyPreferencesTheme()
            renderContent()
        } else {
            shell.removeAllViews()
            body.removeAllViews()
            overlay.setBackgroundColor(background)
            shell.addView(text(label("正在加载…")))
            call("state.settingsGet") { state ->
                preferences = JSONObject(state.getString("raw"))
                preferencesStale = false
                applyPreferencesTheme()
                renderContent()
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
                setTypeface(Typeface.SERIF, Typeface.BOLD)
                ellipsize = TextUtils.TruncateAt.END
                setPadding(if (rootPage) 0 else dp(12), 0, dp(8), 0)
            },
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f),
        )
        if (page !=
            "settings"
        ) {
            val recBtn = NativeUi.iconButton(activity, label("核对恢复"), "recovery", foreground, background, ::showSettingsRecovery)
            recBtn.visibility = if (recoveryNeeded) View.VISIBLE else View.GONE
            recoveryToolbarButton = recBtn
            toolbar.addView(recBtn)
        } else {
            recoveryToolbarButton = null
        }
        toolbar.addView(
            NativeUi.iconButton(activity, label("更多操作"), "more", foreground, background) {
                val owner = generation
                val actions =
                    (if (page in listOf("library", "reading")) libraryPanel?.menuActions().orEmpty() else emptyList()) +
                        listOf(label("刷新") to { refresh() }) +
                        (if (page != "settings") listOf(label("核对未保存设置 / 恢复") to ::showSettingsRecovery) else emptyList()) +
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
        shell.addView(
            View(activity).apply {
                setBackgroundColor(NativeUi.border(this@NativePagesController.background))
                layoutParams = LinearLayout.LayoutParams(-1, dp(2))
                importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
            },
        )
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
        shell.addView(
            View(activity).apply {
                setBackgroundColor(NativeUi.border(this@NativePagesController.background))
                layoutParams = LinearLayout.LayoutParams(-1, dp(2))
                importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
            },
        )
        val selected =
            when (page) {
                "book" -> "library"
                "manual" -> "settings"
                else -> page
            }
        val bottom = LinearLayout(activity).apply { setPadding(dp(8), dp(4), dp(8), dp(4)) }
        bottomNavBar = bottom
        for (key in nativeBottomPages) {
            bottom.addView(
                NativeUi.navigationItem(activity, label(pages.getValue(key)), key, key == selected, foreground, background) {
                    if (key != page) {
                        navigate(pathFor(key))
                    }
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
        val bar =
            LinearLayout(activity).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(0, dp(6), 0, dp(10))
            }
        val box =
            LinearLayout(activity).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                background =
                    NativeUi.shape(activity, this@NativePagesController.background).apply {
                        setColor(NativeUi.mutedSurface(this@NativePagesController.background))
                        setStroke(dp(1), NativeUi.border(this@NativePagesController.background))
                    }
                setPadding(dp(12), dp(2), dp(6), dp(2))
            }
        box.addView(
            ImageView(activity).apply {
                setImageDrawable(NativeUi.glyph(activity, "search-library", NativeUi.secondary(this@NativePagesController.background), 18))
            },
            LinearLayout.LayoutParams(dp(18), dp(18)).apply { marginEnd = dp(8) },
        )
        val edit =
            input(query, hint).apply {
                background = null
                setPadding(0, dp(8), 0, dp(8))
                imeOptions = android.view.inputmethod.EditorInfo.IME_ACTION_SEARCH
            }
        val commit = {
            query = edit.text.toString()
            offset = 0
            (
                activity.getSystemService(
                    Activity.INPUT_METHOD_SERVICE,
                ) as InputMethodManager
            ).hideSoftInputFromWindow(edit.windowToken, 0)
            refresh()
        }
        edit.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == android.view.inputmethod.EditorInfo.IME_ACTION_SEARCH) {
                commit()
                true
            } else {
                false
            }
        }
        box.addView(edit, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        if (query.isNotEmpty()) {
            box.addView(
                NativeUi.iconButton(activity, label("清除搜索"), "close", foreground, background) {
                    edit.setText("")
                    query = ""
                    offset = 0
                    refresh()
                },
            )
        }
        bar.addView(box, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { marginEnd = dp(8) })
        bar.addView(
            NativeUi.primaryButton(
                activity,
                label("搜索"),
                foreground,
                background,
            ) { commit() },
        )
        parent.addView(bar)
    }

    private fun pageControls(
        total: Int,
        shown: Int,
        target: LinearLayout = body,
    ) {
        pageTotal = total
        pageShown = shown
        val footer =
            LinearLayout(activity).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(0, dp(10), 0, dp(6))
            }
        footer.addView(
            text("${if (total == 0) 0 else offset + 1}–${offset + shown} / $total", 13f).apply {
                typeface = NativeUi.monoTypeface(false)
                fontFeatureSettings = "tnum"
                setTextColor(NativeUi.secondary(this@NativePagesController.background))
            },
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f),
        )
        val row = LinearLayout(activity)
        row.addView(
            button("上页") {
                offset = (offset - PAGE_SIZE).coerceAtLeast(0)
                refresh()
            }.apply {
                isEnabled = offset > 0
                layoutParams = LinearLayout.LayoutParams(-2, -2).apply { marginEnd = dp(8) }
            },
        )
        row.addView(
            button("下页") {
                offset += PAGE_SIZE
                refresh()
            }.apply { isEnabled = offset + shown < total },
        )
        footer.addView(row)
        target.addView(footer)
        target.addView(NativeUi.colophonTailpiece(activity, "END OF CATALOG · TOTAL $total", background))
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
                    val msgView =
                        text(
                            tr(
                                "已选择 ${result.optLong("size") / 1024} KiB。此预览仅核对选择信息，尚未校验内容。确认后调用既有恢复服务；失败可能有部分已提交记录，不能假定完全回滚。",
                                "Selected ${result.optLong("size") / 1024} KiB. Size preview only; archive contents have not been verified yet. If restore fails partially, full rollback cannot be assumed.",
                            ),
                            15f,
                        ).apply {
                            typeface = NativeUi.monoTypeface(false)
                            fontFeatureSettings = "tnum"
                            setLineSpacing(0f, 1.4f)
                        }
                    val preview =
                        NativeEinkDialog(
                            activity,
                            label("导入书库备份"),
                            msgView,
                            foreground,
                            background,
                            listOf(
                                AlertDialog.BUTTON_POSITIVE to label("校验并导入"),
                                AlertDialog.BUTTON_NEGATIVE to label("取消"),
                            ),
                            cancelableOutside = false,
                            onDismissed = repaint,
                        )
                    preview.setOnShowListener {
                        preview.getButton(AlertDialog.BUTTON_POSITIVE)?.setOnClickListener {
                            decided = true
                            preview.dismiss()
                            userAction("backupImport", JSONObject().put("mode", "commit").put("token", token).put("confirm", true))
                        }
                        preview.getButton(AlertDialog.BUTTON_NEGATIVE)?.setOnClickListener {
                            decided = true
                            preview.dismiss()
                            userAction("backupImport", JSONObject().put("mode", "discard").put("token", token))
                        }
                    }
                    preview.addOnDismiss {
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
                choose(tr("选择相同版本的原文件", "Choose matching source file"), (0 until files.length()).map { files.getJSONObject(it).getString("name") }) { index ->
                    val selected = files.getJSONObject(index)
                    confirm(
                        tr("重新关联", "Relink book"),
                        tr(
                            "只有确认属于相同版本才可继续；错误版本可能使原标注位置失效。保留原书籍 ID、笔记和进度。",
                            "Confirm the selected file is the exact same edition so annotations remain aligned. Book ID, notes and progress are kept.",
                        ),
                    ) {
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
                    val statusView =
                        text(
                            tr(
                                "状态：${status.optString("state")}\n${status.optString("message")}\n错误：${status.optString("error")}\n此为管理器当前快照，不是持久任务完成回执。",
                                "State: ${status.optString("state")}\n${status.optString("message")}\nError: ${status.optString("error")}\nCurrent manager snapshot only; not a durable job receipt.",
                            ),
                            15f,
                        ).apply { setLineSpacing(0f, 1.4f) }
                    NativeEinkDialog(
                        activity,
                        label("文件夹状态"),
                        statusView,
                        foreground,
                        background,
                        listOf(AlertDialog.BUTTON_POSITIVE to label("返回")),
                        onDismissed = repaint,
                    ).apply { show() }
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
        title.setTypeface(Typeface.SERIF, Typeface.NORMAL)
        title.fontFeatureSettings = "tnum"
        title.text = styled
    }

    private fun books() {
        val owner = generation
        if (page == "reading") {
            if (readingRecommendations) {
                val row = NativeActionFlow(activity)
                val statusTabs =
                    listOf(
                        "reading" to "在读",
                        "recent" to "最近阅读",
                        "wanted" to "想读",
                        "paused" to "暂缓",
                        "finished" to "已读",
                        "abandoned" to "弃读",
                    )
                statusTabs.forEach { (id, title) ->
                    row.addView(
                        button(label(title)) {
                            readingRecommendations = false
                            libraryState.tab = id
                            refresh()
                        }.apply {
                            NativeUi.styleTab(
                                this,
                                false,
                                this@NativePagesController.foreground,
                                this@NativePagesController.background,
                            )
                        },
                    )
                }
                row.addView(
                    button(label("推荐")) {}.apply {
                        NativeUi.styleTab(
                            this,
                            true,
                            this@NativePagesController.foreground,
                            this@NativePagesController.background,
                        )
                    },
                )
                body.addView(row)
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
                onRecommendations = {
                    readingRecommendations = true
                    refresh()
                },
                makeGridCard = { book, read, details -> bookGridCard(book, read, details) },
                resetScroll = { scroll.scrollTo(0, 0) },
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

    private fun bookGridCard(
        book: JSONObject,
        read: (() -> Unit)? = null,
        details: (() -> Unit)? = null,
    ): View {
        val card =
            column().apply {
                setPadding(dp(10), dp(10), dp(10), dp(10))
                background = NativeUi.bookRowBackground(activity, this@NativePagesController.background, true)
                isFocusable = true
                isSelected = book.optString("id") in libraryState.selected
                contentDescription = book.optString("title")
            }
        val coverBox =
            FrameLayout(activity).apply {
                background =
                    NativeUi.shape(activity, this@NativePagesController.background).apply {
                        setColor(NativeUi.mutedSurface(this@NativePagesController.background))
                        setStroke(dp(1), NativeUi.border(this@NativePagesController.background))
                    }
                clipToOutline = true
                setPadding(dp(3), dp(3), dp(3), dp(3))
            }
        coverBox.addView(
            text(book.optString("title"), 12f, true).apply {
                gravity = Gravity.CENTER
                setPadding(dp(6), dp(8), dp(6), dp(8))
                maxLines = 4
            },
            FrameLayout.LayoutParams(-1, -1),
        )
        val cover = ImageView(activity).apply { scaleType = ImageView.ScaleType.CENTER_CROP }
        coverBox.addView(cover, FrameLayout.LayoutParams(-1, -1))
        loadCover(cover, book.optString("coverPath"))
        coverBox.addView(
            text(book.optString("format").uppercase(), 12f, true).apply {
                setTextColor(Color.WHITE)
                setBackgroundColor(Color.BLACK)
                setPadding(dp(6), dp(2), dp(6), dp(2))
            },
            FrameLayout.LayoutParams(-2, -2, Gravity.TOP or Gravity.START).apply { setMargins(dp(4), dp(4), 0, 0) },
        )
        val selectionMark =
            if (libraryState.manage) {
                text(if (card.isSelected) "✓" else "□", 20f, true).apply {
                    gravity = Gravity.CENTER
                    setBackgroundColor(NativeUi.surface(this@NativePagesController.background))
                }
            } else {
                null
            }
        selectionMark?.let { coverBox.addView(it, FrameLayout.LayoutParams(dp(32), dp(32), Gravity.TOP or Gravity.END)) }
        var downX = 0f
        var downY = 0f
        var downTime = 0L
        val maxSlop = android.view.ViewConfiguration.get(activity).scaledTouchSlop.toFloat()
        val longPressTimeout = android.view.ViewConfiguration.getLongPressTimeout().toLong()
        coverBox.setOnTouchListener { _, ev ->
            when (ev.actionMasked) {
                android.view.MotionEvent.ACTION_DOWN -> {
                    downX = ev.x
                    downY = ev.y
                    downTime = ev.eventTime
                    card.isPressed = true
                }
                android.view.MotionEvent.ACTION_MOVE -> {
                    val dx = kotlin.math.abs(ev.x - downX)
                    val dy = kotlin.math.abs(ev.y - downY)
                    if (dx > maxSlop || dy > maxSlop) card.isPressed = false
                }
                android.view.MotionEvent.ACTION_CANCEL -> {
                    card.isPressed = false
                }
                android.view.MotionEvent.ACTION_UP -> {
                    val wasPressed = card.isPressed
                    card.isPressed = false
                    val dt = ev.eventTime - downTime
                    val dx = kotlin.math.abs(ev.x - downX)
                    val dy = kotlin.math.abs(ev.y - downY)
                    if (wasPressed && dx <= maxSlop && dy <= maxSlop) {
                        if (dt >= longPressTimeout) {
                            bookMenu(book, read, details)
                        } else if (libraryState.manage) {
                            card.performClick()
                        } else {
                            bookPrimary(book) { if (read != null) read() else openReader(book) }
                        }
                    }
                }
            }
            true
        }
        card.addView(coverBox, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(196)).apply { bottomMargin = dp(8) })
        val hasProgress = !book.isNull("progress") && book.optDouble("progress").isFinite()
        val percent = if (hasProgress) (book.optDouble("progress").coerceIn(0.0, 1.0) * 100).toInt() else 0
        if (hasProgress && percent > 0) {
            card.addView(
                NativeUi.foreEdgeProgressBar(activity, percent, foreground, background, 120).apply {
                    (layoutParams as LinearLayout.LayoutParams).apply {
                        width = ViewGroup.LayoutParams.MATCH_PARENT
                        bottomMargin = dp(6)
                    }
                },
            )
        }
        card.addView(
            text(book.optString("title"), 14f, true).apply {
                maxLines = 2
                ellipsize = TextUtils.TruncateAt.END
                setTypeface(Typeface.SERIF, Typeface.BOLD)
                setPadding(0, 0, 0, dp(2))
            },
        )
        val author = book.optString("author").takeUnless { it.isBlank() || it == "null" } ?: label("未知作者")
        card.addView(
            text(author, 12f).apply {
                maxLines = 1
                ellipsize = TextUtils.TruncateAt.END
                setTextColor(NativeUi.secondary(this@NativePagesController.background))
                setPadding(0, 0, 0, dp(2))
            },
        )
        card.setOnClickListener {
            if (details != null) details() else navigate("/book/${Uri.encode(book.getString("id"))}")
            if (libraryState.manage) {
                card.isSelected = book.optString("id") in libraryState.selected
                selectionMark?.text = if (card.isSelected) "✓" else "□"
            }
        }
        card.setOnLongClickListener {
            bookMenu(book, read, details)
            true
        }
        return card
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
                        setColor(NativeUi.mutedSurface(this@NativePagesController.background))
                        setStroke(dp(1), NativeUi.border(this@NativePagesController.background))
                    }
                clipToOutline = true
                setPadding(dp(3), dp(3), dp(3), dp(3))
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
                text(book.optString("format").uppercase(), 12f, true).apply {
                    setTextColor(Color.WHITE)
                    setBackgroundColor(Color.BLACK)
                    setPadding(dp(5), dp(1), dp(5), dp(1))
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
                setTypeface(Typeface.SERIF, Typeface.BOLD)
                ellipsize =
                    TextUtils.TruncateAt.END
            },
        )
        if (!reading || tagLabels.isNotEmpty()) {
            val effectiveCode = book.optString("effectiveReadingStatus")
            val shownStatus = if (effectiveCode.isEmpty() || effectiveCode == "unmarked") "" else statusName
            val secondaryHeading =
                if (reading) {
                    tagLabels.joinToString(" · ")
                } else {
                    listOf(problem, shownStatus, if (hasProgress && percent > 0) "$percent%" else "")
                        .filter { it.isNotEmpty() }
                        .joinToString(" · ")
                }
            if (secondaryHeading.isNotEmpty()) {
                heading.addView(
                    text(
                        secondaryHeading,
                        if (reading) 12f else 13f,
                    ).apply {
                        fontFeatureSettings = "tnum"
                        if (reading) maxEms = 14
                        setTextColor(NativeUi.secondary(this@NativePagesController.background))
                    },
                )
            }
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
            val progressLine =
                LinearLayout(activity).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                    setPadding(0, dp(2), 0, dp(2))
                }
            if (hasProgress) {
                progressLine.addView(
                    NativeUi.foreEdgeProgressBar(activity, percent, foreground, background, 84).apply {
                        (layoutParams as LinearLayout.LayoutParams).marginEnd = dp(8)
                    },
                )
            }
            progressLine.addView(
                text(metadata.joinToString(" · "), 12f).apply {
                    typeface = NativeUi.monoTypeface(false)
                    fontFeatureSettings = "tnum"
                    setTextColor(NativeUi.secondary(this@NativePagesController.background))
                },
            )
            info.addView(progressLine)
            if (problem.isNotEmpty()) {
                info.addView(
                    text("! $problem", 12f, true).apply {
                        background = NativeUi.hairlineShape(activity, this@NativePagesController.background, true)
                        setPadding(dp(8), dp(3), dp(8), dp(3))
                    },
                    LinearLayout.LayoutParams(-2, -2).apply { topMargin = dp(4) },
                )
            }
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
        row.setOnLongClickListener {
            bookMenu(book, read, details)
            true
        }
        row.setOnKeyListener { _, keyCode, event ->
            if (keyCode in listOf(KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_SPACE)) {
                if (event.action == KeyEvent.ACTION_UP) row.performClick()
                true
            } else {
                false
            }
        }
        return row
    }

    private fun loadCover(
        view: ImageView,
        path: String,
    ) {
        if (path.isEmpty()) return
        val cached = NativeUi.cachedCoverBitmap(path)
        if (cached != null) {
            view.setImageBitmap(cached)
            return
        }
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
                val bitmap = BitmapFactory.decodeFile(path, options) ?: return@execute
                NativeUi.putCachedCoverBitmap(path, bitmap)
                activity.runOnUiThread {
                    if (!disposed && epoch == generation &&
                        view.isAttachedToWindow
                    ) {
                        view.setImageBitmap(bitmap)
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

    @Suppress("UNUSED_PARAMETER", "unused")
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
        val list = column()
        lateinit var menuDialog: NativeEinkDialog
        entries.forEachIndexed { index, (caption, action) ->
            val itemBtn =
                NativeUi.iconTextButton(activity, caption, icons[index], foreground, background) {
                    menuDialog.dismiss()
                    if (ownerGeneration == generation && libraryPanel?.canOperate() != false) action()
                }.apply {
                    gravity = Gravity.START or Gravity.CENTER_VERTICAL
                }
            list.addView(
                itemBtn,
                LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                    if (index < entries.lastIndex) bottomMargin = dp(8)
                },
            )
        }
        replaceDialog {
            val titleText = book.optString("title") + if (linked) "\n" + label("源文件由监控文件夹管理") else ""
            menuDialog =
                NativeEinkDialog(
                    activity,
                    titleText,
                    list,
                    foreground,
                    background,
                    listOf(AlertDialog.BUTTON_NEGATIVE to label("取消")),
                    onDismissed = repaint,
                )
            menuDialog.show()
            menuDialog
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
        choose("阅读状态", statuses.values.map { label(it) }, statuses.keys.indexOf(book.optString("readingStatus"))) {
            patchBook(book, JSONObject().put("readingStatus", statuses.keys.toList()[it]))
        }

    private fun removeBook(book: JSONObject) {
        if (libraryPanel?.canMutate() == false) return
        val ownerGeneration = generation
        if (!book.isNull("sourceRef") && book.optString("sourceRef").isNotEmpty()) {
            showError("source_linked_book")
            return
        }
        confirm(
            "删除",
            tr(
                "移除《${book.optString("title")}》的书目及关联笔记；保留实际书籍文件和阅读统计。此操作不会删除监控文件夹源文件。",
                "Remove \"${book.optString("title")}\" and its notes from the library? Book files on disk and reading stats remain intact.",
            ),
        ) {
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
                val outer =
                    GradientDrawable().apply {
                        setColor(NativeUi.surface(this@NativePagesController.background))
                        setStroke(dp(2), NativeUi.border(this@NativePagesController.background))
                    }
                val inner =
                    GradientDrawable().apply {
                        setColor(NativeUi.surface(this@NativePagesController.background))
                        setStroke(dp(1), NativeUi.divider(this@NativePagesController.background))
                    }
                val inset = dp(3)
                background =
                    android.graphics.drawable.LayerDrawable(arrayOf(outer, inner)).apply {
                        setLayerInset(1, inset, inset, inset, inset)
                    }
                setPadding(dp(20), dp(20), dp(20), dp(20))
                layoutParams = LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(16) }
            }
        val coverBox =
            FrameLayout(activity).apply {
                background =
                    NativeUi.shape(activity, this@NativePagesController.background).apply {
                        setColor(NativeUi.mutedSurface(this@NativePagesController.background))
                    }
                setPadding(dp(3), dp(3), dp(3), dp(3))
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
            text(book.optString("format").uppercase(), 12f, true).apply {
                setTextColor(Color.WHITE)
                setBackgroundColor(Color.BLACK)
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
            TextView(activity).apply {
                text = tr("EX LIBRIS · 馆藏著录卡", "EX LIBRIS · CATALOG RECORD")
                textSize = 12f
                typeface = NativeUi.monoTypeface(true)
                fontFeatureSettings = "tnum"
                setTextColor(NativeUi.secondary(this@NativePagesController.background))
                setPadding(0, 0, 0, dp(4))
                importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
            },
        )
        identity.addView(
            text(book.optString("title"), 20f, true).apply {
                setTextIsSelectable(true)
                setTypeface(Typeface.SERIF, Typeface.BOLD)
                setPadding(0, 0, 0, dp(4))
            },
        )
        val authorAndDate =
            listOf(
                book.optString("author").takeUnless { it.isBlank() || it == "null" } ?: label("未知作者"),
                publicationDate(book.optString("publicationDate")).takeUnless { it.isBlank() || it == "null" },
            ).filterNotNull().filter { it.isNotEmpty() }.joinToString(" · ")
        if (authorAndDate.isNotEmpty()) {
            identity.addView(
                text(authorAndDate, 13f).apply {
                    setTextColor(NativeUi.secondary(this@NativePagesController.background))
                    setPadding(0, 0, 0, dp(4))
                },
            )
        }
        val statusActions = NativeActionFlow(activity)
        statusActions.addView(
            button(label("阅读状态") + ": " + label(statuses[book.optString("effectiveReadingStatus")] ?: "未标记")) { status(book) },
        )
        val primaryBookActionLabel =
            when {
                book.optString("fileAvailability") == "permission-denied" -> "重新授权"
                book.optString("fileAvailability") == "missing" -> "重新关联文件"
                book.optString("effectiveReadingStatus") == "finished" || book.optDouble("progress", 0.0) >= 0.99 -> "再次阅读"
                book.optDouble("progress", 0.0) > 0.0 -> "继续阅读"
                else -> "开始阅读"
            }
        statusActions.addView(
            NativeUi
                .primaryButton(
                    activity,
                    label(primaryBookActionLabel),
                    foreground,
                    background,
                ) { bookPrimary(book) }
                .apply {
                    isEnabled =
                        !book.has("supported") || book.optBoolean("supported")
                },
        )
        statusActions.addView(
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
            statusActions.addView(NativeUi.iconTextButton(activity, label("移除书目"), "delete", foreground, background) { removeBook(book) })
        }
        identity.addView(
            statusActions,
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                topMargin = dp(6)
                bottomMargin = dp(6)
            },
        )
        if (!book.isNull("progress") && book.optDouble("progress").isFinite()) {
            val p = (book.optDouble("progress").coerceIn(0.0, 1.0) * 100).toInt()
            val progressRow =
                LinearLayout(activity).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                    setPadding(0, dp(4), 0, dp(4))
                }
            progressRow.addView(
                NativeUi.foreEdgeProgressBar(activity, p, foreground, background, 132).apply {
                    (layoutParams as LinearLayout.LayoutParams).marginEnd = dp(10)
                },
            )
            progressRow.addView(
                text("$p%", 13f, true).apply {
                    setPadding(0, 0, dp(12), 0)
                    setTypeface(Typeface.MONOSPACE, Typeface.BOLD)
                    fontFeatureSettings = "tnum"
                },
            )
            progressRow.addView(
                android.widget.ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal).apply {
                    max = 100
                    progress = p
                    visibility = View.GONE
                    contentDescription =
                        label("阅读进度") + " $p%"
                },
                LinearLayout.LayoutParams(0, dp(1), 0f),
            )
            identity.addView(progressRow, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { bottomMargin = dp(10) })
        }
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
        val tabs = NativeActionFlow(activity)
        val tabButtons = mutableListOf<Button>()
        val panels =
            listOf(
                NativeUi.exLibrisCard(
                    activity,
                    background,
                    headerLabel = tr("ARCHIVAL RECORD · 馆藏档案", "ARCHIVAL RECORD"),
                    badgeLabel = book.optString("format").uppercase(),
                ),
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
            records.addView(NativeUi.wireframeSkeleton(activity, background, foreground, label("正在加载…"), rows = 2))
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
                        ).apply {
                            typeface = NativeUi.monoTypeface(false)
                            fontFeatureSettings = "tnum"
                            setTextColor(NativeUi.secondary(this@NativePagesController.background))
                        },
                    )
                    if (note
                            .optString(
                                "text",
                            ).isNotEmpty()
                    ) {
                        val quoteBox =
                            LinearLayout(activity).apply {
                                orientation = LinearLayout.HORIZONTAL
                                setBackgroundColor(NativeUi.mutedSurface(this@NativePagesController.background))
                                layoutParams = LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(4); bottomMargin = dp(4) }
                            }
                        quoteBox.addView(
                            View(activity).apply { setBackgroundColor(this@NativePagesController.foreground) },
                            LinearLayout.LayoutParams(dp(3), -1),
                        )
                        quoteBox.addView(
                            text("“${note.optString("text")}”", 14f).apply {
                                setTypeface(Typeface.SERIF, Typeface.NORMAL)
                                setPadding(dp(10), dp(6), dp(8), dp(6))
                                setTextIsSelectable(true)
                            },
                            LinearLayout.LayoutParams(0, -2, 1f),
                        )
                        row.addView(quoteBox)
                    }
                    if (!note.isNull("note") &&
                        note.optString("note").isNotEmpty()
                    ) {
                        row.addView(
                            text(label("想法") + ": " + note.optString("note"), 13f).apply {
                                setTextIsSelectable(true)
                                setPadding(dp(4), dp(2), dp(4), dp(2))
                            },
                        )
                    }
                    val noteCfi = note.optString("cfi")
                    if (noteCfi.isNotBlank()) {
                        val rowActions = NativeActionFlow(activity)
                        rowActions.addView(
                            NativeUi.subtleButton(activity, label("回到原文"), foreground, background) {
                                openReader(book, noteCfi)
                            },
                        )
                        row.addView(rowActions)
                    }
                    records.addView(row)
                    records.addView(line())
                }
                if (total > 20) {
                    val pager = LinearLayout(activity).apply { setPadding(0, dp(8), 0, dp(4)) }
                    pager.addView(
                        button("上页") { recordPage((offset - 20).coerceAtLeast(0)) }.apply {
                            isEnabled = offset > 0
                            layoutParams = LinearLayout.LayoutParams(-2, -2).apply { marginEnd = dp(8) }
                        },
                    )
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
        body.addView(tabs)
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
        val description = book.optString("description")
        val introHeader =
            LinearLayout(activity).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(0, dp(4), 0, dp(4))
            }
        introHeader.addView(
            text(label("简介"), 16f, true).apply {
                setTypeface(Typeface.SERIF, Typeface.BOLD)
            },
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f),
        )
        introHeader.addView(
            NativeUi.subtleButton(activity, label("生成简介"), foreground, background) { openBookIntroduction(book) },
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT),
        )
        overview.addView(introHeader)
        if (description.isNotEmpty() && description != "null") {
            overview.addView(
                NativeManualRenderer(activity, foreground, background, compact = true) { href ->
                    if (href.startsWith("https://")) manualLink(href)
                }.render(description),
            )
        } else {
            overview.addView(
                text(label("暂无简介，可按书目信息生成。"), 14f).apply {
                    setTextColor(NativeUi.secondary(this@NativePagesController.background))
                    setTypeface(Typeface.SERIF, Typeface.NORMAL)
                    setLineSpacing(0f, 1.45f)
                },
            )
        }
        val classification = book.optJSONObject("classification")
        overview.addView(
            text(label("分类与标签"), 16f, true).apply {
                setTypeface(Typeface.SERIF, Typeface.BOLD)
                setPadding(0, dp(12), 0, dp(4))
            },
        )
        val rawCat = classification?.optJSONObject("category")?.optString("value").orEmpty()
        overview.addView(
            NativeUi.pillBadge(
                activity,
                if (rawCat.isEmpty()) {
                    label("未分类")
                } else {
                    nativeCategoryCallNumber(rawCat, preferences.optString("language") == "en")
                },
                foreground,
                background,
                emphasized = rawCat.isNotEmpty(),
            ).apply {
                layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                    bottomMargin = dp(6)
                }
            },
        )
        if (classification != null) {
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
                val facetKeyLabels =
                    mapOf(
                        "audience" to "读者对象",
                        "period" to "年代",
                        "region" to "地域",
                        "difficulty" to "难度",
                        "readingDifficulty" to "阅读难度",
                        "genre" to "体裁",
                        "form" to "形式",
                        "style" to "体裁",
                        "language" to "语种",
                    )
                overview.addView(
                    text(
                        facets
                            .keys()
                            .asSequence()
                            .filter { !facets.isNull(it) }
                            .joinToString(" · ") { k ->
                                val v = facets.get(k)
                                val localizedKey = if (preferences.optString("language") == "en") k else facetKeyLabels[k] ?: k
                                val localizedVal =
                                    when (v) {
                                        true -> if (preferences.optString("language") == "en") "Yes" else "是"
                                        false -> if (preferences.optString("language") == "en") "No" else "否"
                                        else -> v.toString()
                                    }
                                "$localizedKey: $localizedVal"
                            },
                        14f,
                    ),
                )
            }
        }
        actions(
            overview,
            listOf("标签" to { editTags(book) }, "AI 分类" to { openClassification(bookId, true) }),
        )
        overview.addView(
            line().apply {
                layoutParams = LinearLayout.LayoutParams(-1, dp(1)).apply { topMargin = dp(12); bottomMargin = dp(10) }
            },
        )
        overview.addView(metadata)
        val fileActions = NativeActionFlow(activity)
        if (fileMetadata.childCount > 0) {
            lateinit var toggle: Button
            toggle =
                NativeUi.subtleButton(activity, label("文件信息"), foreground, background) {
                    fileMetadata.visibility = if (fileMetadata.visibility == View.VISIBLE) View.GONE else View.VISIBLE
                    toggle.text = label(if (fileMetadata.visibility == View.VISIBLE) "收起文件信息" else "文件信息")
                    toggle.contentDescription = toggle.text
                }
            fileActions.addView(toggle)
        }
        val editBookBtn = NativeUi.subtleButton(activity, label("编辑书目信息"), foreground, background) { editBook(book) }
        fileActions.addView(editBookBtn)
        val metadataBtn = NativeUi.subtleButton(activity, label("补全元数据"), foreground, background) { completeBookMetadata(book) }
        fileActions.addView(metadataBtn)
        val catchupBtn = NativeUi.subtleButton(activity, label("前情提要"), foreground, background) { showBookCatchup(book) }
        fileActions.addView(catchupBtn)
        overview.addView(
            fileActions,
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                topMargin = dp(8)
                bottomMargin = dp(4)
            },
        )
        if (fileMetadata.childCount > 0) {
            overview.addView(fileMetadata)
        }
        select(0)
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
            form.addView(NativeUi.wireframeSkeleton(activity, background, foreground, label("正在加载…"), rows = 3))
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
                        form.addView(
                            text(
                                tr(
                                    "此格式不支持提取目录；不是读取失败或空书库。",
                                    "Table of contents extraction is unsupported for this format.",
                                ),
                            ),
                        )
                    } else {
                        context = result.getString("token")
                        val entries = result.getJSONArray("items")
                        val total = result.getInt("total")
                        form.addView(
                            NativeUi.primaryButton(activity, label("开始阅读") + " · " + label("在阅读器内跳转章节"), foreground, background) {
                                call("library.book", JSONObject().put("id", bookId)) { openReader(it.getJSONObject("book")) }
                            }.apply {
                                layoutParams = LinearLayout.LayoutParams(-2, -2).apply { bottomMargin = dp(8) }
                            },
                        )
                        form.addView(
                            text(
                                tr("目录快照", "TOC snapshot") +
                                    " · ${if (total == 0) 0 else offset + 1}–${(offset + entries.length()).coerceAtMost(total)} / $total",
                                13f,
                            ).apply {
                                typeface = NativeUi.monoTypeface(false)
                                fontFeatureSettings = "tnum"
                                setTextColor(NativeUi.secondary(this@NativePagesController.background))
                            },
                        )
                        if (total == 0) {
                            form.addView(
                                text(
                                    tr(
                                        "原文件没有可提取的目录。",
                                        "No extractable table of contents found in source file.",
                                    ),
                                ),
                            )
                        }
                        for (i in 0 until entries.length()) {
                            val entry = entries.getJSONObject(i)
                            val entryLoc = entry.optString("href").ifBlank { entry.optString("cfi") }
                            form.addView(
                                text(entry.getString("title")).apply {
                                    minimumHeight = dp(48)
                                    gravity = Gravity.CENTER_VERTICAL
                                    setPadding(dp(minOf(entry.getInt("depth"), 8) * 14 + 4), dp(8), dp(4), dp(8))
                                    isClickable = true
                                    isFocusable = true
                                    setOnClickListener {
                                        call("library.book", JSONObject().put("id", bookId)) {
                                            openReader(it.getJSONObject("book"), entryLoc)
                                        }
                                    }
                                },
                            )
                            form.addView(line())
                        }
                        val pager = LinearLayout(activity).apply { setPadding(0, dp(8), 0, 0) }
                        pager.addView(
                            button("上页") { fetch((offset - 50).coerceAtLeast(0)) }.apply {
                                isEnabled = offset > 0
                                layoutParams = LinearLayout.LayoutParams(-2, -2).apply { marginEnd = dp(8) }
                            },
                        )
                        pager.addView(button("下页") { fetch(offset + 50) }.apply { isEnabled = offset + entries.length() < total })
                        form.addView(pager)
                    }
                    if (window == null && target == null) {
                        replaceDialog {
                            intent = dialogIntent
                            NativeEinkDialog(
                                activity,
                                label("目录"),
                                form,
                                foreground,
                                background,
                                listOf(AlertDialog.BUTTON_POSITIVE to label("返回")),
                                onDismissed = repaint,
                            ).also {
                                window = it
                                it.show()
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

    private fun showBookCatchup(book: JSONObject) {
        val bookId = book.getString("id")
        val payload =
            JSONObject()
                .put("bookId", bookId)
                .put("query", "")
                .put("filter", "all")
                .put("offset", 0)
                .put("limit", 5)
        call("library.annotations", payload) { response ->
            val items = response.optJSONArray("items") ?: JSONArray()
            val box = column().apply { setPadding(dp(4), dp(4), dp(4), dp(4)) }
            val prog = if (book.isNull("progress")) 0 else kotlin.math.round(book.optDouble("progress", 0.0) * 100).toInt().coerceIn(0, 100)
            val lastRead = book.optLong("lastReadAt", 0L)
            val idleDays = if (lastRead > 0L && System.currentTimeMillis() >= lastRead) ((System.currentTimeMillis() - lastRead) / 86_400_000L).toInt() else -1
            box.addView(text("《${book.optString("title")}》", 16f, true))
            val summaryLine =
                buildString {
                    append("${label("阅读进度")}: $prog%")
                    if (idleDays >= 0) append(tr(" · 距上次阅读 $idleDays 天", " · $idleDays d since last read"))
                }
            box.addView(
                text(summaryLine, 14f).apply {
                    fontFeatureSettings = "tnum"
                },
            )
            if (!book.isNull("description") && book.optString("description").isNotBlank()) {
                box.addView(text(book.optString("description").take(220), 13f))
            }
            box.addView(line())
            if (items.length() == 0) {
                box.addView(text(label("本书还没有笔记"), 14f))
            } else {
                box.addView(
                    text(tr("最近留下的标注 (${items.length()})：", "Recent annotations (${items.length()}):"), 14f, true).apply {
                        fontFeatureSettings = "tnum"
                    },
                )
                for (i in 0 until items.length()) {
                    val ann = items.getJSONObject(i)
                    val quoteText = ann.optString("text").ifBlank { ann.optString("note") }.take(120)
                    box.addView(text("• “$quoteText”", 13f))
                    val cfi = ann.optString("cfi")
                    if (cfi.isNotBlank()) {
                        box.addView(
                            NativeUi.subtleButton(activity, label("回到原文"), foreground, background) {
                                currentDialog?.dismiss()
                                openReader(book, cfi)
                            },
                        )
                    }
                }
            }
            dialog("前情提要", box, positiveLabel = "继续阅读", negativeLabel = "关闭") {
                currentDialog?.dismiss()
                openReader(book)
            }
        }
    }

    private fun collectAnnotationsForExport(
        bookId: String,
        progressView: TextView? = null,
        done: (JSONArray) -> Unit,
    ) {
        if (exportBusy) return
        exportBusy = true
        val collected = JSONArray()
        val epoch = generation

        fun nextPage(pageOffset: Int) {
            val payload =
                JSONObject()
                    .put("query", query)
                    .put("filter", noteFilter)
                    .put("offset", pageOffset)
                    .put("limit", 100)
            if (bookId.isNotEmpty()) payload.put("bookId", bookId)
            call("library.annotations", payload) { response ->
                if (generation != epoch) {
                    exportBusy = false
                    return@call
                }
                val batch = response.optJSONArray("items") ?: JSONArray()
                val total = response.optInt("total", collected.length() + batch.length())
                for (i in 0 until batch.length()) {
                    collected.put(batch.getJSONObject(i))
                }
                progressView?.text = "${label("正在导出…")} ${collected.length()} / $total"
                if (batch.length() > 0 && collected.length() < total) {
                    nextPage(pageOffset + batch.length())
                } else {
                    exportBusy = false
                    progressView?.text = ""
                    done(collected)
                }
            }
        }
        nextPage(0)
    }

    private fun writeNotesMarkdown(
        bookId: String,
        items: JSONArray,
        writer: Appendable,
    ) {
        writer.append(tr("# 读书笔记与标注导出\n\n", "# Reading Notes & Highlights Export\n\n"))
        if (bookId.isNotEmpty()) writer.append(tr("- 书籍 ID: `$bookId`\n", "- Book ID: `$bookId`\n"))
        writer.append(tr("- 导出条数: ${items.length()}\n\n", "- Exported items: ${items.length()}\n\n"))
        for (i in 0 until items.length()) {
            val item = items.getJSONObject(i)
            val bTitle = item.optString("bookTitle", tr("书籍", "Book"))
            val kind = label(if (item.optString("kind") == "bookmark") "书签" else "标注")
            val cfi = item.optString("cfi")
            writer.append("## ${i + 1}. $bTitle [$kind]\n")
            if (item.optString("text").isNotBlank()) {
                writer.append("> ${item.optString("text").trim()}\n\n")
            }
            if (!item.isNull("note") && item.optString("note").isNotBlank()) {
                writer.append("**${label("想法")}**: ${item.optString("note").trim()}\n\n")
            }
            if (cfi.isNotBlank()) {
                writer.append("- ${tr("锚点", "Anchor")}: `$cfi`\n\n")
            }
        }
    }

    private fun exportNotesMarkdownDialog(
        bookId: String,
        items: JSONArray,
    ) {
        val largeExport = items.length() > 500
        val previewLimit = if (largeExport) 50 else items.length()
        val copyNotice =
            text("", 13f).apply {
                visibility = View.GONE
                setTextColor(NativeUi.secondary(this@NativePagesController.background))
            }
        val mdBox = column().apply { addView(copyNotice) }
        val markdown =
            if (largeExport) {
                val preview = JSONArray()
                for (i in 0 until previewLimit) preview.put(items.getJSONObject(i))
                val noticeHeader =
                    tr(
                        "<!-- 以下仅预览前 50 / ${items.length()} 条，请点击上方「保存为 Markdown 文件」导出全部记录 -->\n\n",
                        "<!-- Previewing first 50 / ${items.length()} items only. Use \"Save as Markdown file\" above for full export. -->\n\n",
                    )
                noticeHeader + StringBuilder().also { writeNotesMarkdown(bookId, preview, it) }.toString()
            } else {
                StringBuilder().also { writeNotesMarkdown(bookId, items, it) }.toString()
            }
        lateinit var saveBtn: Button
        val triggerSafSave = {
            (activity as? MainActivity)?.launchCreateMarkdownDocument("pagewise-notes.md") { uri ->
                if (uri == null || disposed) return@launchCreateMarkdownDocument
                saveBtn.isEnabled = false
                copyNotice.text = "${label("正在导出…")} 0 / ${items.length()}"
                copyNotice.visibility = View.VISIBLE
                runCatching {
                    exportExecutor.execute {
                        val ok =
                            runCatching {
                                activity.contentResolver.openOutputStream(uri)?.bufferedWriter(Charsets.UTF_8)?.use { out ->
                                    writeNotesMarkdown(bookId, items, out)
                                } != null
                            }.getOrDefault(false)
                        activity.runOnUiThread {
                            if (!disposed) {
                                saveBtn.isEnabled = true
                                copyNotice.text = if (ok) label("已保存到所选文件") + " (${items.length()})" else tr("保存失败，请重试", "Save failed; please retry")
                                copyNotice.visibility = View.VISIBLE
                            }
                        }
                    }
                }.onFailure {
                    activity.runOnUiThread {
                        if (!disposed) {
                            saveBtn.isEnabled = true
                            copyNotice.text = tr("导出队列不可用，请重试", "Export worker unavailable; please retry")
                            copyNotice.visibility = View.VISIBLE
                        }
                    }
                }
            }
        }
        if (largeExport) {
            mdBox.addView(
                text(
                    tr(
                        "共 ${items.length()} 条记录（超出 500 条），请点击下方「保存为 Markdown 文件」完整流式写入磁盘。",
                        "${items.length()} records (> 500). Use \"Save as Markdown file\" below to stream the full export directly to disk.",
                    ),
                    14f,
                    true,
                ).apply {
                    fontFeatureSettings = "tnum"
                    setPadding(dp(4), dp(4), dp(4), dp(8))
                },
            )
            saveBtn =
                NativeUi.primaryButton(activity, label("保存为 Markdown 文件"), foreground, background) {
                    triggerSafSave()
                }.apply { layoutParams = LinearLayout.LayoutParams(-2, -2).apply { bottomMargin = dp(8) } }
            mdBox.addView(saveBtn)
        } else {
            saveBtn =
                NativeUi.subtleButton(activity, label("保存为 Markdown 文件"), foreground, background) {
                    triggerSafSave()
                }.apply { layoutParams = LinearLayout.LayoutParams(-2, -2).apply { bottomMargin = dp(8) } }
            mdBox.addView(saveBtn)
        }
        mdBox.addView(
            text(markdown, 13f).apply {
                setTextIsSelectable(true)
                typeface = NativeUi.monoTypeface(false)
                fontFeatureSettings = "tnum"
                setLineSpacing(0f, 1.35f)
                setPadding(dp(4), dp(4), dp(4), dp(4))
            },
        )
        replaceDialog {
            val exportButtons =
                if (largeExport) {
                    listOf(AlertDialog.BUTTON_NEGATIVE to label("关闭"))
                } else {
                    listOf(
                        AlertDialog.BUTTON_POSITIVE to label("系统分享"),
                        AlertDialog.BUTTON_NEUTRAL to label("复制 Markdown"),
                        AlertDialog.BUTTON_NEGATIVE to label("关闭"),
                    )
                }
            val exportDialog =
                NativeEinkDialog(
                    activity,
                    label("导出读书笔记"),
                    mdBox,
                    foreground,
                    background,
                    exportButtons,
                    onDismissed = repaint,
                )
            if (!largeExport) {
                exportDialog.setOnShowListener {
                    exportDialog.getButton(AlertDialog.BUTTON_POSITIVE)?.setOnClickListener {
                        exportDialog.dismiss()
                        val share =
                            Intent(Intent.ACTION_SEND).apply {
                                type = "text/plain"
                                putExtra(Intent.EXTRA_SUBJECT, tr("Pagewise 读书笔记", "Pagewise Reading Notes"))
                                putExtra(Intent.EXTRA_TEXT, markdown)
                            }
                        runCatching {
                            activity.startActivity(Intent.createChooser(share, label("导出读书笔记")))
                        }.onFailure {
                            showError("share_unavailable")
                        }
                    }
                    exportDialog.getButton(AlertDialog.BUTTON_NEUTRAL)?.setOnClickListener {
                        val cm = activity.getSystemService(android.content.Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
                        cm.setPrimaryClip(android.content.ClipData.newPlainText("Pagewise Notes", markdown))
                        copyNotice.text = label("已复制到剪贴板")
                        copyNotice.visibility = View.VISIBLE
                    }
                }
            }
            exportDialog.show()
            exportDialog
        }
    }

    private fun showCrossBookMatrixDialog(items: JSONArray) {
        val grouped = linkedMapOf<String, MutableList<JSONObject>>()
        for (i in 0 until items.length()) {
            val item = items.getJSONObject(i)
            val title = item.optString("bookTitle", label("已移除的书籍"))
            grouped.getOrPut(title) { mutableListOf() }.add(item)
        }
        val box = column().apply { setPadding(dp(4), dp(4), dp(4), dp(4)) }
        box.addView(
            text(
                tr("跨书观点与批注对照 (${grouped.size} 本书)", "Cross-book annotations (${grouped.size} books)"),
                16f,
                true,
            ).apply {
                fontFeatureSettings = "tnum"
            },
        )
        grouped.forEach { (title, list) ->
            val card =
                column().apply {
                    setPadding(dp(12), dp(8), dp(12), dp(8))
                    background = NativeUi.shape(activity, this@NativePagesController.background)
                    layoutParams = LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(8) }
                }
            card.addView(
                text(tr("《$title》 (${list.size} 条标注)", "$title (${list.size} items)"), 14f, true).apply {
                    fontFeatureSettings = "tnum"
                },
            )
            list.take(3).forEach { note ->
                val snippet = note.optString("note").ifBlank { note.optString("text") }.take(100)
                if (snippet.isNotBlank()) card.addView(text("• $snippet", 13f))
            }
            box.addView(card)
        }
        dialog("跨书对比预览", box, negativeLabel = "关闭")
    }

    private fun editBook(book: JSONObject) {
        val limits =
            mapOf(
                "title" to 512,
                "author" to 256,
                "publisher" to 256,
                "publicationDate" to 64,
                "language" to 32,
                "description" to 16000,
            )
        var fillEmptyOnly = false
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
        lateinit var modeBtn: Button
        modeBtn =
            NativeUi.subtleButton(activity, label("覆盖已有字段"), foreground, background) {
                fillEmptyOnly = !fillEmptyOnly
                modeBtn.text = label(if (fillEmptyOnly) "仅补全空白字段" else "覆盖已有字段")
            }
        form.addView(modeBtn)
        val editors = linkedMapOf<String, EditText>()
        fields.forEach { (key, title) ->
            val origVal = if (book.isNull(key)) "" else book.optString(key)
            form.addView(text("${label(title)} (${if (origVal.isEmpty()) tr("空白", "Empty") else tr("已有", "Set")})", 14f))
            val editor =
                input(
                    origVal,
                    title,
                    key == "description",
                )
            editors[key] = editor
            form.addView(editor)
        }
        dialog("编辑书目信息", form, cancelableOutside = false) {
            val patch = JSONObject()
            for ((key, editor) in editors) {
                val value = editor.text.toString().replace("\u0000", "").trim()
                val orig = if (book.isNull(key)) "" else book.optString(key)
                val maxLen = limits[key] ?: 512
                if (value.length > maxLen) {
                    editor.error = tr("超出长度上限 ($maxLen)", "Exceeds max length ($maxLen)")
                    return@dialog
                }
                if (fillEmptyOnly && orig.isNotBlank()) continue
                if (value != orig) {
                    patch.put(key, value)
                }
            }
            if (patch.has("title") && patch.getString("title").isBlank()) {
                editors["title"]?.error = tr("书名不能为空", "Title is required")
                return@dialog
            }
            if (patch.length() == 0) currentDialog?.dismiss() else patchBook(book, patch)
        }
    }

    private fun completeBookMetadata(book: JSONObject) {
        val limits =
            mapOf(
                "title" to 512,
                "author" to 256,
                "publisher" to 256,
                "publicationDate" to 64,
                "language" to 32,
            )
        var fillEmptyOnly = true
        val fields =
            linkedMapOf(
                "title" to "书名",
                "author" to "作者",
                "publisher" to "出版社",
                "publicationDate" to "出版日期",
                "language" to "语言",
            )
        val form = column()
        val statusText =
            TextView(activity).apply {
                text = label("点击下方按钮发起公开书目并发检索或 AI 推理补全。")
                textSize = 13f
                setTextColor(this@NativePagesController.foreground)
                setPadding(dp(4), dp(4), dp(4), dp(6))
            }
        form.addView(statusText)

        val editors = linkedMapOf<String, EditText>()
        val actionRow = NativeActionFlow(activity)

        lateinit var modeBtn: Button
        modeBtn =
            NativeUi.subtleButton(activity, label("仅补全空白字段"), foreground, background) {
                fillEmptyOnly = !fillEmptyOnly
                modeBtn.text = label(if (fillEmptyOnly) "仅补全空白字段" else "覆盖已有字段")
            }
        actionRow.addView(modeBtn)

        val candidateContainer = column()

        fun applyFields(patch: JSONObject) {
            var appliedCount = 0
            for ((key, editor) in editors) {
                if (patch.has(key) && !patch.isNull(key)) {
                    val newVal = patch.optString(key).trim()
                    if (newVal.isNotEmpty()) {
                        val currVal = editor.text.toString().trim()
                        if (!fillEmptyOnly || currVal.isEmpty()) {
                            editor.setText(newVal)
                            appliedCount++
                        }
                    }
                }
            }
            statusText.text =
                tr(
                    "已采纳补全项 ($appliedCount 处更新)，保存后生效。",
                    "Applied $appliedCount updated field(s); click Save to persist.",
                )
        }

        val searchBtn =
            NativeUi.subtleButton(activity, label("检索公开书目 (第一级)"), foreground, background) {
                statusText.text = label("正在检索 OpenLibrary / Google Books / 豆瓣…")
                val p =
                    JSONObject()
                        .put("title", editors["title"]?.text?.toString()?.trim() ?: book.optString("title"))
                        .put("author", editors["author"]?.text?.toString()?.trim() ?: book.optString("author"))
                request("action.metadataSearchOpen", p) { result, error ->
                    activity.runOnUiThread {
                        if (error != null || result?.optBoolean("ok") != true) {
                            statusText.text = label("公开书目库未检索到匹配项，可尝试第二级 AI 推理。")
                            return@runOnUiThread
                        }
                        val candidates = result.optJSONArray("candidates") ?: JSONArray()
                        val best = result.optJSONObject("bestMatch")
                        val bestKey = best?.let { "${it.optString("source")}|${it.optString("title")}|${it.optString("author")}" }
                        candidateContainer.removeAllViews()
                        if (candidates.length() == 0) {
                            statusText.text = label("公开书目库未检索到匹配项，可尝试第二级 AI 推理。")
                        } else {
                            statusText.text =
                                tr(
                                    "检索到 ${candidates.length()} 个候选，点击即可采纳：",
                                    "Found ${candidates.length()} candidate(s); tap to apply:",
                                )
                            for (i in 0 until candidates.length()) {
                                val c = candidates.getJSONObject(i)
                                val cTitle = c.optString("title")
                                val cAuthor = c.optString("author")
                                val cPub = c.optString("publisher")
                                val cDate = c.optString("publicationDate")
                                val cSource = c.optString("source")
                                val isBest = bestKey != null && "$cSource|$cTitle|$cAuthor" == bestKey
                                val info = listOf(cAuthor, cPub, cDate).filter { it.isNotBlank() }.joinToString(" · ")
                                val prefix = if (isBest) "[${label("推荐匹配")}] [$cSource] " else "[$cSource] "
                                val candBtn =
                                    button("$prefix$cTitle ${if (info.isNotBlank()) "— $info" else ""}") {
                                        applyFields(c)
                                    }.apply {
                                        textSize = 13f
                                        gravity = Gravity.START or Gravity.CENTER_VERTICAL
                                        layoutParams =
                                            LinearLayout.LayoutParams(-1, -2).apply {
                                                topMargin = dp(4)
                                                bottomMargin = dp(4)
                                            }
                                    }
                                candidateContainer.addView(candBtn)
                            }
                        }
                    }
                }
            }
        actionRow.addView(searchBtn)

        val aiBtn =
            NativeUi.subtleButton(activity, label("AI 智能推理 (第二级)"), foreground, background) {
                statusText.text = label("AI 正在推理著录信息…请稍候。")
                val curFields = JSONObject()
                editors.forEach { (k, ed) -> curFields.put(k, ed.text.toString().trim()) }
                val p =
                    JSONObject()
                        .put("title", editors["title"]?.text?.toString()?.trim() ?: book.optString("title"))
                        .put("fileName", book.optString("fileName"))
                        .put("current", curFields)
                request("action.metadataInferAi", p) { result, error ->
                    activity.runOnUiThread {
                        if (error != null || result?.optBoolean("ok") != true) {
                            statusText.text = label("AI 推理未成功，请检查 AI 配置后重试。")
                            return@runOnUiThread
                        }
                        val metadata = result.optJSONObject("metadata")
                        if (metadata != null && metadata.length() > 0) {
                            applyFields(metadata)
                            statusText.text = label("AI 著录推理完成，已填入表单，核对后点击保存。")
                        } else {
                            statusText.text = label("AI 未能推断出更多有效著录字段。")
                        }
                    }
                }
            }
        actionRow.addView(aiBtn)

        form.addView(actionRow)
        form.addView(candidateContainer)

        fields.forEach { (key, title) ->
            val origVal = if (book.isNull(key)) "" else book.optString(key)
            form.addView(text("${label(title)} (${if (origVal.isEmpty()) label("空白") else label("已有")})", 14f))
            val editor = input(origVal, title, false)
            editors[key] = editor
            form.addView(editor)
        }
        dialog("著录元数据补全与精修", form, cancelableOutside = false) {
            val patch = JSONObject()
            for ((key, editor) in editors) {
                val value = editor.text.toString().replace("\u0000", "").trim()
                val orig = if (book.isNull(key)) "" else book.optString(key)
                val maxLen = limits[key] ?: 512
                if (value.length > maxLen) {
                    editor.error = tr("超出长度上限 ($maxLen)", "Exceeds max length ($maxLen)")
                    return@dialog
                }
                if (fillEmptyOnly && orig.isNotBlank()) continue
                if (value != orig) {
                    patch.put(key, value)
                }
            }
            if (patch.has("title") && patch.getString("title").isBlank()) {
                editors["title"]?.error = tr("书名不能为空", "Title is required")
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
            replaceDialog {
                NativeClassificationEditor(
                    activity,
                    result,
                    request,
                    { refresh() },
                    ::showError,
                    foreground,
                    background,
                    isEnglish(),
                ).show(autoGenerate)
            }
        }
    }

    private fun highlightRoleLabel(color: String): String =
        when (color.lowercase(Locale.ROOT)) {
            "blue" -> label("概念")
            "green" -> label("核心")
            "red", "pink" -> label("存疑")
            else -> label("重点")
        }

    private fun notes() {
        val owner = generation
        val bookId = params.optString("bookId")
        if (bookId.isNotEmpty()) {
            body.addView(
                NativeUi.iconTextButton(activity, label("全部笔记"), "back", foreground, background) {
                    navigate("/notes")
                },
            )
        }
        val filterRow = NativeActionFlow(activity)
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
        body.addView(filterRow)
        search(hint = "搜索选区原文、想法或书名")
        val exportProgressView =
            text("", 13f).apply {
                setTextColor(NativeUi.secondary(this@NativePagesController.background))
                fontFeatureSettings = "tnum"
            }
        body.addView(exportProgressView)
        val notesHost = column()
        body.addView(notesHost)
        val draftHost = column()
        body.addView(draftHost)
        showDrafts(draftHost)
        val payload =
            JSONObject()
                .put("query", query)
                .put("filter", noteFilter)
                .put("offset", offset)
                .put("limit", PAGE_SIZE)
        if (bookId.isNotEmpty()) payload.put("bookId", bookId)
        call("library.annotations", payload) { response ->
            val items = response.getJSONArray("items")
            if (items.length() > 0) {
                actions(
                    notesHost,
                    listOf(
                        "导出读书笔记" to { collectAnnotationsForExport(bookId, exportProgressView) { allItems -> exportNotesMarkdownDialog(bookId, allItems) } },
                        "跨书对比预览" to { collectAnnotationsForExport(bookId, exportProgressView) { allItems -> showCrossBookMatrixDialog(allItems) } },
                    ),
                )
            }
            if (items.length() == 0) {
                val unfiltered = query.isBlank() && noteFilter == "all"
                val empty =
                    NativeUi.card(activity, background, 20).apply {
                        val outer =
                            GradientDrawable().apply {
                                setColor(NativeUi.surface(this@NativePagesController.background))
                                setStroke(dp(2), NativeUi.border(this@NativePagesController.background))
                            }
                        val inner =
                            GradientDrawable().apply {
                                setColor(NativeUi.surface(this@NativePagesController.background))
                                setStroke(dp(1), NativeUi.divider(this@NativePagesController.background))
                            }
                        val inset = dp(3)
                        this.background =
                            android.graphics.drawable.LayerDrawable(arrayOf(outer, inner)).apply {
                                setLayerInset(1, inset, inset, inset, inset)
                            }
                    }
                empty.addView(
                    TextView(activity).apply {
                        text = "INDEX // EMPTY NOTES"
                        textSize = 12f
                        typeface = NativeUi.monoTypeface(true)
                        setTextColor(NativeUi.secondary(this@NativePagesController.background))
                        importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
                    },
                )
                empty.addView(
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
                    ).apply {
                        typeface = NativeUi.editorialTypeface(true)
                        setPadding(0, dp(4), 0, dp(4))
                    },
                )
                if (unfiltered) {
                    empty.addView(
                        text(label("在阅读器中选中文字，即可划线或写下想法。"), 13f).apply {
                            setTextColor(NativeUi.secondary(this@NativePagesController.background))
                            setPadding(0, 0, 0, dp(14))
                        },
                    )
                    empty.addView(
                        NativeUi.primaryButton(activity, label("前往藏书"), foreground, background) { navigate("/library") },
                        LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT),
                    )
                }
                notesHost.addView(empty)
                notesHost.addView(NativeUi.colophonTailpiece(activity, "ANNOTATIONS LEDGER · NO DATA", background))
            }
            val batchContainer = column()
            if (bookId.isNotEmpty()) {
                if (items.length() > 0) pageTitle?.text = items.getJSONObject(0).optString("bookTitle", label("全部笔记"))
                for (i in 0 until items.length()) noteRow(items.getJSONObject(i), batchContainer)
            } else {
                // Native backend pages annotation records, not all books. Never present a page-local count as a global count.
                if (items.length() > 0) batchContainer.addView(text(label("本页按书籍分组，点击查看该书全部记录"), 12f))
                val groups = linkedMapOf<String, MutableList<JSONObject>>()
                for (i in 0 until items.length()) {
                    val note = items.getJSONObject(i)
                    groups.getOrPut(note.optString("bookId")) { mutableListOf() }.add(note)
                }
                for ((id, records) in groups) {
                    if (id.isEmpty()) {
                        records.forEach { noteRow(it, batchContainer) }
                        continue
                    }
                    val card = NativeUi.card(activity, background, 16)
                    card.addView(
                        text(records[0].optString("bookTitle", label("已移除的书籍")), 17f, true).apply {
                            setTypeface(Typeface.SERIF, Typeface.BOLD)
                        },
                    )
                    val highlightCount = records.count { it.optString("kind") != "bookmark" }
                    val thoughtCount = records.count { !it.isNull("note") && it.optString("note").isNotEmpty() }
                    val bookmarkCount = records.count { it.optString("kind") == "bookmark" }
                    card.addView(
                        text(
                            label("本页") + ": " + label("标注") + " $highlightCount · " + label("想法") + " $thoughtCount · " + label("书签") +
                                " $bookmarkCount",
                            13f,
                        ).apply {
                            typeface = NativeUi.monoTypeface(false)
                            fontFeatureSettings = "tnum"
                            setTextColor(NativeUi.secondary(this@NativePagesController.background))
                        },
                    )
                    records.take(2).forEach { preview ->
                        val previewQuote =
                            preview.optString("text").takeIf { it.isNotBlank() && it != "null" }
                                ?: preview.optString("note").takeIf { !preview.isNull("note") && it.isNotBlank() && it != "null" }
                        if (previewQuote != null) {
                            val quoteBox =
                                LinearLayout(activity).apply {
                                    orientation = LinearLayout.HORIZONTAL
                                    setBackgroundColor(NativeUi.mutedSurface(this@NativePagesController.background))
                                    layoutParams = LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(6) }
                                }
                            quoteBox.addView(
                                View(activity).apply { setBackgroundColor(this@NativePagesController.foreground) },
                                LinearLayout.LayoutParams(dp(3), -1),
                            )
                            quoteBox.addView(
                                text("“$previewQuote”", 14f).apply {
                                    maxLines = 2
                                    ellipsize = TextUtils.TruncateAt.END
                                    setTypeface(Typeface.SERIF, Typeface.NORMAL)
                                    setPadding(dp(10), dp(6), dp(8), dp(6))
                                },
                                LinearLayout.LayoutParams(0, -2, 1f),
                            )
                            card.addView(quoteBox)
                        }
                    }
                    val open = { navigate("/notes?bookId=${Uri.encode(id)}") }
                    val latestJumpNote = records.firstOrNull { !it.optBoolean("sourceMissing") && (it.optString("readerJumpUrl").isNotEmpty() || it.optString("cfi").isNotEmpty()) }
                    val footer =
                        LinearLayout(activity).apply {
                            orientation = LinearLayout.HORIZONTAL
                            gravity = Gravity.CENTER_VERTICAL
                            setPadding(0, dp(8), 0, 0)
                        }
                    footer.addView(
                        text(dateTime(records.maxOf { it.optLong("createdAt") }), 12f).apply {
                            typeface = NativeUi.monoTypeface(false)
                            fontFeatureSettings = "tnum"
                            setTextColor(NativeUi.secondary(this@NativePagesController.background))
                        },
                        LinearLayout.LayoutParams(0, -2, 1f),
                    )
                    if (latestJumpNote != null) {
                        footer.addView(
                            NativeUi.subtleButton(activity, label("回到原文"), foreground, background) {
                                if (latestJumpNote.optString("readerJumpUrl").isNotEmpty()) {
                                    navigate(latestJumpNote.getString("readerJumpUrl"))
                                } else {
                                    call(
                                        "library.book",
                                        JSONObject().put("id", latestJumpNote.getString("bookId")),
                                    ) {
                                        if (!disposed && owner == generation) {
                                            openReader(it.getJSONObject("book"), latestJumpNote.optString("cfi"))
                                        }
                                    }
                                }
                            }.apply {
                                layoutParams = LinearLayout.LayoutParams(-2, -2).apply { marginEnd = dp(8) }
                            },
                        )
                    }
                    footer.addView(
                        NativeUi.iconTextButton(activity, label("查看记录"), "next", foreground, background, open).apply {
                            layoutParams = LinearLayout.LayoutParams(-2, -2)
                        },
                    )
                    card.addView(footer)
                    card.isFocusable = true
                    card.contentDescription = records[0].optString("bookTitle") + ", " + label("查看记录")
                    card.setOnClickListener { open() }
                    batchContainer.addView(card)
                }
            }
            if (batchContainer.childCount > 0) notesHost.addView(batchContainer)
            notesHost.addView(
                text(label("标注记录总数") + ": " + response.getInt("total"), 12f).apply {
                    fontFeatureSettings = "tnum"
                },
            )
            if (response.getInt("total") > PAGE_SIZE || offset > 0) pageControls(response.getInt("total"), items.length(), target = notesHost)
        }
    }

    private fun noteRow(
        note: JSONObject,
        target: LinearLayout = body,
    ) {
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
                importantForAccessibility =
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
            LinearLayout.LayoutParams(-2, -2).apply { marginEnd = dp(8) },
        )
        if (note.optString("kind") != "bookmark") {
            header.addView(
                NativeUi.pillBadge(activity, highlightRoleLabel(note.optString("color")), foreground, background),
                LinearLayout.LayoutParams(-2, -2).apply { marginEnd = dp(8) },
            )
        }
        header.addView(View(activity), LinearLayout.LayoutParams(0, 1, 1f))
        header.addView(
            text(dateTime(note.optLong("createdAt")), 12f).apply {
                typeface = NativeUi.monoTypeface(false)
                fontFeatureSettings = "tnum"
                setTextColor(NativeUi.secondary(this@NativePagesController.background))
            },
        )
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
                    confirm(
                        "删除",
                        tr("仅删除这条笔记/标注，不修改原书内容。", "Remove this note or highlight only? Book content remains unchanged."),
                    ) {
                        call("library.annotationRemove", JSONObject().put("id", note.getString("id")).put("before", note)) { refresh() }
                    }
                },
            ),
        )
        card.addView(line())
        target.addView(card)
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
                    NativeNoteEditor(
                        activity,
                        note,
                        result,
                        request,
                        { refresh() },
                        ::showError,
                        {
                            if (noteEditor === editor) noteEditor = null
                        },
                        foreground,
                        background,
                        isEnglish(),
                    )
                noteEditor = editor
                editor.show()
            }
        }
    }

    private fun showDrafts(target: LinearLayout = body) {
        val payload = JSONObject()
        if (params.optString("bookId").isNotEmpty()) payload.put("bookId", params.getString("bookId"))
        call("action.noteDraftList", payload) { result ->
            if (!result.optBoolean("ok", true)) {
                showError(result.optString("code"))
                return@call
            }
            target.removeAllViews()
            val drafts = result.getJSONArray("drafts")
            if (drafts.length() == 0) return@call
            val window = draftPager.window(drafts.length())
            val start = window.first
            val end = window.last + 1
            target.addView(
                text(
                    tr("本机草稿：${start + 1}–$end / ${drafts.length()}", "Local drafts: ${start + 1}–$end / ${drafts.length()}"),
                    18f,
                    true,
                ).apply {
                    fontFeatureSettings = "tnum"
                },
            )
            val pager = LinearLayout(activity).apply { setPadding(0, dp(4), 0, dp(8)) }
            pager.addView(
                button("上一页草稿") {
                    draftPager.previous()
                    refresh()
                }.apply {
                    isEnabled = start > 0
                    layoutParams = LinearLayout.LayoutParams(-2, -2).apply { marginEnd = dp(8) }
                },
            )
            pager.addView(
                button("下一页草稿") {
                    draftPager.next()
                    refresh()
                }.apply { isEnabled = end < drafts.length() },
            )
            target.addView(pager)
            for (i in window) {
                val draft = drafts.getJSONObject(i)
                val view = text(draft.optString("text").take(200), 15f)
                view.setTextIsSelectable(true)
                target.addView(view)
                actions(
                    target,
                    listOf(
                        "查看完整草稿" to {
                            val content = text(draft.getString("text"))
                            content.setTextIsSelectable(true)
                            dialog("本机草稿（保存状态需核对）", content, negativeLabel = "关闭")
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
                            confirm(
                                "删除",
                                tr("只删除这一份本机草稿，不改动已保存的批注。", "Discard this local draft only? Saved annotations remain unchanged."),
                            ) {
                                val contextId = draft.getString("contextId")
                                val discardPayload = JSONObject().put("bookId", draft.getString("bookId"))
                                if (contextId.startsWith("anno:")) {
                                    discardPayload.put("id", contextId.removePrefix("anno:"))
                                } else if (contextId.startsWith("sel:")) {
                                    discardPayload.put("contextId", contextId)
                                } else {
                                    showError("use_reader_for_this_draft")
                                    return@confirm
                                }
                                userAction("noteDraftDiscard", discardPayload.put("confirmDiscard", true))
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
            paint.typeface = NativeUi.monoTypeface(false)
            paint.textSize = 14f * resources.displayMetrics.scaledDensity
            val metrics = paint.fontMetrics
            val base = height - (metrics.bottom - metrics.top) - dp(12)
            val topInset = (metrics.bottom - metrics.top) + dp(12)
            paint.textAlign = Paint.Align.LEFT
            val maxSec = max.toLong()
            val maxLabel =
                when {
                    maxSec >= 3600L -> String.format(Locale.ROOT, "%.1f h", max / 3600.0)
                    maxSec >= 60L -> "${(maxSec / 60L)} min"
                    else -> "${maxSec} s"
                }
            canvas.drawText(maxLabel, 0f, -metrics.top, paint)
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
        val owner = generation
        val folder = column()
        val folderSummary =
            text(label("正在检查监控文件夹状态…"), 13f).apply {
                setTextColor(NativeUi.secondary(this@NativePagesController.background))
            }
        folder.addView(folderSummary)
        folder.addView(
            text(
                tr(
                    "选择或重新授权后扫描；原文件任务入口保留真实进度和错误。",
                    "Select or reauthorize a folder to scan; file jobs preserve real progress and errors.",
                ),
                13f,
            ),
        )
        request("action.fileJobStatus", JSONObject()) { result, error ->
            activity.runOnUiThread {
                if (disposed || owner != generation || error != null || result == null) return@runOnUiThread
                val st = result.optJSONObject("status")
                val stateText = st?.optString("state").orEmpty()
                val msgText = st?.optString("message").orEmpty()
                folderSummary.text =
                    when {
                        msgText.isNotEmpty() -> msgText
                        stateText.isNotEmpty() -> tr("状态：$stateText", "State: $stateText")
                        else -> tr("未配置监控文件夹或当前无运行中任务。", "No monitored folder configured or no active job.")
                    }
            }
        }
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
                "导入书库备份" to {
                    confirm(
                        "导入书库备份",
                        tr(
                            "先选择备份；预览只显示文件大小。确认导入后再由恢复服务校验并合并数据。",
                            "Choose a backup archive first; preview checks file size only before the restore service validates and merges data.",
                        ),
                    ) { userAction("backupImport") }
                },
            ),
        )
        val about = column()
        val pkgVersion =
            runCatching {
                @Suppress("DEPRECATION")
                val info = activity.packageManager.getPackageInfo(activity.packageName, 0)
                val code = if (android.os.Build.VERSION.SDK_INT >= 28) info.longVersionCode else @Suppress("DEPRECATION") info.versionCode.toLong()
                "v${info.versionName} ($code)"
            }.getOrDefault("v2.7.0")
        about.addView(
            text("Pagewise · Android · $pkgVersion", 16f, true).apply {
                fontFeatureSettings = "tnum"
            },
        )
        about.addView(
            text(
                tr(
                    "设置由 Android 原生存储统一管理；旧副本仅供迁移前恢复，不再双写。",
                    "Settings are managed in native Android storage; legacy copies are retained only for pre-migration recovery.",
                ),
                13f,
            ),
        )
        actions(about, listOf("使用手册" to { navigate("/manual") }))

        val panel =
            NativeSettingsPanel(
                activity,
                request,
                preferences,
                foreground,
                background,
                {
                    invalidatePreferences()
                    refresh()
                },
                repaint,
                onLocalChange = {
                    applyPreferencesTheme()
                    invalidatePreferences()
                },
            )
        settingsPanel = panel
        val requested = settingsUiState.requested
        settingsUiState.requested = null
        body.addView(panel.renderPage(mapOf("folder" to folder, "data" to data, "about" to about), requested, settingsUiState))
    }

    private fun manual() {
        activeManualRenderer = null
        body.addView(
            text(
                tr(
                    "离线手册。历史实验功能以当前应用实际可用入口为准。",
                    "Offline manual. Availability follows the active entry points in this build.",
                ),
                12f,
            ),
        )
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
                                minHeight = dp(48)
                            }

                        override fun getDropDownView(
                            position: Int,
                            convertView: View?,
                            parent: ViewGroup,
                        ): View =
                            (super.getDropDownView(position, convertView, parent) as TextView).apply {
                                setTextColor(this@NativePagesController.foreground)
                                setBackgroundColor(this@NativePagesController.background)
                                minHeight = dp(48)
                                gravity = Gravity.CENTER_VERTICAL
                                setPadding(dp(12), dp(8), dp(12), dp(8))
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
        val epoch = generation
        call("manual.get", JSONObject().put("file", manual)) { result ->
            if (disposed || epoch != generation || page != "manual") return@call
            val renderer = NativeManualRenderer(activity, foreground, background) { href -> manualLink(href) }
            activeManualRenderer = renderer
            article.addView(renderer.render(result.getString("markdown")))
            if (manualAnchor.isNotEmpty()) renderer.scrollToAnchor(scroll, manualAnchor)
        }
    }

    private fun manualLink(href: String) {
        if (href.startsWith("#")) {
            manualAnchor = href.removePrefix("#")
            val renderer = activeManualRenderer
            if (renderer != null) {
                renderer.scrollToAnchor(scroll, href)
            } else {
                refresh()
            }
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
        confirm(
            "打开网页",
            tr(
                "将在系统浏览器打开：${uri.host.orEmpty()}。离线手册本身不会联网。",
                "Open ${uri.host.orEmpty()} in the system browser? The offline manual itself has no network access.",
            ),
        ) {
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
        val date = if (Regex("^[0-9]{4}-[0-9]{2}-[0-9]{2}").containsMatchIn(raw)) raw.take(10) else raw
        return if (date.startsWith("0101-") || date.startsWith("0001-") || date.startsWith("1900-01-01")) "" else date
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
        return if (minutes >= 60) {
            tr("${minutes / 60} 小时 ${minutes % 60} 分钟", "${minutes / 60}h ${minutes % 60}m")
        } else if (minutes > 0) {
            tr("$minutes 分钟", "${minutes}m")
        } else {
            tr("${seconds.toInt()} 秒", "${seconds.toInt()}s")
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
