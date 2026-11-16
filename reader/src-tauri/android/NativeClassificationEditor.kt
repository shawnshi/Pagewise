package io.pagewise.reader

import android.app.Activity
import android.app.AlertDialog
import android.text.InputType
import android.widget.ArrayAdapter
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Spinner
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject

/** Native role editor; the existing classification service owns provenance, lock gates and metadata/revision CAS. */
internal class NativeClassificationEditor(
    private val activity: Activity,
    initial: JSONObject,
    private val request: (String, JSONObject, NativePageReply) -> Unit,
    private val onSaved: () -> Unit,
    private val onError: (String) -> Unit,
    private val foreground: Int = android.graphics.Color.BLACK,
    private val background: Int = android.graphics.Color.WHITE,
) {
    private val fg = foreground
    private val bg = background
    private var context = JSONObject(initial.toString())
    private var closed = false
    private var busy = false
    private var dialog: AlertDialog? = null
    private val form =
        LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            val padH = NativeUi.dp(activity, 8)
            val padV = NativeUi.dp(activity, 6)
            setPadding(padH, padV, padH, padV)
        }
    private val topicLockHost = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }
    private val category = Spinner(activity).apply { minimumHeight = NativeUi.dp(activity, 48) }
    private val categoryLock = styledCheck("锁定类别")
    private val topics =
        EditText(activity).apply {
            hint = "主题（每行一个）"
            minLines = 3
            minimumHeight = NativeUi.dp(activity, 48)
            setTextColor(fg)
            setHintTextColor(NativeUi.disabled(bg))
            setBackground(NativeUi.shape(activity, bg))
            setPadding(NativeUi.dp(activity, 10), NativeUi.dp(activity, 8), NativeUi.dp(activity, 10), NativeUi.dp(activity, 8))
            inputType =
                InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE
        }
    private val feature =
        EditText(activity).apply {
            hint = "特征（可留空）"
            isSingleLine = true
            minimumHeight = NativeUi.dp(activity, 48)
            setTextColor(fg)
            setHintTextColor(NativeUi.disabled(bg))
            setBackground(NativeUi.shape(activity, bg))
            setPadding(NativeUi.dp(activity, 10), NativeUi.dp(activity, 8), NativeUi.dp(activity, 10), NativeUi.dp(activity, 8))
        }
    private val featureLock = styledCheck("锁定特征")
    private val lockedChanges = styledCheck("明确允许修改/移除现有锁定项")
    private val topicLocks = mutableMapOf<String, CheckBox>()
    private val state =
        TextView(activity).apply {
            textSize = 13f
            setTextColor(NativeUi.secondary(bg))
            setPadding(0, NativeUi.dp(activity, 8), 0, NativeUi.dp(activity, 4))
        }
    private var categories = JSONArray()

    private fun styledCheck(caption: String) =
        CheckBox(activity).apply {
            text = caption
            textSize = 14f
            minimumHeight = NativeUi.dp(activity, 48)
            setTextColor(fg)
            buttonTintList = android.content.res.ColorStateList.valueOf(fg)
        }

    fun show(autoGenerate: Boolean = false): AlertDialog {
        form.addView(
            TextView(activity).apply {
                text = "类别、主题、特征分别编辑。生成只填草稿；保存才写入书库。"
                textSize = 15f
                setTextColor(fg)
                setPadding(0, 0, 0, NativeUi.dp(activity, 8))
            },
        )
        form.addView(category)
        form.addView(categoryLock)
        form.addView(topics, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = NativeUi.dp(activity, 8) })
        form.addView(topicLockHost)
        form.addView(feature, LinearLayout.LayoutParams(-1, -2).apply { topMargin = NativeUi.dp(activity, 4) })
        form.addView(featureLock)
        form.addView(lockedChanges)
        form.addView(state)
        populate()
        val window =
            NativeEinkDialog(
                activity,
                "分类与标签",
                form,
                foreground,
                background,
                listOf(
                    AlertDialog.BUTTON_POSITIVE to "保存",
                    AlertDialog.BUTTON_NEUTRAL to "AI 补全草稿",
                    AlertDialog.BUTTON_NEGATIVE to "关闭",
                ),
                cancelableOutside = false,
                onDismissed = { closed = true },
            )
        dialog = window
        window.setOnShowListener {
            window.getButton(AlertDialog.BUTTON_POSITIVE)?.setOnClickListener { save() }
            window.getButton(AlertDialog.BUTTON_NEUTRAL)?.setOnClickListener { generate() }
            if (autoGenerate) generate()
        }
        window.show()
        return window
    }

    private fun populate() {
        val draft = context.getJSONObject("classification")
        categories = context.getJSONArray("categories")
        val labels = mutableListOf("不设置类别")
        for (i in 0 until categories.length()) labels.add(categories.getJSONObject(i).getString("label"))
        category.adapter =
            object : ArrayAdapter<String>(activity, android.R.layout.simple_spinner_dropdown_item, labels) {
                override fun getView(
                    position: Int,
                    convertView: android.view.View?,
                    parent: android.view.ViewGroup,
                ): android.view.View =
                    (super.getView(position, convertView, parent) as TextView).apply {
                        setTextColor(fg)
                        setBackgroundColor(NativeUi.surface(bg))
                        minimumHeight = NativeUi.dp(activity, 48)
                    }

                override fun getDropDownView(
                    position: Int,
                    convertView: android.view.View?,
                    parent: android.view.ViewGroup,
                ): android.view.View =
                    (super.getDropDownView(position, convertView, parent) as TextView).apply {
                        setTextColor(fg)
                        setBackgroundColor(NativeUi.surface(bg))
                        minimumHeight = NativeUi.dp(activity, 48)
                    }
            }
        val current = draft.optJSONObject("category")
        var selected = 0
        for (i in 0 until categories.length()) {
            if (categories.getJSONObject(i).getString("id") ==
                current?.optString("value")
            ) {
                selected = i + 1
            }
        }
        category.setSelection(selected)
        categoryLock.isChecked = current?.optBoolean("locked") == true
        val tags = draft.getJSONArray("topics")
        topics.setText((0 until tags.length()).joinToString("\n") { tags.getJSONObject(it).getString("value") })
        topicLockHost.removeAllViews()
        topicLocks.clear()
        for (i in 0 until tags.length()) {
            val tag = tags.getJSONObject(i)
            val value = tag.getString("value")
            val control =
                styledCheck("锁定主题：$value").apply {
                    isChecked = tag.getBoolean("locked")
                }
            topicLocks[value] = control
            topicLockHost.addView(control)
        }
        val single = draft.optJSONObject("feature")
        feature.setText(single?.optString("value").orEmpty())
        featureLock.isChecked = single?.optBoolean("locked") == true
        state.text = "${context.optString("code")} · 尚未保存"
    }

    private fun collect(): JSONObject {
        val draft = JSONObject(context.getJSONObject("classification").toString())

        fun selection(
            value: String,
            old: JSONObject?,
            locked: Boolean,
        ): JSONObject =
            if (old?.optString("value") == value) {
                JSONObject(old.toString()).put("locked", locked)
            } else {
                JSONObject().put("value", value).put("source", "manual").put("locked", locked)
            }
        if (category.selectedItemPosition == 0) {
            draft.put("category", JSONObject.NULL)
        } else {
            draft.put(
                "category",
                selection(
                    categories.getJSONObject(category.selectedItemPosition - 1).getString("id"),
                    draft.optJSONObject("category"),
                    categoryLock.isChecked,
                ),
            )
        }
        val previous = draft.getJSONArray("topics")
        val result = JSONArray()
        for (value in topics.text
            .toString()
            .split('\n')
            .map { it.trim() }
            .filter { it.isNotEmpty() }) {
            var old: JSONObject? = null
            for (i in 0 until previous.length()) if (previous.getJSONObject(i).getString("value") == value) old = previous.getJSONObject(i)
            result.put(selection(value, old, topicLocks[value]?.isChecked == true))
        }
        draft.put("topics", result)
        val value = feature.text.toString().trim()
        draft.put(
            "feature",
            if (value.isEmpty()) JSONObject.NULL else selection(value, draft.optJSONObject("feature"), featureLock.isChecked),
        )
        return draft
    }

    private fun execute(
        action: String,
        payload: JSONObject,
        success: (JSONObject) -> Unit,
    ) {
        if (busy || closed) return
        busy = true
        setEditable(false)
        state.text = "正在处理；关闭界面不表示已取消已发送的请求。"
        dialog?.getButton(AlertDialog.BUTTON_POSITIVE)?.isEnabled = false
        dialog?.getButton(AlertDialog.BUTTON_NEUTRAL)?.isEnabled = false
        request("action.$action", payload) { result, error ->
            activity.runOnUiThread {
                if (closed) return@runOnUiThread
                busy = false
                setEditable(true)
                dialog?.getButton(AlertDialog.BUTTON_POSITIVE)?.isEnabled = true
                dialog?.getButton(AlertDialog.BUTTON_NEUTRAL)?.isEnabled =
                    true
                if (error != null || result == null || result.optBoolean("ok", true).not()) {
                    state.text =
                        nativeClassificationFailureStatus(
                            action == "classificationSave",
                            result?.optString("outcome").orEmpty(),
                            result?.optString("code").orEmpty(),
                        )
                    onError(error ?: result?.optString("code") ?: "invalid_response")
                } else {
                    success(result)
                }
            }
        }
    }

    private fun setEditable(enabled: Boolean) {
        listOf(category, categoryLock, topics, feature, featureLock, lockedChanges).forEach { it.isEnabled = enabled }
        topicLocks.values.forEach { it.isEnabled = enabled }
    }

    private fun base() =
        JSONObject()
            .put(
                "bookId",
                context.getString("bookId"),
            ).put("sessionToken", context.getString("sessionToken"))
            .put("classification", collect())

    private fun generate() =
        execute("aiClassify", base().put("confirmLockedChanges", lockedChanges.isChecked)) {
            context = it
            populate()
        }

    private fun save() {
        execute("classificationSave", base().put("confirmSave", true).put("confirmLockedChanges", lockedChanges.isChecked)) {
            dialog?.dismiss()
            onSaved()
        }
    }
}
