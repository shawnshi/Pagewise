package io.pagewise.reader

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.text.InputType
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject

/** Typed native controls. Schema/presets and every durable mutation belong to the shared JS owners. */
internal class NativeSettingsPanel(
    private val activity: Activity,
    private val request: (String, JSONObject, NativePageReply) -> Unit,
    private val preferences: JSONObject,
    private val ink: Int,
    private val background: Int,
    private val changed: () -> Unit,
    private val repaint: () -> Unit,
) {
    private var closed = false
    private var busy = false
    private var dialog: AlertDialog? = null
    private var recoveryParent: AlertDialog? = null
    private var providers = JSONArray()
    private val english = preferences.optString("language") == "en"

    private fun tr(
        zh: String,
        en: String,
    ) = if (english) en else zh

    private fun dp(value: Int) = (value * activity.resources.displayMetrics.density).toInt()

    private fun column() =
        LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(8), dp(4), dp(8), dp(4))
        }

    private fun text(value: String) =
        TextView(activity).apply {
            this.text = value
            textSize = 16f
            setTextColor(ink)
            setPadding(dp(4), dp(10), dp(4), dp(8))
        }

    private fun button(
        title: String,
        action: () -> Unit,
    ) = Button(activity).apply {
        text = title
        isAllCaps = false
        minHeight = dp(48)
        setTextColor(ink)
        background =
            GradientDrawable().apply {
                setColor(this@NativeSettingsPanel.background)
                setStroke(dp(1).coerceAtLeast(1), ink)
            }
        setOnClickListener { if (!busy && !closed) action() }
    }

    private fun perform(
        action: String,
        payload: JSONObject,
        success: (JSONObject) -> Unit,
        failure: (String) -> Unit,
    ) {
        if (busy || closed) return
        busy = true
        dialog?.setCancelable(false)
        dialog?.getButton(AlertDialog.BUTTON_POSITIVE)?.isEnabled = false
        dialog?.getButton(AlertDialog.BUTTON_NEGATIVE)?.isEnabled = false
        val completed: NativePageReply = { result, error ->
            activity.runOnUiThread {
                busy = false
                if (!closed) {
                    dialog?.setCancelable(true)
                    dialog?.getButton(AlertDialog.BUTTON_POSITIVE)?.isEnabled = true
                    dialog?.getButton(AlertDialog.BUTTON_NEGATIVE)?.isEnabled = true
                    if (error != null || result == null ||
                        !result.optBoolean("ok")
                    ) {
                        failure(error ?: result?.optString("code", "native_action_error") ?: "native_action_error")
                    } else {
                        success(result)
                    }
                    repaint()
                }
            }
        }
        try {
            request("action.$action", payload, completed)
        } catch (_: Exception) {
            completed(null, "native_action_error")
        }
    }

    fun render(): View {
        val root = column()
        val status = text(tr("正在加载设置定义…", "Loading settings schema…"))
        root.addView(status)
        root.addView(button(tr("核对未保存设置 / 恢复", "Inspect unsaved settings / recovery")) { recovery() })
        perform("settingsSchema", JSONObject(), { schema ->
            root.removeAllViews()
            root.addView(button(tr("核对未保存设置 / 恢复", "Inspect unsaved settings / recovery")) { recovery() })
            providers = schema.getJSONArray("providers")
            val fields = schema.getJSONArray("fields")
            for ((group, title) in listOf(
                "general" to tr("通用", "General"),
                "reading" to tr("阅读与声音", "Reading and speech"),
                "ai" to tr("AI 服务", "AI service"),
                "network" to tr("网络", "Network"),
            )) {
                root.addView(text(title).apply { textSize = 21f })
                if (group == "ai") {
                    root.addView(button(tr("服务商：", "Provider: ") + preferences.optString("aiProvider")) { selectProvider() })
                    root.addView(
                        text(
                            tr(
                                "只使用自有密钥；切换服务不复制密钥或新增伴读授权。",
                                "Own keys only. Switching providers never copies keys or grants companion consent.",
                            ),
                        ),
                    )
                }
                for (i in 0 until fields.length()) {
                    val rule = fields.getJSONObject(i)
                    if (rule.getString("group") != group) continue
                    val path = rule.getJSONArray("path")
                    val parent = parentOf(path) ?: continue
                    val key = path.getString(path.length() - 1)
                    if (!parent.has(key)) continue
                    val value = parent.get(key)
                    val label = rule.getString(if (english) "labelEn" else "label")
                    val summary =
                        if (rule.optBoolean("secret")) {
                            if (value.toString().isEmpty()) tr("未设置", "Not set") else "••••••••"
                        } else {
                            value.toString().take(100)
                        }
                    root.addView(button("$label: $summary") { edit(rule, value) })
                }
                if (group == "general") root.addView(button(tr("藏书每页显示数量", "Library page size")) { libraryDisplay() })
                if (group == "reading") {
                    root.addView(
                        button(tr("恢复默认排版", "Reset reader typography")) {
                            confirmMutation(
                                "settingsResetReader",
                                tr(
                                    "仅恢复默认阅读排版；书籍、批注、密钥及单书/语言配置保留。",
                                    "Reset reader defaults only; books, notes, keys and book/language overrides remain.",
                                ),
                            )
                        },
                    )
                    root.addView(button(tr("物理尺寸校准", "Physical display calibration")) { calibration() })
                    root.addView(
                        button(tr("清除显示校准", "Clear display calibration")) {
                            confirmMutation(
                                "settingsCalibrationClear",
                                tr("清除手动尺标校准；不删除书籍或排版覆盖。", "Clear manual ruler calibration without deleting books or overrides."),
                            )
                        },
                    )
                }
                if (group == "ai") {
                    root.addView(button(tr("测试 AI 连接（发送 OK 请求）", "Test AI connection (send OK request)")) { probe("settingsTestAi") })
                    provider()?.optString("docsUrl")?.takeIf { it.isNotEmpty() }?.let { url ->
                        root.addView(button(tr("服务商文档 / 获取密钥", "Provider documentation / keys")) { openLink(url, status) })
                    }
                }
                if (group == "network") root.addView(button(tr("测试代理连接", "Test proxy connection")) { probe("settingsTestProxy") })
            }
            root.addView(
                text(
                    tr(
                        "单书/语言排版、阅读模式和伴读授权仍由正文阅读器内的对应控件管理；结构记录不作为任意 JSON 开放编辑。",
                        "Book/language typography, reading modes and companion consent use their reader controls; structured records are not arbitrary JSON editors.",
                    ),
                ),
            )
            status.text = ""
            root.addView(status)
            repaint()
        }, { code -> status.text = tr("设置定义加载失败：", "Schema load failed: ") + code })
        return root
    }

    private fun parentOf(path: JSONArray): JSONObject? {
        var parent = preferences
        for (i in 0 until path.length() - 1) parent = parent.optJSONObject(path.getString(i)) ?: return null
        return parent
    }

    private fun provider(): JSONObject? =
        (0 until providers.length()).map { providers.getJSONObject(it) }.firstOrNull {
            it.optString("id") ==
                preferences.optString("aiProvider")
        }

    private fun modal(
        title: String,
        content: View,
        save: (AlertDialog) -> Unit,
    ): AlertDialog {
        dialog?.dismiss()
        val alert =
            AlertDialog
                .Builder(
                    activity,
                ).setTitle(title)
                .setView(content)
                .setNegativeButton(tr("关闭（不撤销已提交操作）", "Close (does not cancel submitted work)"), null)
                .setNeutralButton(tr("核对恢复", "Recovery"), null)
                .setPositiveButton(tr("保存", "Save"), null)
                .create()
        dialog = alert
        alert.setCanceledOnTouchOutside(false)
        alert.setOnDismissListener { if (dialog === alert) dialog = null }
        alert.setOnShowListener {
            alert.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener { if (!busy) save(alert) }
            alert.getButton(AlertDialog.BUTTON_NEUTRAL).setOnClickListener { if (!busy) recovery() }
        }
        alert.show()
        return alert
    }

    /** Shared recovery surface; deliberately independent of normal route/action barriers. */
    fun showRecovery() {
        if (closed || busy || dialog?.isShowing == true) return
        recovery()
    }

    private fun recovery() {
        if (busy || closed || recoveryParent != null) return
        val parent = dialog
        val form = column()
        val status =
            text(tr("只查询回执及当前设置；不会重发、撤销或丢弃输入。", "Inspect receipts and current settings only; no replay, cancellation or input discard."))
        var token: String? = null
        var retryable = false
        var resolved = false
        val alert =
            AlertDialog
                .Builder(activity)
                .setTitle(tr("设置恢复", "Settings recovery"))
                .setView(ScrollView(activity).apply { addView(form) })
                .setNegativeButton(tr("返回原输入", "Return to input"), null)
                .create()
        recoveryParent = parent
        dialog = alert
        alert.setCanceledOnTouchOutside(false)
        alert.setOnDismissListener {
            if (dialog === alert) dialog = if (!closed && parent?.isShowing == true) parent else null
            recoveryParent = null
        }

        fun display(report: JSONObject) {
            token = report.optJSONObject("decision")?.optString("token")
            retryable = report.optJSONObject("decision")?.optBoolean("retryable") == true
            val state = report.optString("state")
            resolved = state == "clean"
            status.text =
                when (state) {
                    "clean" -> {
                        tr(
                            "结果已核对，无待处理编辑。原窗口输入仍保留；可返回，或明确关闭原输入并刷新。",
                            "Outcome resolved; no retained edits. Original form input is still retained. Return, or explicitly close that input and refresh.",
                        )
                    }

                    "decision_required" -> {
                        val paths = report.optJSONArray("unsavedPaths") ?: JSONArray()
                        val failed = report.optJSONArray("failedCommits") ?: JSONArray()
                        tr("结果已核对。未保存路径数：", "Outcome resolved. Unsaved paths: ") + paths.length() +
                            tr("；失败提交数：", "; failed commits: ") + failed.length() +
                            tr(
                                "。已明确拒绝的提交不会自行重试。重新应用使用当前设置；不重放服务商/密钥/授权快照。结构编辑可能需要重新输入。丢弃仅删除已知内存草稿，不取消已接受的提交。",
                                ". Known rejected commits are not retried automatically. Reapply uses current settings, not provider/key/consent snapshots. Structural edits may require re-entry. Discard drops known in-memory drafts only; it cannot cancel accepted work.",
                            )
                    }

                    "unresolved" -> {
                        tr(
                            "提交结果未知（无回执不等于未保存）。只能再次核对，不能重发或丢弃；已接受的操作不会被取消。",
                            "Commit outcome unknown (no receipt does not mean unsaved). Inspect again only; no retry or discard, and accepted work is not cancelled.",
                        )
                    }

                    else -> {
                        tr(
                            "暂时无法核对，输入仍保留。恢复查询可用后再次核对；不能推断提交失败。",
                            "Inspection unavailable; input retained. Inspect again when available; do not assume rejection.",
                        )
                    }
                }
        }

        fun inspect() {
            token = null
            resolved = false
            perform("settingsRecoveryInspect", JSONObject(), { display(it) }, {
                status.text = tr("核对未完成；输入保留，请稍后再核对。", "Inspection incomplete; input retained. Inspect again later.")
            })
        }

        fun decide(choice: String) {
            val selected = token
            if (selected == null || (choice == "retry" && !retryable)) {
                status.text = tr("请先重新核对；结构编辑须丢弃后重新输入。", "Inspect first; unsupported structural edits require discard and re-entry.")
                return
            }
            token = null
            resolved = false
            perform("settingsRecoveryDecide", JSONObject().put("token", selected).put("choice", choice).put("confirm", true), {
                display(it)
            }, {
                status.text =
                    tr(
                        "决定未完成或设置已变化。草稿保留，请重新核对后再选择；不能将关闭视为取消。",
                        "Decision incomplete or settings changed. Drafts retained; inspect again before choosing. Closing is not cancellation.",
                    )
            })
        }
        form.addView(status)
        form.addView(button(tr("仅重新核对", "Inspect only")) { inspect() })
        form.addView(button(tr("明确重新应用保留编辑", "Explicitly reapply retained edits")) { decide("retry") })
        form.addView(button(tr("明确丢弃已知内存草稿", "Explicitly discard known in-memory drafts")) { decide("discard") })
        form.addView(
            button(tr("完成并刷新（关闭原输入）", "Finish and refresh (close original input)")) {
                if (resolved) {
                    alert.dismiss()
                    parent?.dismiss()
                    changed()
                }
            },
        )
        alert.show()
        inspect()
    }

    private fun edit(
        rule: JSONObject,
        before: Any,
    ) {
        val path = rule.getJSONArray("path")
        val label = rule.getString(if (english) "labelEn" else "label")
        val form = column()
        val error = text("")
        val input =
            EditText(activity).apply {
                setTextColor(ink)
                setText(before.toString())
                isSingleLine = true
                inputType =
                    when {
                        rule.optBoolean("secret") -> {
                            InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
                        }

                        rule.getString("kind") == "number" -> {
                            InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_FLAG_DECIMAL or
                                InputType.TYPE_NUMBER_FLAG_SIGNED
                        }

                        else -> {
                            InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
                        }
                    }
            }
        form.addView(input)
        form.addView(error)
        if (path.length() == 1 && path.getString(0) == "aiModel") {
            val models = provider()?.optJSONArray("models") ?: JSONArray()
            if (models.length() > 0) {
                form.addView(
                    button(tr("选择预设模型", "Choose preset model")) {
                        AlertDialog
                            .Builder(activity)
                            .setTitle(tr("预设模型", "Preset model"))
                            .setItems(
                                Array(models.length()) {
                                    models.getJSONObject(it).getString("label")
                                },
                            ) { _, index -> input.setText(models.getJSONObject(index).getString("id")) }
                            .show()
                    },
                )
            }
        }
        val options = if (rule.getString("kind") == "boolean") JSONArray().put(false).put(true) else rule.optJSONArray("options")
        if (options != null) {
            input.isEnabled = false
            form.addView(
                button(tr("选择值", "Choose value")) {
                    AlertDialog
                        .Builder(activity)
                        .setTitle(label)
                        .setItems(
                            Array(options.length()) {
                                options.get(it).toString()
                            },
                        ) { _, index -> input.setText(options.get(index).toString()) }
                        .show()
                },
            )
        }
        modal(label, ScrollView(activity).apply { addView(form) }) { alert ->
            val raw = input.text.toString()
            val value: Any =
                when (rule.getString("kind")) {
                    "boolean" -> {
                        raw == "true"
                    }

                    "enum" -> {
                        (0 until (options?.length() ?: 0)).map { options!!.get(it) }.firstOrNull { it.toString() == raw }
                            ?: run {
                                error.text = "invalid_setting_value"
                                return@modal
                            }
                    }

                    "number" -> {
                        val number = raw.toDoubleOrNull()
                        if (number == null || !number.isFinite() || number < rule.getDouble("min") || number > rule.getDouble("max") ||
                            (rule.optBoolean("integer") && number != kotlin.math.floor(number))
                        ) {
                            error.text = "invalid_setting_value"
                            return@modal
                        }
                        if (rule.optBoolean("integer")) number.toLong() else number
                    }

                    else -> {
                        raw
                    }
                }
            val patch =
                JSONObject()
                    .put(
                        "path",
                        path,
                    ).put(
                        "before",
                        JSONObject().put("present", true).put("value", before),
                    ).put("after", JSONObject().put("present", true).put("value", value))
            perform("settingsPatch", JSONObject().put("patches", JSONArray().put(patch)), {
                alert.dismiss()
                changed()
            }, { code ->
                error.text =
                    code
            })
        }
    }

    private fun libraryDisplay() {
        perform("librarySessionGet", JSONObject(), { result ->
            var selected = result.getJSONObject("session").getInt("pageSize")
            val form = column()
            val error = text("")
            form.addView(text(tr("现有每页数量：", "Current page size: ") + selected))
            val choices = android.widget.RadioGroup(activity)
            for (size in listOf(12, 24)) {
                choices.addView(
                    android.widget.RadioButton(activity).apply {
                        id = size
                        text = size.toString()
                        setTextColor(ink)
                    },
                )
            }
            if (selected in listOf(12, 24)) choices.check(selected)
            choices.setOnCheckedChangeListener { _, value -> selected = value }
            form.addView(choices)
            form.addView(error)
            modal(tr("藏书显示", "Library display"), form) { alert ->
                if (selected !in listOf(12, 24)) {
                    error.text = "invalid_setting_value"
                    return@modal
                }
                perform(
                    "librarySessionSave",
                    JSONObject().put(
                        "session",
                        JSONObject()
                            .put(
                                "pageSize",
                                selected,
                            ).put("page", 1)
                            .put("orderedBookIds", JSONArray())
                            .put("returnedFromReader", false),
                    ),
                    {
                        alert.dismiss()
                        changed()
                    },
                    { error.text = it },
                )
            }
        }, { code -> modal(tr("显示设置未完成", "Display setting unavailable"), text(code)) { it.dismiss() } })
    }

    private fun selectProvider() {
        val form = column()
        val error = text("")
        var selected =
            (0 until providers.length()).firstOrNull { providers.getJSONObject(it).getString("id") == preferences.optString("aiProvider") }
                ?: -1
        val choices = android.widget.RadioGroup(activity)
        for (i in 0 until providers.length()) {
            choices.addView(
                android.widget.RadioButton(activity).apply {
                    id = i + 1
                    text =
                        providers.getJSONObject(i).getString("label")
                    setTextColor(ink)
                },
            )
        }
        if (selected >= 0) choices.check(selected + 1)
        choices.setOnCheckedChangeListener { _, id -> selected = id - 1 }
        form.addView(choices)
        form.addView(error)
        modal(tr("切换 AI 服务", "Switch AI provider"), form) { alert ->
            if (selected !in 0 until providers.length()) {
                error.text = "invalid_provider"
                return@modal
            }
            perform("selectAiProvider", JSONObject().put("provider", providers.getJSONObject(selected).getString("id")), {
                alert.dismiss()
                changed()
            }, { code ->
                error.text =
                    code
            })
        }
    }

    private fun confirmMutation(
        action: String,
        explanation: String,
    ) {
        val form = column()
        val error = text("")
        form.addView(text(explanation))
        form.addView(error)
        modal(tr("确认", "Confirm"), form) { alert ->
            perform(action, JSONObject().put("confirm", true), {
                alert.dismiss()
                changed()
            }, {
                error.text =
                    it
            })
        }
    }

    private fun calibration() {
        val form = column()
        val error = text("")
        val input =
            EditText(activity).apply {
                setTextColor(ink)
                hint =
                    tr("实测毫米数", "Measured millimetres")
                inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_FLAG_DECIMAL
            }
        val instruction =
            text(
                tr(
                    "用实体尺量下方横线的实际长度（毫米），不要使用系统报告的 DPI。",
                    "Measure the line below with a physical ruler in millimetres; do not use reported DPI.",
                ),
            )
        form.addView(instruction)
        form.addView(input)
        form.addView(error)
        perform("settingsCalibrationInfo", JSONObject(), { info ->
            val dpr = info.getDouble("dpr")
            form.addView(text(tr("校准状态：", "Calibration status: ") + info.getString("status")))
            val ruler = Ruler(dpr) { input.setText("") }
            form.addView(ruler, 1, LinearLayout.LayoutParams(-1, dp(72)))
            modal(tr("物理显示校准", "Physical display calibration"), form) { alert ->
                val mm = input.text.toString().toDoubleOrNull()
                if (mm == null || !mm.isFinite() || mm < 5 || mm > 300 ||
                    ruler.cssWidth < 40
                ) {
                    error.text = "invalid_ruler_measurement"
                    return@modal
                }
                perform(
                    "settingsCalibrationCommit",
                    JSONObject()
                        .put(
                            "token",
                            info.getString("token"),
                        ).put("widthCss", ruler.cssWidth)
                        .put("measuredMm", mm),
                    {
                        alert.dismiss()
                        changed()
                    },
                    {
                        error.text =
                            it
                    },
                )
            }
        }, { code ->
            form.addView(text(code))
            modal(tr("校准不可用", "Calibration unavailable"), form) { it.dismiss() }
        })
    }

    private inner class Ruler(
        private val dpr: Double,
        private val resized: () -> Unit,
    ) : View(activity) {
        private val paint =
            Paint(Paint.ANTI_ALIAS_FLAG).apply {
                color = ink
                strokeWidth = dp(2).toFloat().coerceAtLeast(1f)
            }
        var cssWidth = 0.0
            private set

        override fun onSizeChanged(
            w: Int,
            h: Int,
            oldw: Int,
            oldh: Int,
        ) {
            super.onSizeChanged(w, h, oldw, oldh)
            cssWidth =
                ((w - dp(24)).coerceAtLeast(0).toDouble() / dpr).coerceAtMost(1000.0)
            if (w != oldw) resized()
        }

        override fun onDraw(canvas: Canvas) {
            super.onDraw(canvas)
            val x = dp(12).toFloat()
            val y =
                height / 2f
            val end =
                x + (cssWidth * dpr).toFloat()
            canvas.drawLine(x, y, end, y, paint)
            canvas.drawLine(x, y - dp(10), x, y + dp(10), paint)
            canvas.drawLine(
                end,
                y - dp(10),
                end,
                y + dp(10),
                paint,
            )
        }
    }

    private fun probe(action: String) {
        val form = column()
        val status = text(tr("连接测试会访问当前配置的服务，不发送书籍或笔记内容。", "This test contacts the configured service without book or note content."))
        form.addView(status)
        modal(tr("连接测试", "Connection test"), form) { alert ->
            perform(action, JSONObject().put("confirm", true), { result ->
                status.text =
                    tr("连接成功：", "Connected: ") + result.getLong("elapsedMs") + " ms"
                ; alert.getButton(AlertDialog.BUTTON_POSITIVE).isEnabled =
                    false
            }, { status.text = it })
        }
    }

    private fun openLink(
        url: String,
        error: TextView,
    ) {
        val uri = Uri.parse(url)
        if (uri.scheme != "https" || uri.host.isNullOrEmpty()) return
        try {
            activity.startActivity(Intent(Intent.ACTION_VIEW, uri))
        } catch (
            _: android.content.ActivityNotFoundException,
        ) {
            error.text = tr("无法打开链接", "Cannot open link")
        }
    }

    fun canLeave() = !busy

    fun isEditing() = busy || dialog?.isShowing == true

    fun handleBack(): Boolean {
        if (busy) return true
        val current = dialog ?: return false
        current.dismiss()
        return true
    }

    fun close() {
        closed = true
        val parent = recoveryParent
        dialog?.dismiss()
        parent?.dismiss()
        recoveryParent = null
        dialog = null // An accepted mutation continues in its existing owner.
    }
}
