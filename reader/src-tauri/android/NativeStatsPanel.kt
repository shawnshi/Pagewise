package io.pagewise.reader

import android.app.Activity
import android.app.AlertDialog
import android.app.DatePickerDialog
import android.graphics.Canvas
import android.graphics.Paint
import android.text.InputType
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject
import java.util.Calendar
import java.util.Locale

/** UI-only state, retained on reader/book return. Statistics and goals retain their existing canonical owners. */
internal class NativeStatsUiState {
    var view = "overview"
    val positions = mutableMapOf<String, Int>()
    var period = "month"
    var anchor = ""
    var kind = "all"
    var calendarMonth = ""
    var heatmapYear = "recent"
    var heatmapSlice = "auto"
    var from = ""
    var to = ""
    var offset = 0
    var bookOffset = 0

    fun changePeriod(
        value: String,
        day: String = anchor,
    ) {
        period = value
        anchor = day
        offset = 0
        bookOffset = 0
    }
}

internal class NativeStatsPanel(
    private val activity: Activity,
    private val request: (String, JSONObject, NativePageReply) -> Unit,
    private val navigate: (String) -> Unit,
    private val ink: Int,
    private val state: NativeStatsUiState,
    private val bars: (List<Pair<String, Double>>) -> View,
    private val repaint: () -> Unit,
    private val recoverSettings: () -> Unit,
    initialEnglish: Boolean = false,
) {
    private val ui =
        NativeStatsSettingsUi(
            activity,
            ink,
            if (ink ==
                android.graphics.Color.WHITE
            ) {
                android.graphics.Color.BLACK
            } else {
                android.graphics.Color.WHITE
            },
        )
    private val root = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }
    private var dayBody: LinearLayout? = null
    private var dayDialog: AlertDialog? = null
    private val status = text("")
    private var current = JSONObject()
    private var english = initialEnglish
    private var confirmed = false
    private val goalButtons = mutableListOf<View>()
    private var recoveryRow: NativeActionFlow? = null
    private val retryButton by lazy { button(tr("重试读取", "Retry loading")) { load() } }
    private var closed = false
    private var saving = false
    private var epoch = 0L
    private var dialog: AlertDialog? = null

    private fun tr(
        zh: String,
        en: String,
    ) = if (english) en else zh

    private fun dp(v: Int) = (v * activity.resources.displayMetrics.density).toInt()

    private fun text(
        value: String,
        size: Float = 16f,
    ) = ui.text(value, size)

    private fun button(
        value: String,
        action: () -> Unit,
    ) = ui.button(value) {
        if (!closed && !saving) action()
    }

    private fun duration(seconds: Double): String {
        val whole = seconds.toLong().coerceAtLeast(0)
        val minutes = whole / 60
        return if (whole < 60) {
            "$whole s"
        } else if (minutes >= 60) {
            "${minutes / 60} h ${minutes % 60} min"
        } else {
            "$minutes min"
        }
    }

    fun render(): View {
        closed = false
        root.addView(status)
        recoveryEntry()
        load()
        return root
    }

    private fun payload(
        selected: String? = null,
        dayBookOffset: Int = 0,
    ): JSONObject {
        val p =
            JSONObject()
                .put(
                    "period",
                    state.period,
                ).put("kind", state.kind)
                .put("offset", state.offset)
                .put("bookOffset", state.bookOffset)
                .put("limit", 20)
        p.put("heatmapYear", state.heatmapYear)
        if (state.anchor.isNotEmpty()) p.put("anchor", state.anchor)
        if (state.calendarMonth.isNotEmpty()) p.put("calendarMonth", state.calendarMonth)
        if (state.period == "range") p.put("from", state.from).put("to", state.to)
        if (selected != null) p.put("selectedDay", selected).put("dayBookOffset", dayBookOffset)
        return p
    }

    private fun load(
        selected: String? = null,
        dayBookOffset: Int = 0,
    ) {
        val token = ++epoch
        confirmed = false
        goalButtons.forEach { it.isEnabled = false }
        (retryButton.parent as? ViewGroup)?.removeView(retryButton)
        if (root.childCount == 0) root.addView(status)
        status.text = tr("正在读取已确认的阅读记录…", "Loading confirmed reading records…")
        request("action.statisticsGet", payload(selected, dayBookOffset)) { result, error ->
            activity.runOnUiThread {
                if (closed || token != epoch) return@runOnUiThread
                if (error != null || result == null ||
                    !result.optBoolean("ok")
                ) {
                    showReadFailure(error ?: "invalid_statistics_response")
                    return@runOnUiThread
                }
                try {
                    current = result
                    english = result.optString("language") == "en"
                    if (state.anchor.isEmpty()) state.anchor = result.getString("today")
                    if (state.calendarMonth.isEmpty()) state.calendarMonth = state.anchor.take(7)
                    draw(result)
                    confirmed = true
                    if (selected != null) showDay(result.getJSONObject("selectedDay"))
                } catch (_: org.json.JSONException) {
                    showReadFailure("invalid_statistics_response")
                }
                repaint()
            }
        }
    }

    private fun showReadFailure(code: String) {
        confirmed = false
        goalButtons.forEach { it.isEnabled = false }
        status.text = tr(
            "阅读统计读取失败。页面可能包含上次结果，不代表最新状态；没有把错误当作零条记录。",
            "Statistics could not be loaded. Any retained results are not current; this error is not an empty history.",
        ) + "\n" + code
        if (retryButton.parent == null) root.addView(retryButton, 1)
        repaint()
    }

    private fun controls(
        parent: LinearLayout,
        values: List<Pair<String, () -> Unit>>,
    ) {
        val row = NativeActionFlow(activity)
        values.forEach { (title, action) -> row.addView(button(title, action)) }
        parent.addView(row)
    }

    private fun recoveryEntry() {
        val row =
            NativeActionFlow(activity).apply {
                visibility = View.GONE
            }
        row.addView(
            button(tr("核对设置提交 / 恢复", "Inspect settings / recovery")) { recoverSettings() }.apply {
                textSize = 13f
            },
        )
        recoveryRow = row
        root.addView(row)
    }

    private fun draw(result: JSONObject) {
        goalButtons.clear()
        root.removeAllViews()
        status.text = ""
        root.addView(status)
        val tabs = NativeActionFlow(activity)
        for ((id, label) in listOf("overview" to tr("概览", "Overview"), "trend" to tr("趋势", "Trends"), "calendar" to tr("年历", "Calendar"))) {
            tabs.addView(
                ui.button(label, state.view == id) {
                    if (!closed && !saving && state.view != id) {
                        val scroll = generateSequence(root.parent) { it.parent }.filterIsInstance<ScrollView>().firstOrNull()
                        state.positions[state.view] = scroll?.scrollY ?: 0
                        state.view = id
                        draw(current)
                        root.post { if (!closed) scroll?.scrollTo(0, state.positions[id] ?: 0) }
                    }
                },
            )
        }
        root.addView(tabs)
        recoveryEntry()
        val background = ui.paper
        val dashboard = NativeStatsOverviewLayout(activity)
        val todayCard = ui.card(emphatic = true)
        val weekCard = ui.card(tr("本周记录", "This week"))
        val marksCard = ui.card(tr("阅读档案", "Reading register"))
        val trendCard = ui.card(tr("区间趋势", "Period trends"))
        val calendarCard = ui.card(tr("阅读年历", "Reading calendar"))
        val rankCard = ui.card(tr("本期书目排行", "Period book ranking"))
        val daysCard = ui.card(tr("逐日记录", "Daily records"))
        if (state.view == "overview") {
            dashboard.addView(todayCard)
            dashboard.addView(weekCard)
            dashboard.addView(marksCard)
            root.addView(dashboard)
        } else if (state.view == "trend") {
            root.addView(trendCard)
            root.addView(rankCard)
            root.addView(daysCard)
        } else {
            root.addView(calendarCard)
        }
        val today = result.getString("today")
        val overview = result.getJSONObject("overview")
        val period = result.getJSONObject("period")
        val how =
            NativeUi.iconTextButton(activity, tr("如何计时", "How timing works"), "info", ink, background) {
                if (!closed && !saving && dialog?.isShowing != true) {
                    val infoMsg =
                        ui.text(
                            tr(
                                "阅读时长来自现有阅读计时记录，不由本页重新计算。每天累计至少 60 秒计为活跃日；较早的累计差额不伪装成逐日记录。阅读目标、重置和导入仍由原有所有者处理。",
                                "This page reads existing timing records. An active day requires at least 60 seconds; older cumulative differences are not fabricated as daily records. Goals, reset and imports retain their existing owners.",
                            ),
                            15f,
                        ).apply { setLineSpacing(0f, 1.4f) }
                    dialog =
                        NativeStatsSettingsDialog(
                            activity,
                            tr("如何计时", "How timing works"),
                            infoMsg,
                            ui,
                            listOf(AlertDialog.BUTTON_POSITIVE to tr("返回", "Back")),
                        ).also { it.show() }
                }
            }
        if (overview.getJSONObject("milestones").optDouble("totalSeconds", 0.0) <= 0 && result.optDouble("legacySeconds", 0.0) <= 0) {
            root.removeView(dashboard)
            root.removeView(trendCard)
            root.removeView(calendarCard)
            root.removeView(rankCard)
            root.removeView(daysCard)
            val empty =
                ui.card(emphatic = true).apply {
                    setPadding(NativeUi.dp(activity, 24), NativeUi.dp(activity, 20), NativeUi.dp(activity, 24), NativeUi.dp(activity, 20))
                }
            empty.addView(
                TextView(activity).apply {
                    text = "INDEX // EMPTY LEDGER"
                    textSize = 11f
                    typeface = NativeUi.monoTypeface(true)
                    setTextColor(ui.secondary)
                    importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
                },
            )
            empty.addView(
                text(tr("还没有阅读记录", "No reading records yet"), 18f).apply {
                    typeface = NativeUi.editorialTypeface(true)
                    setPadding(0, dp(4), 0, dp(4))
                },
            )
            empty.addView(
                text(tr("从藏书打开一本书后，阅读记录将在这里汇总。", "Open a book from Library to start accumulating reading records."), 13f).apply {
                    setTextColor(ui.secondary)
                    setPadding(0, 0, 0, dp(14))
                },
            )
            val actions = NativeActionFlow(activity)
            actions.addView(
                NativeUi.primaryButton(activity, tr("前往藏书", "Go to Library"), ink, background) { navigate("/library") },
            )
            actions.addView(
                button(tr("设置阅读目标", "Set reading goal")) { editGoal() }.also { goalButtons.add(it) },
            )
            actions.addView(how)
            empty.addView(actions)
            root.addView(empty)
            root.addView(NativeUi.colophonTailpiece(activity, "READING REGISTER · NO DATA", background))
            return
        }
        todayCard.addView(ui.metric(duration(overview.getDouble("todaySeconds")), tr("今天已记录", "Recorded today")))
        todayCard.addView(
            text(
                tr("昨天", "Yesterday") + ": " + duration(overview.getDouble("yesterdaySeconds")) + " · " + tr("连续阅读", "Current streak") +
                    " ${overview.getJSONObject("streak").getInt("current")} " +
                    tr("天", "days"),
            ).apply { fontFeatureSettings = "tnum" },
        )
        val goalActionsRow = NativeActionFlow(activity).apply { setPadding(0, dp(4), 0, dp(8)) }
        goalActionsRow.addView(
            button(tr("每日目标", "Daily goal") + ": ${result.getInt("goalMinutes")} min") { editGoal() }
                .apply {
                    typeface = NativeUi.monoTypeface(false)
                    fontFeatureSettings = "tnum"
                }.also { goalButtons.add(it) },
        )
        goalActionsRow.addView(how)
        todayCard.addView(goalActionsRow)
        val week = overview.getJSONArray("week")
        val todayWeek =
            (0 until week.length()).map { week.getJSONObject(it) }.firstOrNull { it.getBoolean("isToday") }
                ?: throw org.json.JSONException("missing_today")
        if (result.getInt("goalMinutes") > 0) {
            todayCard.addView(
                NativeStatsGoalRule(activity, ui, todayWeek.getDouble("ratio")).apply {
                    contentDescription =
                        tr("今日目标进度", "Today's goal progress") + ": ${(todayWeek.getDouble("ratio") * 100).toInt().coerceIn(0, 100)}%"
                },
                LinearLayout.LayoutParams(-1, dp(12)),
            )
        }
        todayCard.addView(
            text(
                if (result.getInt("goalMinutes") <=
                    0
                ) {
                    tr("未设每日目标；至少 60 秒记为活跃日。", "No daily goal; at least 60s counts as an active day.")
                } else if (todayWeek.getBoolean("met")) {
                    tr("今日目标已达成。", "Today's goal is met.")
                } else {
                    tr("今日目标尚差：", "Remaining to today's goal: ") +
                        duration(result.getInt("goalMinutes") * 60.0 - overview.getDouble("todaySeconds"))
                },
            ),
        )
        result.optJSONObject("continueBook")?.let { recent ->
            if (!recent.isNull("readerPath")) {
                todayCard.addView(
                    NativeUi
                        .primaryButton(
                            activity,
                            tr("继续阅读：", "Continue: ") + recent.getString("title"),
                            ink,
                            background,
                        ) {
                            navigate(recent.getString("readerPath"))
                        }.apply {
                            layoutParams =
                                LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                                    topMargin = dp(6)
                                }
                        },
                )
            }
        }
        if (result.optDouble("legacySeconds") > 0 && overview.getJSONObject("milestones").getDouble("totalSeconds") <= 0) {
            todayCard.addView(
                text(
                    tr("书目保留累计阅读时间：", "Books retain cumulative reading time: ") + duration(result.getDouble("legacySeconds")) +
                        tr("；不虚构每日分布。", "; no daily distribution is fabricated."),
                ),
            )
        }
        weekCard.addView(ui.note(tr("本周（点击日期查看书目）", "This week (tap for books)")))
        val weekStrip =
            LinearLayout(activity).apply {
                orientation = LinearLayout.HORIZONTAL
                weightSum = week.length().coerceAtLeast(1).toFloat()
                layoutParams =
                    LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                        topMargin = dp(4)
                        bottomMargin = dp(4)
                    }
            }
        for (i in 0 until week.length()) {
            val d = week.getJSONObject(i)
            val sec = d.getDouble("seconds")
            val met = d.getBoolean("met")
            val isToday = d.optBoolean("isToday")
            val dayStr = d.getString("day")
            val tile =
                LinearLayout(activity).apply {
                    orientation = LinearLayout.VERTICAL
                    gravity = android.view.Gravity.CENTER
                    minimumHeight = dp(60)
                    isClickable = true
                    isFocusable = true
                    val paperBg = ui.paper
                    val bgFill =
                        if (met) {
                            ink
                        } else if (sec >= 60.0) {
                            ui.sunkenSurface
                        } else {
                            paperBg
                        }
                    val borderColor = if (isToday || met) ink else ui.hairline
                    val borderWidth = if (isToday) 2 else 1
                    this.background =
                        android.graphics.drawable.StateListDrawable().apply {
                            addState(intArrayOf(android.R.attr.state_pressed), ui.shape(ink, ink, 2))
                            addState(intArrayOf(android.R.attr.state_focused), ui.shape(bgFill, ink, 2))
                            addState(intArrayOf(), ui.shape(bgFill, borderColor, borderWidth))
                        }
                    setPadding(dp(2), dp(6), dp(2), dp(6))
                    setOnClickListener { if (!closed && !saving) load(dayStr) }
                    val fg = if (met) paperBg else ink
                    val subFg = if (met) background else ui.secondary
                    val fgStates =
                        android.content.res.ColorStateList(
                            arrayOf(intArrayOf(android.R.attr.state_pressed), intArrayOf()),
                            intArrayOf(paperBg, fg),
                        )
                    val subFgStates =
                        android.content.res.ColorStateList(
                            arrayOf(intArrayOf(android.R.attr.state_pressed), intArrayOf()),
                            intArrayOf(paperBg, subFg),
                        )
                    addView(
                        TextView(activity).apply {
                            text = dayStr.takeLast(5)
                            textSize = 12f
                            typeface = NativeUi.monoTypeface(isToday)
                            fontFeatureSettings = "tnum"
                            gravity = android.view.Gravity.CENTER
                            isDuplicateParentStateEnabled = true
                            setTextColor(subFgStates)
                        },
                    )
                    addView(
                        TextView(activity).apply {
                            text = if (met) "■" else if (sec >= 60.0) "▣" else "□"
                            textSize = 13f
                            gravity = android.view.Gravity.CENTER
                            isDuplicateParentStateEnabled = true
                            setTextColor(fgStates)
                            setPadding(0, dp(2), 0, dp(2))
                        },
                    )
                    addView(
                        TextView(activity).apply {
                            val mins = (sec / 60.0).toInt()
                            text =
                                when {
                                    sec <= 0.0 -> "0s"
                                    sec < 60.0 -> "${sec.toInt()}s"
                                    mins >= 60 -> "${mins / 60}h${mins % 60}m"
                                    else -> "${mins}m"
                                }
                            textSize = 12f
                            typeface = NativeUi.monoTypeface(met || isToday)
                            fontFeatureSettings = "tnum"
                            gravity = android.view.Gravity.CENTER
                            isDuplicateParentStateEnabled = true
                            setTextColor(fgStates)
                        },
                    )
                }
            weekStrip.addView(
                tile,
                LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                    marginStart = if (i == 0) 0 else dp(3)
                    marginEnd = if (i == week.length() - 1) 0 else dp(3)
                },
            )
        }
        weekCard.addView(weekStrip)
        val periodRow = NativeActionFlow(activity)
        listOf(
            "week" to tr("周", "Week"),
            "month" to tr("月", "Month"),
            "year" to tr("年", "Year"),
            "all" to tr("全部", "All"),
            "range" to tr("日期范围", "Date range"),
        ).forEach { (id, label) ->
            periodRow.addView(
                ui.button(label, state.period == id) {
                    if (!closed && !saving) {
                        if (id == "range") {
                            range()
                        } else {
                            state.changePeriod(id)
                            load()
                        }
                    }
                },
            )
        }
        trendCard.addView(periodRow)
        val canShiftPeriod = state.period in listOf("week", "month", "year")
        val canNextPeriod = canShiftPeriod && state.anchor < today
        val navRow = NativeActionFlow(activity)
        navRow.addView(
            button(tr("上一期", "Previous")) { shift(-1) }.apply { isEnabled = canShiftPeriod },
        )
        navRow.addView(
            button(tr("当前期", "Current")) {
                state.changePeriod(if (canShiftPeriod) state.period else "month", today)
                load()
            },
        )
        navRow.addView(
            button(tr("下一期", "Next")) { shift(1) }.apply { isEnabled = canNextPeriod },
        )
        navRow.addView(
            button(tr("类型", "Kind")) {
                choose(
                    listOf("all", "book", "paper"),
                    listOf(tr("全部类型", "All kinds"), tr("图书", "Books"), tr("论文记录", "Paper records")),
                ) {
                    state.kind = it
                    state.offset = 0
                    state.bookOffset = 0
                    load()
                }
            },
        )
        navRow.addView(
            button(tr("选择年份", "Choose year")) {
                val years = period.getJSONArray("years")
                choose((0 until years.length()).map { years.getInt(it).toString() }) {
                    state.changePeriod("year", "$it-01-01")
                    load()
                }
            },
        )
        trendCard.addView(navRow)
        trendCard.addView(
            text(
                period.getString("from") + " — " + period.getString("to") + " · " +
                    when (state.kind) {
                        "all" -> tr("全部类型", "All kinds")
                        "book" -> tr("图书", "Books")
                        "paper" -> tr("论文记录", "Paper records")
                        else -> tr("类型未识别", "Unknown kind")
                    },
                18f,
            ),
        )
        trendCard.addView(
            text(
                duration(period.getDouble("seconds")) + " · ${period.getInt("activeDays")} " + tr("活跃日", "active days") +
                    " · ${period.getInt("bookCount")} " +
                    tr("本/篇", "books/papers"),
                22f,
            ),
        )
        trendCard.addView(
            text(
                tr(
                    "活跃日平均（每天至少 60 秒）",
                    "Average per active day (at least 60s/day)",
                ) + ": " + duration(period.getDouble("activeAverageSeconds")),
            ),
        )
        period.optJSONObject("comparison")?.let { c ->
            trendCard.addView(
                text(
                    tr("上期同期", "Previous comparable interval") + ": " + duration(c.getDouble("prevSeconds")) +
                        if (c.isNull("deltaRatio")) "" else " · ${String.format(Locale.ROOT, "%+.1f%%", c.getDouble("deltaRatio") * 100)}",
                ),
            )
        }
        val trend = period.getJSONArray("trend")
        if (trend.length() >
            0
        ) {
            trendCard.addView(
                bars(
                    (0 until trend.length()).map {
                        val item = trend.getJSONObject(it)
                        item.getString("label").takeLast(5) to
                            item.getDouble("seconds")
                    },
                ),
                LinearLayout.LayoutParams(
                    -1,
                    dp(
                        (
                            176 *
                                activity.resources.configuration.fontScale
                                    .coerceAtLeast(1f)
                        ).toInt(),
                    ),
                ),
            )
        }
        val cal = result.getJSONObject("calendar")
        calendarCard.addView(ui.heading(if (state.heatmapYear == "recent") tr("最近一年", "Recent year") else state.heatmapYear))
        controls(
            calendarCard,
            listOf(
                tr("选择年度范围", "Choose year scope") to {
                    val years = period.getJSONArray("years")
                    choose(
                        listOf("recent") + (0 until years.length()).map { years.getInt(it).toString() },
                        listOf(tr("最近一年", "Recent year")) + (0 until years.length()).map { years.getInt(it).toString() },
                    ) {
                        state.heatmapYear = it
                        load()
                    }
                },
                tr("选择一天查看明细", "Choose day details") to { pickDay() },
            ),
        )
        val heat = cal.getJSONArray("heatmap")
        calendarCard.addView(
            ui.note(
                tr(
                    "深浅表示已有记录；活跃日至少 60 秒，目标着色按当前目标。点击热力图格子、月历或选日可查看当天书目。",
                    "Shades summarize recorded time (active >= 60s; darkest = goal met). Tap a cell, calendar day, or day picker for details.",
                ),
            ),
        )
        val heatmapView = YearHeatmap(heat)
        val sliceRow = NativeActionFlow(activity)
        val sliceChoices =
            listOf(
                "auto" to tr("自适应", "Auto"),
                "h1" to tr("上半年", "H1"),
                "h2" to tr("下半年", "H2"),
                "all" to tr("全年", "Full year"),
            )
        val sliceButtons = mutableListOf<Button>()
        sliceChoices.forEach { (id, caption) ->
            val btn =
                button(caption) {
                    state.heatmapSlice = id
                    sliceButtons.forEachIndexed { idx, b ->
                        NativeUi.styleTab(b, sliceChoices[idx].first == state.heatmapSlice, ink, background)
                    }
                    heatmapView.invalidate()
                }.apply {
                    NativeUi.styleTab(this, state.heatmapSlice == id, ink, background)
                }
            sliceButtons.add(btn)
            sliceRow.addView(btn)
        }
        calendarCard.addView(sliceRow)
        calendarCard.addView(
            heatmapView,
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(126)).apply {
                topMargin = dp(4)
                bottomMargin = dp(6)
            },
        )
        val legendRow =
            LinearLayout(activity).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = android.view.Gravity.END or android.view.Gravity.CENTER_VERTICAL
                setPadding(0, 0, 0, dp(8))
            }
        val hasGoal = current.optInt("goalMinutes", 0) > 0
        legendRow.addView(
            ui.note(tr("少 ", "Less ")).apply {
                textSize = 12f
                setPadding(0, 0, dp(6), 0)
            },
        )
        val swatches =
            if (hasGoal) {
                listOf(
                    ui.paper to ui.secondary,
                    ui.selectedSurface to ui.hairline,
                    ui.secondary to ui.secondary,
                    ui.primary to ui.primary,
                )
            } else {
                listOf(
                    ui.paper to ui.secondary,
                    ui.selectedSurface to ui.hairline,
                    ui.secondary to ui.secondary,
                )
            }
        for ((fill, stroke) in swatches) {
            legendRow.addView(
                View(activity).apply {
                    setBackground(ui.shape(fill, stroke, 1))
                },
                LinearLayout.LayoutParams(dp(12), dp(12)).apply { marginEnd = dp(4) },
            )
        }
        legendRow.addView(
            ui.note(if (hasGoal) tr(" 达标", " Goal") else tr(" 多", " More")).apply {
                textSize = 12f
                setPadding(dp(4), 0, 0, 0)
            },
        )
        calendarCard.addView(legendRow)
        calendar(cal, today, calendarCard)
        val marks = overview.getJSONObject("milestones")
        val grid =
            ui.column().apply {
                val row1 =
                    LinearLayout(activity).apply {
                        orientation = LinearLayout.HORIZONTAL
                        val f1 = ui.factBox(tr("累计时长", "Total time"), duration(marks.getDouble("totalSeconds")), tr("全部馆藏", "All books"))
                        val f2 = ui.factBox(tr("活跃阅读日", "Active days"), "${marks.getInt("activeDays")} " + tr("天", "days"), tr("每天至少60秒", "Min 60s/day"))
                        addView(f1, LinearLayout.LayoutParams(0, -2, 1f).apply { marginEnd = dp(8) })
                        addView(f2, LinearLayout.LayoutParams(0, -2, 1f))
                    }
                val row2 =
                    LinearLayout(activity).apply {
                        orientation = LinearLayout.HORIZONTAL
                        layoutParams = LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(8) }
                        val bestDayObj = marks.optJSONObject("bestDay")
                        val bestDaySec = bestDayObj?.getDouble("seconds") ?: 0.0
                        val bestDayDate = bestDayObj?.getString("day") ?: "—"
                        val f3 = ui.factBox(tr("最长连续", "Longest streak"), "${marks.getInt("longestStreak")} " + tr("天", "days"), tr("打卡记录", "Streak record"))
                        val f4 =
                            ui.factBox(
                                tr("单日最长", "Best day"),
                                if (bestDaySec > 0) duration(bestDaySec) else "—",
                                if (bestDaySec > 0) "$bestDayDate ↗" else bestDayDate,
                            ).apply {
                                if (bestDaySec > 0 && bestDayDate != "—") {
                                    isClickable = true
                                    isFocusable = true
                                    setOnClickListener { load(bestDayDate) }
                                }
                            }
                        addView(f3, LinearLayout.LayoutParams(0, -2, 1f).apply { marginEnd = dp(8) })
                        addView(f4, LinearLayout.LayoutParams(0, -2, 1f))
                    }
                addView(row1)
                addView(row2)
            }
        marksCard.addView(grid)
        marks.optJSONObject("topBook")?.let { addBook(marksCard, it, tr("读得最久", "Top book") + ": ") }
        val books = result.getJSONObject("books")
        val items = books.getJSONArray("items")
        for (i in 0 until items.length()) addBook(rankCard, items.getJSONObject(i))
        pager(books, state.bookOffset, {
            state.bookOffset = it
            load()
        }, rankCard)
        val days = result.getJSONObject("days")
        val rows = days.getJSONArray("items")
        if (days.getInt("total") == 0) daysCard.addView(text(tr("此范围没有已记录的阅读时间。", "No recorded reading time in this range.")))
        for (i in 0 until rows.length()) {
            val d = rows.getJSONObject(i)
            daysCard.addView(button("${d.getString("day")}  ${duration(d.getDouble("seconds"))}") { load(d.getString("day")) })
        }
        pager(days, state.offset, {
            state.offset = it
            load()
        }, daysCard)
    }

    private fun pager(
        dto: JSONObject,
        offset: Int,
        move: (Int) -> Unit,
        parent: LinearLayout = root,
    ) {
        val total = dto.getInt("total")
        val limit = dto.getInt("limit")
        if (total == 0) return
        parent.addView(
            text("${offset + 1}–${(offset + limit).coerceAtMost(total)} / $total", 13f).apply {
                typeface = NativeUi.monoTypeface(false)
                fontFeatureSettings = "tnum"
                setTextColor(ui.secondary)
            },
        )
        if (total <= limit && offset == 0) return
        val row = NativeActionFlow(activity)
        row.addView(button(tr("上页", "Previous page")) { move((offset - limit).coerceAtLeast(0)) }.apply { isEnabled = offset > 0 })
        row.addView(button(tr("下页", "Next page")) { move(offset + limit) }.apply { isEnabled = offset + limit < total })
        parent.addView(row)
    }

    private fun addBook(
        parent: LinearLayout,
        book: JSONObject,
        prefix: String = "",
    ) {
        val title = prefix + book.getString("title") + " · " + duration(book.getDouble("seconds"))
        val id = book.optString("bookId")
        if (book.isNull("bookId") ||
            id.isEmpty()
        ) {
            parent.addView(text(title))
        } else {
            parent.addView(
                ui.settingRow(prefix + book.getString("title"), duration(book.getDouble("seconds"))) {
                    if (!closed &&
                        !saving
                    ) {
                        navigate("/book/${android.net.Uri.encode(id)}")
                    }
                },
            )
        }
    }

    private fun calendar(
        data: JSONObject,
        today: String,
        parent: LinearLayout = root,
    ) {
        parent.addView(ui.heading(tr("月历", "Calendar") + " · " + data.getString("month")))
        controls(
            parent,
            listOf(
                tr("上月", "Previous month") to { shiftMonth(-1) },
                tr("本月", "Current month") to {
                    state.calendarMonth = today.take(7)
                    load()
                },
                tr("下月", "Next month") to { shiftMonth(1) },
            ),
        )
        val grid = ui.column()
        val list = ui.column()
        val header = LinearLayout(activity)
        listOf(tr("一", "Mon"), tr("二", "Tue"), tr("三", "Wed"), tr("四", "Thu"), tr("五", "Fri"), tr("六", "Sat"), tr("日", "Sun")).forEach {
            header.addView(ui.note(it).apply { gravity = android.view.Gravity.CENTER }, LinearLayout.LayoutParams(0, -2, 1f))
        }
        grid.addView(header)
        val rows = data.getJSONArray("rows")
        for (r in 0 until rows.length()) {
            val row =
                LinearLayout(activity).apply {
                    layoutParams = LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(6) }
                }
            val cells = rows.getJSONArray(r)
            for (c in 0 until cells.length()) {
                val cell =
                    if (cells.isNull(c)) {
                        text("")
                    } else {
                        val d = cells.getJSONObject(c)
                        val day = d.getString("day")
                        val sec = d.getDouble("seconds")
                        val met = d.optBoolean("met", false)
                        val active = sec >= 60.0
                        val isToday = day == today
                        val statusTag =
                            when {
                                met -> tr("达标", "Goal met")
                                active -> tr("活跃", "Active")
                                else -> tr("未满60秒", "<60s")
                            }
                        list.addView(
                            ui.settingRow(
                                "$day · $statusTag" + if (isToday) " · ${tr("今天", "Today")}" else "",
                                duration(sec),
                            ) { if (!closed && !saving) load(day) },
                        )
                        val fill =
                            when {
                                met -> ui.primary
                                active -> ui.sunkenSurface
                                else -> ui.paper
                            }
                        val fgColor = if (met) ui.paper else if (active) ui.primary else ui.secondary
                        val borderCol = if (isToday || met) ui.primary else ui.hairline
                        val strokeW = if (isToday) 2 else 1
                        button(day.takeLast(2)) { load(day) }.apply {
                            minimumWidth = dp(48)
                            minWidth = dp(48)
                            minimumHeight = dp(48)
                            minHeight = dp(48)
                            setPadding(dp(2), dp(6), dp(2), dp(6))
                            typeface = NativeUi.monoTypeface(met || active || isToday)
                            fontFeatureSettings = "tnum"
                            setTextColor(
                                android.content.res.ColorStateList(
                                    arrayOf(intArrayOf(android.R.attr.state_pressed), intArrayOf()),
                                    intArrayOf(ui.paper, fgColor),
                                ),
                            )
                            this.background =
                                android.graphics.drawable.StateListDrawable().apply {
                                    addState(intArrayOf(android.R.attr.state_pressed), ui.shape(ui.primary, ui.primary, 2))
                                    addState(intArrayOf(android.R.attr.state_focused), ui.shape(fill, ui.primary, 2))
                                    addState(intArrayOf(), ui.shape(fill, borderCol, strokeW))
                                }
                            contentDescription = "$day ($statusTag): ${duration(sec)}"
                        }
                    }
                row.addView(cell, LinearLayout.LayoutParams(0, -2, 1f).apply { if (c < cells.length() - 1) marginEnd = dp(6) })
            }
            grid.addView(row)
        }
        parent.addView(NativeStatsResponsive(activity, grid, list, 440))
    }

    private fun shift(delta: Int) {
        if (state.period !in listOf("week", "month", "year")) return
        val c = date(state.anchor)
        c.add(
            when (state.period) {
                "week" -> Calendar.DAY_OF_MONTH
                "month" -> Calendar.MONTH
                else -> Calendar.YEAR
            },
            if (state.period ==
                "week"
            ) {
                delta * 7
            } else {
                delta
            },
        )
        state.changePeriod(state.period, iso(c))
        load()
    }

    private fun shiftMonth(delta: Int) {
        val c = date(state.calendarMonth + "-01")
        c.add(Calendar.MONTH, delta)
        state.calendarMonth =
            iso(c).take(7)
        load()
    }

    private fun date(value: String) =
        Calendar.getInstance().apply {
            set(value.take(4).toInt(), value.substring(5, 7).toInt() - 1, value.takeLast(2).toInt(), 12, 0, 0)
        }

    private fun iso(c: Calendar) =
        String.format(Locale.ROOT, "%04d-%02d-%02d", c.get(Calendar.YEAR), c.get(Calendar.MONTH) + 1, c.get(Calendar.DAY_OF_MONTH))

    private fun choose(
        options: List<String>,
        labels: List<String> = options,
        action: (String) -> Unit,
    ) {
        if (options.isEmpty()) return
        dialog?.dismiss()
        dayBody = null
        dayDialog = null
        val list = ui.column()
        lateinit var pickerDialog: NativeStatsSettingsDialog
        options.forEachIndexed { index, value ->
            list.addView(
                button(labels.getOrElse(index) { value }) {
                    pickerDialog.dismiss()
                    action(value)
                }.apply {
                    gravity = android.view.Gravity.START or android.view.Gravity.CENTER_VERTICAL
                    layoutParams = LinearLayout.LayoutParams(-1, -2).apply {
                        if (index < options.lastIndex) bottomMargin = dp(8)
                    }
                },
            )
        }
        pickerDialog =
            NativeStatsSettingsDialog(
                activity,
                tr("选择范围或年份", "Select option"),
                list,
                ui,
                listOf(AlertDialog.BUTTON_NEGATIVE to tr("取消", "Cancel")),
            ).also {
                dialog = it
                it.show()
            }
    }

    private fun createStyledDatePicker(
        title: String,
        year: Int,
        month: Int,
        day: Int,
        onDate: (Int, Int, Int) -> Unit,
    ): DatePickerDialog {
        val listener = DatePickerDialog.OnDateSetListener { _, y, m, d -> onDate(y, m, d) }
        @Suppress("DEPRECATION")
        val picker =
            runCatching {
                DatePickerDialog(activity, android.R.style.Theme_Holo_Light_Dialog_NoActionBar, listener, year, month, day)
            }.getOrElse {
                DatePickerDialog(activity, listener, year, month, day)
            }
        picker.setTitle(title)
        runCatching {
            @Suppress("DEPRECATION")
            picker.datePicker.calendarViewShown = false
            @Suppress("DEPRECATION")
            picker.datePicker.spinnersShown = true
        }
        picker.setCanceledOnTouchOutside(false)
        picker.setOnDismissListener { NativeUi.onDialogDismissRepaint() }
        picker.setOnShowListener {
            picker.window?.apply {
                setWindowAnimations(0)
                setDimAmount(0f)
            }
        }
        return picker
    }

    private fun range() {
        val c = date(state.anchor)
        val first =
            createStyledDatePicker(
                tr("选择开始日期", "Select start date"),
                c.get(Calendar.YEAR),
                c.get(Calendar.MONTH),
                c.get(Calendar.DAY_OF_MONTH),
            ) { y, m, d ->
                val from = String.format(Locale.ROOT, "%04d-%02d-%02d", y, m + 1, d)
                val second =
                    createStyledDatePicker(
                        tr("选择结束日期", "Select end date"),
                        y,
                        m,
                        d,
                    ) { ey, em, ed ->
                        val to = String.format(Locale.ROOT, "%04d-%02d-%02d", ey, em + 1, ed)
                        state.from = minOf(from, to)
                        state.to = maxOf(from, to)
                        state.changePeriod("range")
                        load()
                    }
                dialog = second
                second.show()
            }
        dialog = first
        first.show()
    }

    private fun pickDay() {
        val c = date(state.anchor)
        val picker =
            createStyledDatePicker(
                tr("选择日期", "Select date"),
                c.get(Calendar.YEAR),
                c.get(Calendar.MONTH),
                c.get(Calendar.DAY_OF_MONTH),
            ) { y, m, d ->
                load(String.format(Locale.ROOT, "%04d-%02d-%02d", y, m + 1, d))
            }
        dialog = picker
        picker.show()
    }

    private inner class YearHeatmap(
        private val columns: JSONArray,
    ) : View(activity) {
        private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
        private var downX = 0f
        private var downY = 0f

        init {
            contentDescription =
                tr("年度阅读热力图，点击方块、月历或选日可查看当天详情。", "Year reading calendar heatmap; tap a cell or use month/day controls for day details.")
            val touchSlop = android.view.ViewConfiguration.get(activity).scaledTouchSlop.toFloat()
            setOnTouchListener { _, ev ->
                when (ev.actionMasked) {
                    android.view.MotionEvent.ACTION_DOWN -> {
                        downX = ev.x
                        downY = ev.y
                        true
                    }
                    android.view.MotionEvent.ACTION_UP -> {
                        if (kotlin.math.abs(ev.x - downX) <= touchSlop && kotlin.math.abs(ev.y - downY) <= touchSlop) {
                            val tappedDay = dayAt(ev.x, ev.y)
                            if (!tappedDay.isNullOrEmpty() && !closed && !saving) {
                                load(tappedDay)
                            }
                        }
                        true
                    }
                    else -> false
                }
            }
        }

        private fun sliceRange(viewWidth: Int): IntRange {
            val count = columns.length()
            if (count <= 1) return 0 until count
            val half = count / 2
            val mode =
                if (state.heatmapSlice == "auto") {
                    if (viewWidth > 0 && viewWidth < dp(520)) "h2" else "all"
                } else {
                    state.heatmapSlice
                }
            return when (mode) {
                "h1" -> 0 until half.coerceAtLeast(1)
                "h2" -> half until count
                else -> 0 until count
            }
        }

        private fun dayAt(
            x: Float,
            y: Float,
        ): String? {
            if (columns.length() == 0 || width <= 0) return null
            val range = sliceRange(width)
            val span = (range.last - range.first + 1).coerceAtLeast(1)
            val topBand = dp(18).toFloat()
            val cell = minOf(dp(14).toFloat(), width.toFloat() / span)
            if (y < topBand) return null
            val colOffset = (x / cell).toInt()
            val rowOffset = ((y - topBand) / cell).toInt()
            val colIdx = range.first + colOffset
            if (colIdx !in range || rowOffset !in 0..6) return null
            val col = columns.optJSONArray(colIdx) ?: return null
            if (rowOffset >= col.length() || col.isNull(rowOffset)) return null
            return col.optJSONObject(rowOffset)?.optString("day")
        }

        override fun onMeasure(
            widthMeasureSpec: Int,
            heightMeasureSpec: Int,
        ) {
            setMeasuredDimension(MeasureSpec.getSize(widthMeasureSpec), resolveSize(dp(124), heightMeasureSpec))
        }

        override fun onDraw(canvas: Canvas) {
            super.onDraw(canvas)
            if (columns.length() == 0 || width <= 0) return
            val range = sliceRange(width)
            val span = (range.last - range.first + 1).coerceAtLeast(1)
            val topBand = dp(18).toFloat()
            val cell = minOf(dp(14).toFloat(), width.toFloat() / span)
            val inset = dp(1).toFloat().coerceAtLeast(1f)
            paint.typeface = NativeUi.monoTypeface(false)
            paint.textSize = 11f * resources.displayMetrics.scaledDensity
            paint.textAlign = Paint.Align.LEFT
            var lastMonth = ""
            var lastLabelX = -1000f
            val minLabelGap = dp(28).toFloat()
            for (rawX in range) {
                val drawX = rawX - range.first
                val column = columns.getJSONArray(rawX)
                var monthSample = ""
                for (y in 0 until column.length()) {
                    if (!column.isNull(y)) {
                        val obj = column.getJSONObject(y)
                        val dayVal = obj.optString("day")
                        if (monthSample.isEmpty() && dayVal.length >= 7) {
                            monthSample = dayVal.substring(5, 7)
                        }
                        val seconds = obj.getDouble("seconds")
                        val goalSec = current.optInt("goalMinutes", 0).coerceAtLeast(0) * 60.0
                        val level =
                            when {
                                seconds <= 0.0 -> 0
                                goalSec > 0.0 ->
                                    when {
                                        seconds < maxOf(60.0, goalSec * 0.5) -> 1
                                        seconds < goalSec -> 2
                                        else -> 3
                                    }
                                seconds < 900.0 -> 1
                                else -> 2
                            }
                        paint.color =
                            when (level) {
                                0 -> ui.paper
                                1 -> ui.selectedSurface
                                2 -> ui.secondary
                                else -> ui.primary
                            }
                        val left = drawX * cell + inset
                        val top = topBand + y * cell + inset
                        val right = (drawX + 1) * cell - inset
                        val bottom = topBand + (y + 1) * cell - inset
                        paint.style = Paint.Style.FILL
                        canvas.drawRect(left, top, right, bottom, paint)
                        if (level == 1) {
                            paint.color = ui.primary
                            canvas.drawCircle((left + right) / 2f, (top + bottom) / 2f, maxOf(1.5f, cell * 0.14f), paint)
                        } else if (level == 2) {
                            paint.color = ui.paper
                            paint.style = Paint.Style.STROKE
                            paint.strokeWidth = maxOf(1.2f, inset)
                            canvas.drawLine(left + inset, bottom - inset, right - inset, top + inset, paint)
                        }
                        if (level < 3) {
                            paint.color = ui.secondary
                            paint.style = Paint.Style.STROKE
                            paint.strokeWidth = inset
                            canvas.drawRect(left, top, right, bottom, paint)
                        }
                    }
                }
                val labelX = drawX * cell + inset
                if (monthSample.isNotEmpty() && monthSample != lastMonth && labelX - lastLabelX >= minLabelGap) {
                    paint.style = Paint.Style.FILL
                    paint.color = ui.secondary
                    canvas.drawText(if (english) monthSample else "${monthSample}月", labelX, dp(12).toFloat(), paint)
                    lastMonth = monthSample
                    lastLabelX = labelX
                }
            }
        }
    }

    private fun showDay(day: JSONObject) {
        val reuse = dayBody != null && dialog === dayDialog && dayDialog?.isShowing == true
        val focusTitle = if (reuse) (dayDialog?.currentFocus as? Button)?.text?.toString() else null
        val form = if (reuse) dayBody!! else ui.column().also { dayBody = it }
        form.removeAllViews()
        form.addView(ui.metric(duration(day.getDouble("seconds")), day.getString("day")))
        val books = day.getJSONArray("books")
        for (i in 0 until books.length()) addBook(form, books.getJSONObject(i))
        val offset = day.getInt("offset")
        val total = day.getInt("totalBooks")
        val limit = day.getInt("limit")
        pager(JSONObject().put("total", total).put("limit", limit), offset, { load(day.getString("day"), it) }, form)
        if (books.length() == 0) form.addView(ui.note(tr("当天没有已记录的阅读时间。", "No recorded reading time on this day.")))
        if (focusTitle != null) {
            form.post {
                fun find(view: View): Button? {
                    if (view is Button && view.text.toString() == focusTitle && view.isEnabled) return view
                    if (view is android.view.ViewGroup) for (i in 0 until view.childCount) find(view.getChildAt(i))?.let { return it }
                    return null
                }
                (find(form) ?: dayDialog?.getButton(AlertDialog.BUTTON_NEGATIVE))?.requestFocusFromTouch()
            }
        }
        if (!reuse) {
            dialog?.dismiss()
            dayDialog =
                NativeStatsSettingsDialog(
                    activity,
                    tr("当日详情", "Day details"),
                    form,
                    ui,
                    listOf(AlertDialog.BUTTON_NEGATIVE to tr("返回", "Back")),
                ).also { it.show() }
            dialog = dayDialog
        }
    }

    private fun editGoal() {
        if (!confirmed || closed || saving) return
        val input =
            ui.field().apply {
                inputType = InputType.TYPE_CLASS_NUMBER
                setText(current.getInt("goalMinutes").toString())
                hint =
                    "0–1440 min"
            }
        val error = text("")
        val form =
            LinearLayout(activity).apply {
                orientation = LinearLayout.VERTICAL
                addView(input)
                addView(error)
            }
        dayBody = null
        val alert: AlertDialog =
            NativeStatsSettingsDialog(
                activity,
                tr("每日目标（0 为不设目标）", "Daily goal (0 disables goal)"),
                form,
                ui,
                listOf(
                    AlertDialog.BUTTON_NEGATIVE to tr("取消", "Cancel"),
                    AlertDialog.BUTTON_NEUTRAL to tr("核对恢复", "Recovery"),
                    AlertDialog.BUTTON_POSITIVE to tr("保存", "Save"),
                ),
            )
        dialog = alert
        alert.setCanceledOnTouchOutside(false)
        alert.setOnShowListener {
            alert.getButton(AlertDialog.BUTTON_NEUTRAL).setOnClickListener { if (!saving) recoverSettings() }
            alert.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                if (saving) return@setOnClickListener
                val value = input.text.toString().toIntOrNull()
                if (value == null || value !in 0..1440) {
                    error.text = tr("请输入 0–1440 之间的整数分钟。", "Enter whole minutes from 0 to 1440.")
                    return@setOnClickListener
                }
                saving = true
                alert.setCancelable(false)
                alert.getButton(AlertDialog.BUTTON_POSITIVE).isEnabled = false
                alert.getButton(AlertDialog.BUTTON_NEGATIVE).isEnabled =
                    false
                val patch =
                    JSONObject()
                        .put(
                            "path",
                            JSONArray().put("dailyGoalMinutes"),
                        ).put(
                            "before",
                            JSONObject().put("present", true).put("value", current.get("goalBefore")),
                        ).put("after", JSONObject().put("present", true).put("value", value))
                request("action.settingsPatch", JSONObject().put("patches", JSONArray().put(patch))) { result, failure ->
                    activity.runOnUiThread {
                        saving = false
                        if (!closed) {
                            alert.setCancelable(true)
                            alert.getButton(AlertDialog.BUTTON_POSITIVE).isEnabled = true
                            alert.getButton(AlertDialog.BUTTON_NEGATIVE).isEnabled =
                                true
                            if (failure != null ||
                                result?.optBoolean("ok") != true
                            ) {
                                error.text = failure ?: "settings_commit_unconfirmed"
                            } else {
                                alert.dismiss()
                                load()
                            }
                        }
                    }
                }
            }
        }
        alert.show()
    }

    fun canLeave() = !saving

    fun isEditing() = saving || dialog?.isShowing == true

    fun handleBack(): Boolean {
        if (saving) return true
        if (dialog?.isShowing == true) {
            dialog?.dismiss()
            return true
        }
        return false
    }

    fun close() {
        closed = true
        epoch++
        dialog?.dismiss()
        dialog = null
    }
}
