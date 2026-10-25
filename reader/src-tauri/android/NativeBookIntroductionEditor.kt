package io.pagewise.reader

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.graphics.Typeface
import android.os.Build
import android.text.Editable
import android.text.InputFilter
import android.text.InputType
import android.text.TextWatcher
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONObject
import java.util.UUID

/** Metadata-only AI proposal; no library mutation until the explicit Replace button. */
internal class NativeBookIntroductionEditor(
    private val activity: Activity,
    private val book: JSONObject,
    private val foreground: Int,
    private val background: Int,
    private val english: Boolean,
    private val request: (String, JSONObject, NativePageReply) -> Unit,
    private val current: () -> Boolean,
    private val saved: () -> Unit,
    private val onClosed: (AlertDialog) -> Unit,
) {
    private val id = book.getString("id")
    private var dialog: AlertDialog? = null
    private lateinit var series: EditText
    private lateinit var editor: EditText
    private lateinit var status: TextView
    private var requestId = ""
    private var token = ""
    private var epoch = 0
    private var generating = false
    private var saving = false
    private var outcomeUnknown = false
    private var closed = false
    private var backCleanup: (() -> Unit)? = null

    private fun tr(
        zh: String,
        en: String,
    ) = if (english) en else zh

    private fun live() = !closed && current() && !activity.isFinishing && !activity.isDestroyed && dialog?.isShowing == true

    fun canLeave() = !saving

    fun show(): AlertDialog {
        val form = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }
        form.setPadding(NativeUi.dp(activity, 16), NativeUi.dp(activity, 8), NativeUi.dp(activity, 16), NativeUi.dp(activity, 8))

        fun text(
            value: String,
            size: Float = 14f,
        ) = TextView(activity).apply {
            text = value
            textSize = size
            setTextColor(this@NativeBookIntroductionEditor.foreground)
            setPadding(0, NativeUi.dp(activity, 8), 0, NativeUi.dp(activity, 8))
        }
        form.addView(text(book.optString("title"), 17f).apply { setTypeface(null, Typeface.BOLD) })
        form.addView(
            text(
                tr(
                    "仅向当前 AI 服务发送书名、作者、出版社、出版日期和本次丛书输入；不发送正文、批注、进度或原简介。",
                    "Sends only title, authors, publisher, publication date, and the series entered here to the current AI service—not book text, annotations, progress, or the original description.",
                ),
            ),
        )
        form.addView(text(tr("丛书（可选，仅本次使用）", "Series (optional; this request only)")))
        series =
            EditText(activity).apply {
                setTextColor(this@NativeBookIntroductionEditor.foreground)
                setBackgroundColor(this@NativeBookIntroductionEditor.background)
                setSingleLine(true)
                filters = arrayOf(InputFilter.LengthFilter(1024))
                contentDescription = tr("丛书", "Series")
                minimumHeight = NativeUi.dp(activity, 48)
            }
        form.addView(series, LinearLayout.LayoutParams(-1, -2))
        status =
            text(
                tr(
                    "AI 生成稿未经事实核验。生成后请校阅，确认替换才会保存原书简介。",
                    "AI draft, not fact-checked. Review it before explicitly replacing the book description.",
                ),
            )
        status.accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
        form.addView(status)
        editor =
            EditText(activity).apply {
                setTextColor(this@NativeBookIntroductionEditor.foreground)
                setBackgroundColor(this@NativeBookIntroductionEditor.background)
                setTextSize(16f)
                inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
                minLines = 10
                gravity = android.view.Gravity.TOP
                filters = arrayOf(InputFilter.LengthFilter(16_000))
                contentDescription = tr("简介生成预览，可编辑和复制", "Introduction preview, editable and copyable")
                setTextIsSelectable(true)
            }
        form.addView(editor, LinearLayout.LayoutParams(-1, -2))
        editor.addTextChangedListener(
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
                ) = Unit

                override fun afterTextChanged(s: Editable?) {
                    controls()
                }
            },
        )
        val window: AlertDialog = IntroductionDialog(
            activity,
            tr("AI 书籍简介", "AI book introduction"),
            ScrollView(activity).apply { isFillViewport = true; addView(form) },
            foreground,
            background,
            listOf(
                AlertDialog.BUTTON_POSITIVE to tr("生成简介", "Generate"),
                AlertDialog.BUTTON_NEUTRAL to tr("确认替换", "Replace"),
                AlertDialog.BUTTON_NEGATIVE to tr("关闭", "Close"),
            ),
        )
        dialog = window
        window.setCancelable(false)
        window.setCanceledOnTouchOutside(false)
        window.setOnKeyListener { _, keyCode, event ->
            if (keyCode == KeyEvent.KEYCODE_BACK) {
                if (event.action == KeyEvent.ACTION_UP) requestClose()
                true
            } else {
                false
            }
        }
        window.setOnShowListener {
            if (Build.VERSION.SDK_INT >= 33) backCleanup = BackApi33.bind(window, ::requestClose)
            window.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener { generate() }
            window.getButton(AlertDialog.BUTTON_NEUTRAL).setOnClickListener { save() }
            window.getButton(AlertDialog.BUTTON_NEGATIVE).setOnClickListener { requestClose() }
            for (which in listOf(AlertDialog.BUTTON_POSITIVE, AlertDialog.BUTTON_NEUTRAL, AlertDialog.BUTTON_NEGATIVE)) {
                window.getButton(which).minimumHeight =
                    NativeUi.dp(activity, 48)
            }
            controls()
        }
        window.setOnDismissListener {
            if (!closed) {
                closed = true
                epoch++
                cancelProposal()
                backCleanup?.invoke()
                backCleanup = null
                onClosed(window)
            }
        }
        window.show()
        return window
    }

    private fun controls() {
        val window = dialog ?: return
        series.isEnabled = !generating && !saving
        editor.isEnabled = !generating && !saving
        window.getButton(AlertDialog.BUTTON_POSITIVE)?.isEnabled = !generating && !saving && !outcomeUnknown
        window.getButton(AlertDialog.BUTTON_NEUTRAL)?.isEnabled =
            token.isNotEmpty() && !generating && !saving && !outcomeUnknown && editor.text.toString().isNotBlank()
        window.getButton(AlertDialog.BUTTON_NEGATIVE)?.isEnabled = !saving
    }

    private fun cancelProposal() {
        if (requestId.isEmpty()) return
        val payload = JSONObject().put("bookId", id).put("requestId", requestId).put("token", token)
        requestId = ""
        token = ""
        try {
            request("action.bookIntroductionCancel", payload) { _, _ -> }
        } catch (_: RuntimeException) {
            // Best-effort cancellation of a non-mutating request; never claim to undo a submitted save.
        }
    }

    fun requestClose() {
        if (saving) {
            status.text = tr("正在保存，不能取消已提交的保存。请等待结果。", "Saving. A submitted save cannot be cancelled; wait for its result.")
            return
        }
        dialog?.dismiss()
    }

    fun closeForLeave(): Boolean {
        if (saving) return false
        dialog?.dismiss()
        return true
    }

    fun dispose() {
        dialog?.dismiss()
    }

    private fun generate() {
        if (!live() || generating || saving || outcomeUnknown) return
        cancelProposal()
        val owner = ++epoch
        requestId = UUID.randomUUID().toString()
        val rid = requestId
        generating = true
        outcomeUnknown = false
        status.text = tr("正在生成简介…关闭可取消本次请求，原文未变。", "Generating… Close to cancel this request. The original is unchanged.")
        controls()
        request(
            "action.bookIntroductionGenerate",
            JSONObject().put("bookId", id).put("requestId", rid).put("series", series.text.toString()),
        ) { result, error ->
            activity.runOnUiThread {
                if (!live() || owner != epoch) return@runOnUiThread
                generating = false
                if (error != null || result?.optBoolean("ok") != true) {
                    status.text = failure(error ?: result?.optString("code") ?: "generation_failed")
                    controls()
                    return@runOnUiThread
                }
                if (result.optString("bookId") != id || result.optString("requestId") != rid || result.optString("token").isEmpty() ||
                    result.optString("text").isBlank()
                ) {
                    status.text = failure("generation_failed")
                    controls()
                    return@runOnUiThread
                }
                token = result.getString("token")
                editor.setText(result.getString("text"))
                status.text =
                    tr(
                        "生成稿未经事实核验，可编辑或复制。点击“确认替换”后才写入本书简介。",
                        "Draft not fact-checked. Edit or copy it. Replace explicitly to save it to this book.",
                    )
                controls()
            }
        }
    }

    private fun save() {
        if (!live() || saving || generating || outcomeUnknown || token.isEmpty()) return
        val value = editor.text.toString()
        if (value.isBlank() || value.length > 16_000) return
        val owner = epoch
        saving = true
        status.text = tr("正在保存，请等待；已提交的保存不能取消。", "Saving. Wait for the result; a submitted save cannot be cancelled.")
        controls()
        request(
            "action.bookIntroductionSave",
            JSONObject()
                .put("bookId", id)
                .put("token", token)
                .put("text", value)
                .put("confirmReplace", true),
        ) { result, error ->
            activity.runOnUiThread {
                if (!live() || owner != epoch) return@runOnUiThread
                saving = false
                if (error != null || result?.optBoolean("ok") != true || result.optString("bookId") != id || !result.optBoolean("saved")) {
                    val code =
                        if (error !=
                            null
                        ) {
                            "commit_outcome_unknown"
                        } else {
                            result?.optString("code", "commit_outcome_unknown") ?: "commit_outcome_unknown"
                        }
                    outcomeUnknown = code == "commit_outcome_unknown"
                    if (code == "source_changed" || code == "stale_preview") token = ""
                    status.text = failure(code)
                    controls()
                    return@runOnUiThread
                }
                token = ""
                dialog?.dismiss()
                saved()
            }
        }
    }

    private fun failure(code: String): String =
        when (code) {
            "unconfigured" -> {
                tr("请先到设置配置 AI 服务。原简介未变。", "Configure AI in Settings first. The original is unchanged.")
            }

            "settings_recovery_required", "settings_unavailable" -> {
                tr(
                    "设置有未提交或失败项，请先到设置处理并保存。",
                    "Resolve pending or failed settings changes first.",
                )
            }

            "source_changed" -> {
                tr(
                    "书目信息或原简介已变化，未覆盖。请核对后重新生成；本稿仍可复制。",
                    "Book metadata or description changed. Nothing was overwritten. Review and regenerate; this draft remains copyable.",
                )
            }

            "commit_outcome_unknown" -> {
                tr(
                    "保存结果未知。请复制或保留本稿，关闭后重新打开详情核对；不要重复保存。",
                    "Save outcome unknown. Keep or copy this draft and reopen details to check. Do not blindly save again.",
                )
            }

            "busy" -> {
                tr("已有请求正在处理，请稍候。", "A request is already in progress. Please wait.")
            }

            "cancelled" -> {
                tr("本次生成已取消，原简介未变。", "Generation cancelled. The original is unchanged.")
            }

            "stale_preview" -> {
                tr("预览已过期或书籍不匹配，请重新生成。", "Preview expired or belongs to another book. Regenerate it.")
            }

            else -> {
                tr(
                    "简介生成或处理未成功。原稿仍在，请检查配置后重试。",
                    "Introduction processing failed. The draft remains available; check the configuration before retrying.",
                )
            }
        }

    /** Keep the existing AlertDialog/button API, without relying on the platform's
     * single-row minimum-height reservation for a stacked three-button panel. */
    private class IntroductionDialog(
        activity: Activity,
        title: String,
        body: View,
        ink: Int,
        surface: Int,
        captions: List<Pair<Int, String>>,
    ) : AlertDialog(activity) {
        private val actions = captions.associate { (which, caption) ->
            which to NativeUi.button(activity, caption, ink, surface) {}.apply {
                id = when (which) {
                    BUTTON_POSITIVE -> android.R.id.button1
                    BUTTON_NEGATIVE -> android.R.id.button2
                    else -> android.R.id.button3
                }
                if (which == BUTTON_NEUTRAL) isEnabled = false
            }
        }

        init {
            val footer = NativeActionFlow(activity).apply {
                setPadding(NativeUi.dp(activity, 16), NativeUi.dp(activity, 8), NativeUi.dp(activity, 16), NativeUi.dp(activity, 8))
                actions.values.forEach { addView(it) }
            }
            setTitle(title)
            setView(IntroductionContent(activity, body, footer))
        }

        override fun getButton(whichButton: Int): Button? = actions[whichButton] ?: super.getButton(whichButton)
    }

    /** Measure the entire responsive footer first. Only the remaining bounded
     * height belongs to the scrolling body, on every width/font/IME remeasure. */
    private class IntroductionContent(
        context: Context,
        private val body: View,
        private val footer: View,
    ) : ViewGroup(context) {
        init { addView(body); addView(footer) }

        override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
            val width = resolveSize(resources.displayMetrics.widthPixels, widthMeasureSpec)
            val limit = if (MeasureSpec.getMode(heightMeasureSpec) == MeasureSpec.UNSPECIFIED) {
                (resources.displayMetrics.heightPixels * 0.8f).toInt()
            } else MeasureSpec.getSize(heightMeasureSpec)
            val childWidth = MeasureSpec.makeMeasureSpec((width - paddingLeft - paddingRight).coerceAtLeast(0), MeasureSpec.EXACTLY)
            val available = (limit - paddingTop - paddingBottom).coerceAtLeast(0)
            footer.measure(childWidth, MeasureSpec.makeMeasureSpec(available, MeasureSpec.AT_MOST))
            body.measure(childWidth, MeasureSpec.makeMeasureSpec((available - footer.measuredHeight).coerceAtLeast(0), MeasureSpec.AT_MOST))
            setMeasuredDimension(width, resolveSize(body.measuredHeight + footer.measuredHeight + paddingTop + paddingBottom, heightMeasureSpec))
        }

        override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
            val footerTop = (height - paddingBottom - footer.measuredHeight).coerceAtLeast(paddingTop)
            body.layout(paddingLeft, paddingTop, width - paddingRight, minOf(paddingTop + body.measuredHeight, footerTop))
            footer.layout(paddingLeft, footerTop, width - paddingRight, footerTop + footer.measuredHeight)
        }
    }

    private object BackApi33 {
        fun bind(
            window: AlertDialog,
            close: () -> Unit,
        ): () -> Unit {
            val dispatcher = window.onBackInvokedDispatcher
            val callback = android.window.OnBackInvokedCallback { close() }
            dispatcher.registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, callback)
            return { dispatcher.unregisterOnBackInvokedCallback(callback) }
        }
    }
}
