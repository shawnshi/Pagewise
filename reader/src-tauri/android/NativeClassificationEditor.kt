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
) {
    private var context = JSONObject(initial.toString())
    private var closed = false
    private var busy = false
    private var dialog: AlertDialog? = null
    private val form =
        LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(24, 12, 24, 12)
        }
    private val category = Spinner(activity)
    private val categoryLock = CheckBox(activity).apply { text = "锁定类别" }
    private val topics =
        EditText(activity).apply {
            hint = "主题（每行一个）"
            minLines = 3
            inputType =
                InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE
        }
    private val feature =
        EditText(activity).apply {
            hint = "特征（可留空）"
            isSingleLine = true
        }
    private val featureLock = CheckBox(activity).apply { text = "锁定特征" }
    private val lockedChanges = CheckBox(activity).apply { text = "明确允许修改/移除现有锁定项" }
    private val topicLocks = mutableMapOf<String, CheckBox>()
    private val state = TextView(activity)
    private var categories = JSONArray()

    fun show(autoGenerate: Boolean = false): AlertDialog {
        form.addView(
            TextView(activity).apply {
                text = "类别、主题、特征分别编辑。生成只填草稿；保存才写入书库。"
                textSize = 16f
            },
        )
        form.addView(category)
        form.addView(categoryLock)
        form.addView(topics)
        form.addView(feature)
        form.addView(featureLock)
        form.addView(lockedChanges)
        form.addView(state)
        populate()
        val window =
            AlertDialog
                .Builder(activity)
                .setTitle("分类与标签")
                .setView(ScrollView(activity).apply { addView(form) })
                .setPositiveButton("保存", null)
                .setNeutralButton("AI 补全草稿", null)
                .setNegativeButton("关闭", null)
                .create()
        dialog = window
        window.setOnDismissListener { closed = true }
        window.setOnShowListener {
            window.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener { save() }
            window.getButton(AlertDialog.BUTTON_NEUTRAL).setOnClickListener { generate() }
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
        category.adapter = ArrayAdapter(activity, android.R.layout.simple_spinner_dropdown_item, labels)
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
        topicLocks.values.forEach { form.removeView(it) }
        topicLocks.clear()
        for (i in 0 until tags.length()) {
            val tag = tags.getJSONObject(i)
            val value = tag.getString("value")
            val control =
                CheckBox(activity).apply {
                    text = "锁定主题：$value"
                    isChecked = tag.getBoolean("locked")
                }
            topicLocks[value] = control
            form.addView(control)
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
