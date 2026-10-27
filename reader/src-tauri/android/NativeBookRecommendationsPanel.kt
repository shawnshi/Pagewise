package io.pagewise.reader

import android.app.Activity
import android.graphics.Typeface
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.CheckBox
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** Native management-page UI; ranking, feedback and guarded status changes stay in shared actions. */
internal class NativeBookRecommendationsPanel(
    private val activity: Activity,
    private val ink: Int,
    private val surface: Int,
    private val english: Boolean,
    private val mode: String,
    private val referenceId: String?,
    private val request: (String, JSONObject, NativePageReply) -> Unit,
    private val current: () -> Boolean,
    private val navigate: (String) -> Unit,
    private val cover: (ImageView, String) -> Unit,
    private val summary: (Int?) -> Unit = {},
) {
    private val root = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }
    private var result: JSONObject? = null
    private var epoch = 0
    private var aiEpoch = 0
    private var closed = false
    private var loading = false
    private var aiBusy = false
    private var writing = false
    private var unknown = false
    private var readFailed = false
    private var onlyNotStarted = false
    private var confirmClear = false
    private var canAddWanted = false
    private var getRequest = ""
    private var aiRequest = ""
    private var error = ""
    private var notice = ""
    private val controls = mutableListOf<Pair<Button, Boolean>>()
    private val preferenceControls = mutableSetOf<Button>()

    private fun tr(
        zh: String,
        en: String,
    ) = if (english) en else zh

    private fun live() = !closed && current() && !activity.isFinishing && !activity.isDestroyed

    private fun text(
        value: String,
        size: Float = 14f,
        bold: Boolean = false,
    ) = TextView(activity).apply {
        text = value
        textSize = size
        setTextColor(ink)
        setPadding(0, NativeUi.dp(activity, 7), 0, NativeUi.dp(activity, 7))
        if (bold) setTypeface(null, Typeface.BOLD)
        setLineSpacing(NativeUi.dp(activity, 2).toFloat(), 1.06f)
    }

    private fun button(
        zh: String,
        en: String,
        mutating: Boolean = false,
        action: () -> Unit,
    ): Button =
        NativeUi.button(activity, tr(zh, en), ink, surface, action).also {
            controls.add(it to mutating)
        }

    private fun actions(
        parent: LinearLayout,
        vararg buttons: Button,
    ) {
        parent.addView(NativeActionFlow(activity).apply { buttons.forEach { addView(it) } })
    }

    private fun allCards(): List<JSONObject> =
        listOf("related", "extended").flatMap { key ->
            val rows =
                result?.optJSONArray(key) ?: JSONArray()
            (0 until rows.length()).map { rows.getJSONObject(it) }
        }

    fun canLeave() = !writing

    fun handleBack(): Boolean {
        if (writing) {
            notice = tr("提交处理中，请等待结果。", "Saving. Wait for the result.")
            paint()
            return true
        }
        if (confirmClear) {
            confirmClear = false
            paint()
            return true
        }
        return false
    }

    fun render(): View {
        load(false)
        return root
    }

    fun close() {
        if (closed) return
        closed = true
        epoch++
        aiEpoch++
        cancel(true)
    }

    private fun cancel(discard: Boolean) {
        val token = result?.optString("token").orEmpty()
        for (id in listOf(getRequest, aiRequest).filter {
            it.isNotEmpty()
        }) {
            request(
                "action.recommendationsCancel",
                JSONObject().put("requestId", id).put("discardContext", discard).apply {
                    if (token.isNotEmpty()) put("token", token)
                },
            ) { _, _ -> }
        }
        if (discard && token.isNotEmpty() && getRequest.isEmpty() &&
            aiRequest.isEmpty()
        ) {
            request("action.recommendationsCancel", JSONObject().put("token", token).put("discardContext", true)) { _, _ -> }
        }
        getRequest = ""
        aiRequest = ""
    }

    private fun load(refresh: Boolean) {
        if (!live() || writing) return
        cancel(true)
        val owner = ++epoch
        aiEpoch++
        loading = true
        aiBusy = false
        readFailed = true
        error = ""
        notice = ""
        confirmClear = false
        summary(null)
        paint()
        getRequest = UUID.randomUUID().toString()
        val payload =
            JSONObject()
                .put(
                    "mode",
                    mode,
                ).put(
                    "referenceId",
                    referenceId ?: JSONObject.NULL,
                ).put(
                    "language",
                    if (english) "en" else "zh",
                ).put("onlyNotStarted", onlyNotStarted)
                .put("requestId", getRequest)
                .put("refresh", refresh)
        request("action.recommendationsGet", payload) { reply, failure ->
            activity.runOnUiThread {
                if (!live() ||
                    owner != epoch
                ) {
                    reply?.optJSONObject("result")?.optString("token")?.takeIf { it.isNotEmpty() }?.let { token ->
                        request("action.recommendationsCancel", JSONObject().put("token", token).put("discardContext", true)) { _, _ -> }
                    }
                    return@runOnUiThread
                }
                loading = false
                getRequest = ""
                try {
                    if (failure != null ||
                        reply?.optBoolean("ok") != true
                    ) {
                        error = message(failure ?: reply?.optString("code").orEmpty())
                        paint()
                        return@runOnUiThread
                    }
                    val next = reply.getJSONObject("result")
                    validate(next)
                    result = next
                    readFailed = false
                    canAddWanted = reply.optBoolean("canAddWanted")
                    summary(allCards().size)
                    paint()
                } catch (_: org.json.JSONException) {
                    error = message("invalid_response")
                    paint()
                }
            }
        }
    }

    private fun explain() {
        if (!live() || loading || writing || aiBusy || unknown || readFailed || result == null || allCards().isEmpty()) return
        val owner = epoch
        val generation = ++aiEpoch
        aiRequest = UUID.randomUUID().toString()
        aiBusy = true
        error = ""
        paint()
        request(
            "action.recommendationsAi",
            JSONObject().put("token", result!!.getString("token")).put("requestId", aiRequest).put("allowMetadata", true),
        ) { reply, failure ->
            activity.runOnUiThread {
                if (!live() || owner != epoch || generation != aiEpoch) return@runOnUiThread
                aiBusy = false
                aiRequest = ""
                try {
                    if (failure != null ||
                        reply?.optBoolean("ok") != true
                    ) {
                        error = message(failure ?: reply?.optString("code").orEmpty())
                        paint()
                        return@runOnUiThread
                    }
                    val next = reply.getJSONObject("result")
                    if (next.getString("token") != result?.getString("token")) return@runOnUiThread
                    val updates =
                        listOf("related", "extended").flatMap { key ->
                            val rows = next.getJSONArray(key)
                            (0 until rows.length()).map { rows.getJSONObject(it) }
                        }
                    for (card in allCards()) {
                        updates
                            .find {
                                it.getJSONObject("book").getString("id") == card.getJSONObject("book").getString("id") &&
                                    it.getString("sourceId") == card.getString("sourceId")
                            }?.let { card.put("reason", it.getString("reason")).put("reasonKind", "ai") }
                    }
                    notice =
                        tr(
                            "AI 理由未经事实核验；入选资格仍由本地规则限定。",
                            "AI reasons are not fact-checked. Candidate eligibility remains locally constrained.",
                        )
                    paint()
                } catch (_: org.json.JSONException) {
                    error = message("invalid_ai_output")
                    paint()
                }
            }
        }
    }

    private fun mutate(
        kind: String,
        card: JSONObject,
    ) {
        if (!live() || loading || writing || aiBusy || unknown || readFailed) return
        val owner = epoch
        writing = true
        error = ""
        paint()
        val id = card.getJSONObject("book").getString("id")
        val payload =
            JSONObject()
                .put(
                    "token",
                    result!!.getString("token"),
                ).put("candidateId", id)
                .put("requestId", UUID.randomUUID().toString())
        if (kind != "wanted") payload.put("kind", kind)
        request(
            if (kind ==
                "wanted"
            ) {
                "action.recommendationsWanted"
            } else {
                "action.recommendationsFeedback"
            },
            payload,
        ) { reply, failure ->
            activity.runOnUiThread {
                if (!live() || owner != epoch) return@runOnUiThread
                writing = false
                if (failure != null ||
                    reply?.optBoolean("ok") != true
                ) {
                    val code =
                        if (failure !=
                            null
                        ) {
                            "commit_outcome_unknown"
                        } else {
                            reply?.optString("code").orEmpty()
                        }
                    ;unknown = code == "commit_outcome_unknown"
                    error =
                        message(code)
                    paint()
                    return@runOnUiThread
                }
                if (kind ==
                    "wanted"
                ) {
                    card.getJSONObject("book").put("readingStatus", "wanted")
                    notice =
                        tr("已加入想读，进度未变。", "Added to Want to read. Progress unchanged.")
                    paint()
                } else {
                    load(true)
                }
            }
        }
    }

    private fun clearFeedback() {
        if (!live() || loading || writing || aiBusy || unknown || !confirmClear) return
        val owner = epoch
        writing = true
        error = ""
        paint()
        request(
            "action.recommendationsClearFeedback",
            JSONObject().put("confirmClear", true).put("requestId", UUID.randomUUID().toString()),
        ) { reply, failure ->
            activity.runOnUiThread {
                if (!live() || owner != epoch) return@runOnUiThread
                writing = false
                if (failure != null ||
                    reply?.optBoolean("ok") != true
                ) {
                    val code =
                        if (failure !=
                            null
                        ) {
                            "commit_outcome_unknown"
                        } else {
                            reply?.optString("code").orEmpty()
                        }
                    ;unknown = code == "commit_outcome_unknown"
                    error =
                        message(code)
                    paint()
                } else {
                    load(true)
                }
            }
        }
    }

    private fun paint() {
        if (!live()) return
        controls.clear()
        preferenceControls.clear()
        root.removeAllViews()
        val filter =
            CheckBox(activity).apply {
                text = tr("仅看未开始（无应用内阅读记录）", "Not started only (no app reading records)")
                setTextColor(ink)
                buttonTintList =
                    android.content.res.ColorStateList
                        .valueOf(ink)
                minimumHeight = NativeUi.dp(activity, 48)
                isChecked = onlyNotStarted
                isEnabled = !loading && !writing && !aiBusy
                setOnCheckedChangeListener { _, checked ->
                    if (!loading && !writing && !aiBusy) {
                        onlyNotStarted = checked
                        load(true)
                    }
                }
            }
        ;root.addView(filter)
        actions(
            root,
            button("刷新推荐", "Refresh recommendations") { load(true) },
            button("清空推荐负反馈", "Clear recommendation feedback", true) {
                confirmClear =
                    !confirmClear
                ;paint()
            }.also { preferenceControls.add(it) },
        )
        if (confirmClear) {
            root.addView(text(tr("只清空推荐负反馈，不修改书籍、进度或其他设置。", "Clears only recommendation feedback, not books, progress or other settings.")))
            actions(
                root,
                button("确认清空", "Confirm clear", true) { clearFeedback() }.also { preferenceControls.add(it) },
                button("取消", "Cancel") {
                    confirmClear =
                        false
                    ;paint()
                },
            )
        }
        if (loading) root.addView(text(tr("正在读取馆藏元数据并计算本地推荐…", "Reading metadata and computing local recommendations…")))
        if (error.isNotEmpty()) root.addView(text(error).apply { accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE })
        if (notice.isNotEmpty()) root.addView(text(notice).apply { accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE })
        val data = result
        if (data != null && !loading) {
            if (readFailed) {
                root.addView(
                    text(tr("以下为上次结果；刷新失败，操作已停用。", "Previous results below; refresh failed and mutations are disabled.")),
                )
            }
            val basis =
                when (data.optString("seedKind")) {
                    "recent-reading" -> tr("根据最近有阅读记录的书目", "Based on the latest recorded reading")
                    "marked-reading" -> tr("根据标记在读的书目", "Based on books marked Reading")
                    "recent-added" -> tr("缺少阅读上下文，按最近入库书目探索", "No reading context; exploring from recently added books")
                    else -> tr("参考当前书目", "Using the current book as reference")
                }
            val sources =
                data.optJSONArray("sources") ?: JSONArray()
            root.addView(
                text(basis + ": " + (0 until sources.length()).joinToString(" · ") { sources.getJSONObject(it).getString("title") }),
            )
            for (key in listOf("related", "extended")) {
                val rows = data.getJSONArray(key)
                root.addView(
                    text(
                        (if (key == "related") tr("相关阅读", "Related reading") else tr("拓展阅读", "Extended reading")) + " (${rows.length()})",
                        17f,
                        true,
                    ).apply {
                        typeface = NativeUi.editorialTypeface(true)
                    },
                )
                if (rows.length() ==
                    0
                ) {
                    root.addView(
                        text(
                            tr(
                                "没有足够可靠的馆藏关联，不以弱相关条目凑数。完善分类、主题或简介后可刷新。",
                                "No sufficiently grounded library matches; no weak filler. Add categories, topics or descriptions and refresh.",
                            ),
                        ),
                    )
                }
                for (i in 0 until rows.length())root.addView(card(rows.getJSONObject(i)))
            }
            if (allCards().isNotEmpty()) {
                root.addView(
                    text(
                        tr(
                            "本地词项向量与规则不上传数据。AI 操作会向当前服务发送本次参考书与候选的题名、作者、分类、主题及简介摘要，不发送阅读轨迹、正文或笔记。理由未经事实核验。",
                            "Local lexical vectors and rules upload nothing. AI sends only this set's titles, authors, categories, topics and description excerpts, never reading history, book text or notes. Reasons are unverified.",
                        ),
                    ),
                )
                if (aiBusy) {
                    actions(
                        root,
                        button("取消 AI 请求", "Cancel AI request") {
                            request(
                                "action.recommendationsCancel",
                                JSONObject().put("requestId", aiRequest).put("token", data.getString("token")).put("discardContext", false),
                            ) { _, _ -> }
                            aiRequest =
                                ""
                            aiEpoch++
                            aiBusy = false
                            notice = message("cancelled")
                            paint()
                        },
                    )
                } else {
                    actions(root, button("发送书目摘要生成 AI 理由", "Send book summaries for AI reasons", true) { explain() })
                }
            }
        }
        for ((view, mutating)in controls) {
            view.isEnabled =
                !writing && (!loading && !aiBusy || view.text.toString() == tr("取消 AI 请求", "Cancel AI request")) &&
                (!mutating || !unknown && (!readFailed || view in preferenceControls))
        }
    }

    private fun card(card: JSONObject): View {
        val book = card.getJSONObject("book")
        val id = book.getString("id")
        val panel = NativeUi.card(activity, surface, 14)
        val identity = LinearLayout(activity).apply { orientation = LinearLayout.HORIZONTAL }
        if (book.optBoolean("hasCover")) {
            val coverFrame =
                android.widget.FrameLayout(activity).apply {
                    background =
                        NativeUi.shape(activity, surface).apply {
                            setColor(NativeUi.mutedSurface(surface))
                        }
                    setPadding(NativeUi.dp(activity, 3), NativeUi.dp(activity, 3), NativeUi.dp(activity, 3), NativeUi.dp(activity, 3))
                }
            coverFrame.addView(
                ImageView(activity).apply {
                    scaleType = ImageView.ScaleType.CENTER_CROP
                    importantForAccessibility =
                        View.IMPORTANT_FOR_ACCESSIBILITY_NO
                    cover(this, id)
                },
                android.widget.FrameLayout.LayoutParams(-1, -1),
            )
            identity.addView(
                coverFrame,
                LinearLayout.LayoutParams(NativeUi.dp(activity, 58), NativeUi.dp(activity, 78)).apply {
                    marginEnd =
                        NativeUi.dp(activity, 12)
                },
            )
        }
        val info = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }
        val titleAndAuthor =
            LinearLayout(activity).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = android.view.Gravity.CENTER_VERTICAL
            }
        titleAndAuthor.addView(
            text(book.getString("title"), 16f, true).apply {
                typeface = NativeUi.editorialTypeface(true)
                setTextIsSelectable(true)
            },
        )
        val authorText = book.optString("author").ifBlank { tr("未知作者", "Unknown author") }
        titleAndAuthor.addView(
            text(" · $authorText", 13f).apply {
                setTextColor(NativeUi.secondary(surface))
                setTextIsSelectable(true)
            },
        )
        info.addView(titleAndAuthor)
        val state =
            when (book.optString("readingStatus")) {
                "wanted" -> tr("想读", "Want to read")
                "reading" -> tr("在读", "Reading")
                "finished" -> tr("已读", "Finished")
                "paused" -> tr("暂缓", "Paused")
                "abandoned" -> tr("弃读", "Abandoned")
                "unmarked" -> tr("未标记", "Unmarked")
                else -> tr("状态未知", "Status unknown")
            }
        val progress = book.optDouble("progress", Double.NaN)
        info.addView(text(state + (if (progress.isFinite() && progress in 0.0..1.0) " · ${(progress * 100).toInt()}%" else "")))
        if (card.optInt("recordCount") >
            1
        ) {
            info.addView(text(tr("同题名／明确分卷记录", "Same-title / explicitly numbered records") + ": " + card.optInt("recordCount")))
        }
        identity.addView(info, LinearLayout.LayoutParams(0, -2, 1f))
        panel.addView(identity)
        panel.addView(
            text(tr("来源", "From") + ": 《" + card.getString("sourceTitle") + "》").apply {
                textSize = 13f
                setTextColor(NativeUi.secondary(surface))
            },
        )
        val aiSuffix =
            if (card.optString("reasonKind") == "ai") {
                tr("〔AI，未核验〕", " [AI, unverified]")
            } else {
                ""
            }
        panel.addView(
            text(tr("推荐理由", "Recommendation reason") + ": " + card.getString("reason") + aiSuffix).apply {
                textSize = 13f
                setTextIsSelectable(true)
            },
        )
        val wanted =
            button(
                if (book.optString("readingStatus") ==
                    "wanted"
                ) {
                    "已在想读"
                } else {
                    "加入想读"
                },
                if (book.optString("readingStatus") ==
                    "wanted"
                ) {
                    "Already wanted"
                } else {
                    "Want to read"
                },
                true,
            ) { mutate("wanted", card) }
        if (book.optString("readingStatus") == "wanted" || !canAddWanted) wanted.visibility = View.GONE
        actions(
            panel,
            button("查看详情", "View details") {
                if (!writing) navigate(id)
            },
            wanted,
            button("不感兴趣", "Not interested", true) {
                mutate("not-interested", card)
            },
            button("关联不符", "Not related", true) { mutate("unrelated", card) },
        )
        return panel
    }

    private fun validate(data: JSONObject) {
        if (data.getString("mode") != mode ||
            data.optString("referenceId").let { if (it == "null" || it.isEmpty()) null else it } != referenceId ||
            data.getString("token").isBlank() ||
            data.getString("token").length > 128
        ) {
            throw org.json.JSONException("Invalid recommendation context")
        }
        val sources = data.getJSONArray("sources")
        if (sources.length() > 5) throw org.json.JSONException("Invalid sources")
        val sourceIds = (0 until sources.length()).map { sources.getJSONObject(it).getString("id") }.toSet()
        val ids = mutableSetOf<String>()
        for (key in listOf("related", "extended")) {
            val items = data.getJSONArray(key)
            if (items.length() > 6) throw org.json.JSONException("Invalid count")
            for (i in 0 until items.length()) {
                val item = items.getJSONObject(i)
                val book = item.getJSONObject("book")
                val id = book.getString("id")
                if (id.isBlank() || id.length > 512 || !ids.add(id) || id in sourceIds || item.getString("sourceId") !in sourceIds ||
                    book.getString("title").isBlank() ||
                    item.getString("reason").length > 1000
                ) {
                    throw org.json.JSONException("Invalid candidate")
                }
            }
        }
    }

    private fun message(code: String): String =
        when (code) {
            "unconfigured" -> {
                tr("请先配置 AI；本地推荐仍可使用。", "Configure AI first. Local recommendations remain available.")
            }

            "book_conflict", "stale_recommendations" -> {
                tr(
                    "书目、状态或推荐上下文已变化，未覆盖；请刷新核对。",
                    "Book/status/context changed. Nothing overwritten; refresh to check.",
                )
            }

            "commit_outcome_unknown" -> {
                tr(
                    "提交结果未知，请到详情或设置核对，不要重复本次提交。",
                    "Save outcome unknown. Check details/settings; do not replay this request.",
                )
            }

            "settings_recovery_required", "settings_unavailable" -> {
                tr(
                    "设置有未提交或失败项，请先在设置中处理。",
                    "Resolve pending or failed settings changes first.",
                )
            }

            "feedback_limit" -> {
                tr(
                    "推荐负反馈已达上限，可明确清空本功能偏好。",
                    "Recommendation feedback is at capacity; explicitly clear this feature's preferences if desired.",
                )
            }

            "feedback_corrupt" -> {
                tr(
                    "推荐偏好读取异常，未按空数据处理。可核对或明确清空本功能偏好。",
                    "Feedback could not be read; not treated as empty. Inspect or explicitly clear this feature's preferences.",
                )
            }

            "cancelled" -> {
                tr("AI 请求已取消，本地理由保留。", "AI cancelled. Local reasons retained.")
            }

            "timeout" -> {
                tr("AI 请求超时，本地理由保留。", "AI timed out. Local reasons retained.")
            }

            "invalid_ai_output" -> {
                tr("AI 理由未通过候选／锚点校验，本地理由保留。", "AI candidate/anchor validation failed. Local reasons retained.")
            }

            else -> {
                tr("推荐操作未完成。未把读取错误当作空书库。", "Recommendation processing failed; read errors are not an empty library.")
            }
        }
}
