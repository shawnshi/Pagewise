package io.pagewise.reader

import android.app.Activity
import android.app.AlertDialog
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.view.KeyEvent
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONObject

/** Reuses the existing draft owner; no parallel native draft database and no CFI/quote rewrite. */
internal class NativeNoteEditor(
    private val activity: Activity,
    note: JSONObject,
    private val recovery: JSONObject,
    private val request: (String, JSONObject, NativePageReply) -> Unit,
    private val onSaved: () -> Unit,
    private val onError: (String) -> Unit,
    private val onClosed: () -> Unit = {},
    private val foreground: Int = android.graphics.Color.BLACK,
    private val background: Int = android.graphics.Color.WHITE,
) {
    private val fg = foreground
    private val bg = background
    private val before = JSONObject(note.toString())
    private val bookId = note.getString("bookId")
    private val id = note.getString("id")
    private val initial = recovery.optJSONObject("draft")?.getString("text") ?: recovery.optString("text", note.optString("note"))
    private val editor =
        EditText(activity).apply {
            setText(initial)
            minLines = 6
            setTextColor(fg)
            setHintTextColor(NativeUi.disabled(bg))
            setBackground(NativeUi.shape(activity, bg))
            setPadding(NativeUi.dp(activity, 10), NativeUi.dp(activity, 8), NativeUi.dp(activity, 10), NativeUi.dp(activity, 8))
            inputType =
                InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE
        }
    private val status =
        TextView(activity).apply {
            textSize = 13f
            setTextColor(NativeUi.secondary(bg))
            setPadding(0, NativeUi.dp(activity, 8), 0, NativeUi.dp(activity, 4))
        }
    private val main = Handler(Looper.getMainLooper())
    private var annotationBusy = false
    private var closed = false
    private var safeClose = false
    private val draft = NativeDraftBarrier(initial, ::writeDraft, ::draftChanged)
    private var dialog: AlertDialog? = null
    private var backCleanup: (() -> Unit)? = null
    private val delayed = Runnable { draft.autosave() }

    private fun payload() = JSONObject().put("bookId", bookId).put("id", id)

    private fun live() = !closed && !activity.isFinishing && !activity.isDestroyed

    fun show(): AlertDialog {
        val form =
            LinearLayout(activity).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(NativeUi.dp(activity, 4), NativeUi.dp(activity, 4), NativeUi.dp(activity, 4), NativeUi.dp(activity, 4))
            }
        form.addView(
            TextView(activity).apply {
                text = "只编辑笔记正文；选区原文、书籍 ID 和阅读位置保持不变。"
                textSize = 14f
                setTextColor(NativeUi.secondary(bg))
                setPadding(0, 0, 0, NativeUi.dp(activity, 8))
            },
        )
        val quoteText = before.optString("text")
        if (quoteText.isNotEmpty()) {
            val quoteRow =
                LinearLayout(activity).apply {
                    orientation = LinearLayout.HORIZONTAL
                    setBackgroundColor(NativeUi.mutedSurface(bg))
                    layoutParams = LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = NativeUi.dp(activity, 10) }
                }
            quoteRow.addView(
                android.view.View(activity).apply { setBackgroundColor(fg) },
                LinearLayout.LayoutParams(NativeUi.dp(activity, 3), -1),
            )
            val quoteView =
                TextView(activity).apply {
                    text = quoteText
                    textSize = 14f
                    maxLines = 4
                    ellipsize = android.text.TextUtils.TruncateAt.END
                    typeface = NativeUi.editorialTypeface(false)
                    setTextColor(fg)
                    setPadding(NativeUi.dp(activity, 12), NativeUi.dp(activity, 8), NativeUi.dp(activity, 12), NativeUi.dp(activity, 8))
                    setOnClickListener {
                        maxLines = if (maxLines == 4) Int.MAX_VALUE else 4
                    }
                }
            quoteRow.addView(quoteView, LinearLayout.LayoutParams(0, -2, 1f))
            form.addView(quoteRow)
        }
        form.addView(editor)
        form.addView(status)
        status.text = if (recovery.optString("code") == "draft_recovered") "已恢复本机草稿，尚未写入批注。" else "输入后自动保留本机草稿。"
        val window =
            NativeEinkDialog(
                activity,
                "编辑笔记",
                form,
                foreground,
                background,
                listOf(
                    AlertDialog.BUTTON_POSITIVE to "保存批注",
                    AlertDialog.BUTTON_NEGATIVE to "保留草稿并关闭",
                    AlertDialog.BUTTON_NEUTRAL to "放弃本次输入",
                ),
                cancelableOutside = false,
                onDismissed = {
                    backCleanup?.invoke()
                    backCleanup = null
                    closed = true
                    onClosed()
                    main.removeCallbacks(delayed)
                    // Activity/process teardown is not a saved-draft ACK. Normal leaves use flushForLeave first.
                    draft.abandon(safeClose)
                },
            )
        dialog = window
        // Neither outside taps nor Android 13+ default dialog cancellation may bypass the durable leave barrier.
        window.setCancelable(false)
        window.setCanceledOnTouchOutside(false)
        window.setOnKeyListener { _, key, event ->
            if (key ==
                KeyEvent.KEYCODE_BACK
            ) {
                if (event.action == KeyEvent.ACTION_UP) requestClose()
                true
            } else {
                false
            }
        }
        window.setOnShowListener {
            if (android.os.Build.VERSION.SDK_INT >= 33) backCleanup = BackApi33.bind(window) { requestClose() }
            window.getButton(AlertDialog.BUTTON_POSITIVE)?.setOnClickListener { save() }
            window.getButton(AlertDialog.BUTTON_NEGATIVE)?.setOnClickListener { requestClose() }
            window.getButton(AlertDialog.BUTTON_NEUTRAL)?.setOnClickListener {
                val msg =
                    TextView(activity).apply {
                        text = "不会删除已存在的本机草稿，也不回滚已发送的保存。批注正文不会因此改变。"
                        textSize = 15f
                        setTextColor(fg)
                        setLineSpacing(0f, 1.4f)
                    }
                val confirmAbandon =
                    NativeEinkDialog(
                        activity,
                        "放弃本次输入？",
                        msg,
                        foreground,
                        background,
                        listOf(
                            AlertDialog.BUTTON_POSITIVE to "放弃并关闭",
                            AlertDialog.BUTTON_NEGATIVE to "返回编辑",
                        ),
                    )
                confirmAbandon.setOnShowListener {
                    confirmAbandon.getButton(AlertDialog.BUTTON_POSITIVE)?.setOnClickListener {
                        confirmAbandon.dismiss()
                        safeClose = true
                        draft.abandon(true)
                        main.removeCallbacks(delayed)
                        window.dismiss()
                    }
                }
                confirmAbandon.show()
            }
        }
        editor.addTextChangedListener(
            object : TextWatcher {
                override fun beforeTextChanged(
                    s: CharSequence?,
                    start: Int,
                    count: Int,
                    after: Int,
                ) {}

                override fun onTextChanged(
                    s: CharSequence?,
                    start: Int,
                    before: Int,
                    count: Int,
                ) {}

                override fun afterTextChanged(s: Editable?) {
                    draft.edit(s.toString())
                    main.removeCallbacks(delayed)
                    if (status.tag != "dirty") {
                        status.tag = "dirty"
                        status.text = "草稿尚未确认保存，请勿强制关闭。"
                    }
                    main.postDelayed(delayed, 450)
                }
            },
        )
        window.show()
        return window
    }

    /** Normal transitions flush without dismissing; the current navigation fence alone may apply the leave. */
    fun flushForLeave(reply: (String?) -> Unit) {
        if (safeClose) {
            reply(null)
            return
        }
        if (annotationBusy) {
            reply("native_mutation_pending")
            return
        }
        if (closed || activity.isFinishing || activity.isDestroyed) {
            reply("draft_unconfirmed")
            return
        }
        main.removeCallbacks(delayed)
        draft.edit(editor.text.toString())
        draft.flush(reply)
    }

    fun closeConfirmed(): Boolean {
        if (safeClose) return true
        if (closed || annotationBusy || !draft.isConfirmed()) return false
        safeClose = true
        dialog?.dismiss()
        return true
    }

    fun requestClose(reply: ((String?) -> Unit)? = null) {
        flushForLeave { error ->
            val failure = error ?: if (closeConfirmed()) null else "draft_unconfirmed"
            if (failure != null && live()) {
                editor.isEnabled = true
                status.text = "草稿保存未确认；当前输入仍在，请复制或核对后重试。"
                if (reply == null) onError(failure)
            }
            reply?.invoke(failure)
        }
    }

    private fun draftChanged(error: String?) {
        if (live()) {
            status.tag = if (error != null || draft.desired != draft.confirmed) "dirty" else "clean"
            status.text =
                if (error != null) {
                    "草稿保存未确认；当前输入仍在，请复制或核对后重试。"
                } else if (draft.desired != draft.confirmed) {
                    "先前草稿已确认，最新输入仍在等待。"
                } else {
                    "本机草稿已确认；批注正文尚未提交。"
                }
        }
    }

    private fun writeDraft(
        text: String,
        complete: (String?) -> Unit,
    ) {
        request("action.noteDraftSave", payload().put("text", text)) { result, error ->
            activity.runOnUiThread {
                complete(
                    error
                        ?: if (result?.optBoolean("ok") ==
                            true
                        ) {
                            null
                        } else {
                            result?.optString("code", "draft_save_failed") ?: "draft_save_failed"
                        },
                )
            }
        }
    }

    private fun save() {
        if (annotationBusy || !live()) return
        annotationBusy = true
        editor.isEnabled = false
        main.removeCallbacks(delayed)
        draft.edit(editor.text.toString())
        draft.flush { error ->
            if (!live() || safeClose) return@flush
            if (error != null) {
                annotationBusy = false
                editor.isEnabled = true
                status.text = "草稿保存未确认；当前输入仍在。"
                onError(error)
            } else {
                commitAnnotation(draft.confirmed)
            }
        }
    }

    @android.annotation.TargetApi(33)
    private object BackApi33 {
        fun bind(
            dialog: AlertDialog,
            close: () -> Unit,
        ): () -> Unit {
            val dispatcher = dialog.onBackInvokedDispatcher
            val callback = android.window.OnBackInvokedCallback { close() }
            dispatcher.registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, callback)
            return { dispatcher.unregisterOnBackInvokedCallback(callback) }
        }
    }

    private fun commitAnnotation(text: String) {
        annotationBusy = true
        status.text = "正在提交批注…"
        request(
            "library.annotationPatch",
            JSONObject().put("id", id).put("before", before).put("patch", JSONObject().put("note", text)),
        ) { result, error ->
            activity.runOnUiThread {
                if (!live()) return@runOnUiThread
                if (error != null ||
                    result == null
                ) {
                    annotationBusy = false
                    editor.isEnabled = true
                    status.text = "批注提交未确认，草稿已保留；不要假定未提交。"
                    onError(error ?: "invalid_response")
                    return@runOnUiThread
                }
                // User Save authorizes clearing this exact saved draft, not unrelated drafts.
                request("action.noteDraftDiscard", payload().put("confirmDiscard", true)) { cleaned, cleanupError ->
                    activity.runOnUiThread {
                        if (!live()) return@runOnUiThread
                        annotationBusy = false
                        safeClose = true
                        dialog?.dismiss()
                        onSaved()
                        if (cleanupError != null || cleaned?.optBoolean("ok") != true) onError("annotation_saved_draft_pending")
                    }
                }
            }
        }
    }
}
