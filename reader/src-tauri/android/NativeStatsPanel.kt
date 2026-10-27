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
                textSize = 12f
                minHeight = NativeUi.dp(activity, 36)
                minimumHeight = NativeUi.dp(activity, 36)
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
                    dialog =
                        AlertDialog
                            .Builder(activity)
                            .setTitle(tr("如何计时", "How timing works"))
                            .setMessage(
                                tr(
                                    "阅读时长来自现有阅读计时记录，不由本页重新计算。每天累计至少 60 秒计为活跃日；较早的累计差额不伪装成逐日记录。阅读目标、重置和导入仍由原有所有者处理。",
                                    "This page reads existing timing records. An active day requires at least 60 seconds; older cumulative differences are not fabricated as daily records. Goals, reset and imports retain their existing owners.",
                                ),
                            ).setPositiveButton(tr("返回", "Back"), null)
                            .create()
                            .also { it.show() }
                }
            }.apply {
                visibility = View.GONE
            }
        recoveryRow?.addView(how)
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
            val actions =
                LinearLayout(activity).apply {
                    orientation = LinearLayout.HORIZONTAL
                }
            actions.addView(
                NativeUi.primaryButton(activity, tr("前往藏书", "Go to Library"), ink, background) { navigate("/library") },
                LinearLayout.LayoutParams(-2, -2).apply { marginEnd = dp(8) },
            )
            actions.addView(
                button(tr("设置阅读目标", "Set reading goal")) { editGoal() }.apply {
                    minHeight = dp(44)
                    minimumHeight = dp(44)
                }.also { goalButtons.add(it) },
            )
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
            ),
        )
        todayCard.addView(
            button(tr("每日目标", "Daily goal") + ": ${result.getInt("goalMinutes")} min") { editGoal() }
                .apply {
                    typeface = NativeUi.monoTypeface(false)
                    fontFeatureSettings = "tnum"
                    layoutParams =
                        LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                            topMargin = dp(4)
                            bottomMargin = dp(8)
                        }
                }.also { goalButtons.add(it) },
        )
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
        controls(
            weekCard,
            (0 until week.length()).map { i ->
                val d = week.getJSONObject(i)
                (
                    d.getString("day").takeLast(5) + "\n" +
                        duration(d.getDouble("seconds")) +
                        if (d.getBoolean("met")) " ✓" else ""
                ) to
                    { load(d.getString("day")) }
            },
        )
        controls(
            trendCard,
            listOf(
                tr("周", "Week") to {
                    state.changePeriod("week")
                    load()
                },
                tr("月", "Month") to {
                    state.changePeriod("month")
                    load()
                },
                tr("年", "Year") to {
                    state.changePeriod("year")
                    load()
                },
                tr("全部", "All") to {
                    state.changePeriod("all")
                    load()
                },
                tr("日期范围", "Date range") to { range() },
            ),
        )
        controls(
            trendCard,
            listOf(
                tr("上一期", "Previous") to { shift(-1) },
                tr("当前期", "Current") to
                    {
                        state.changePeriod(
                            if (state.period in
                                listOf("week", "month", "year")
                            ) {
                                state.period
                            } else {
                                "month"
                            },
                            today,
                        )
                        ; load()
                    },
                tr("下一期", "Next") to { shift(1) },
                tr("类型", "Kind") to
                    {
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
                tr("选择年份", "Choose year") to
                    {
                        val years = period.getJSONArray("years")
                        choose((0 until years.length()).map { years.getInt(it).toString() }) {
                            state.changePeriod("year", "$it-01-01")
                            load()
                        }
                    },
            ),
        )
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
                    "深浅表示已有记录；活跃日至少 60 秒，目标着色按当前目标。具体日期通过月历或选日查看。",
                    "Shades summarize recorded time. Active days require 60s; goal shading uses your current goal. Use calendar/day selection for details.",
                ),
            ),
        )
        calendarCard.addView(
            NativeStatsResponsive(
                activity,
                YearHeatmap(heat),
                ui.note(tr("此宽度下请使用月历或选日查看记录。", "Use calendar or day selection at this width.")),
                heat.length() * 12 + 36,
            ),
        )
        calendar(cal, calendarCard)
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
                        val bestDaySec = marks.optJSONObject("bestDay")?.getDouble("seconds") ?: 0.0
                        val bestDayDate = marks.optJSONObject("bestDay")?.getString("day") ?: "—"
                        val f3 = ui.factBox(tr("最长连续", "Longest streak"), "${marks.getInt("longestStreak")} " + tr("天", "days"), tr("打卡记录", "Streak record"))
                        val f4 = ui.factBox(tr("单日最长", "Best day"), if (bestDaySec > 0) duration(bestDaySec) else "—", bestDayDate)
                        addView(f3, LinearLayout.LayoutParams(0, -2, 1f).apply { marginEnd = dp(8) })
                        addView(f4, LinearLayout.LayoutParams(0, -2, 1f))
                    }
                addView(row1)
                addView(row2)
            }
        marksCard.addView(grid)
        marks.optJSONObject("bestDay")?.let {
            marksCard.addView(
                button(
                    tr("单日最长", "Best day") + ": ${it.getString("day")} · ${duration(it.getDouble("seconds"))}",
                ) { load(it.getString("day")) }.apply {
                    typeface = NativeUi.monoTypeface(false)
                    fontFeatureSettings = "tnum"
                    layoutParams =
                        LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                            topMargin = dp(4)
                            bottomMargin = dp(6)
                        }
                },
            )
        }
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
        parent.addView(text("${if (total == 0) 0 else offset + 1}–${(offset + limit).coerceAtMost(total)} / $total", 13f))
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
        parent: LinearLayout = root,
    ) {
        parent.addView(ui.heading(tr("月历", "Calendar") + " · " + data.getString("month")))
        controls(parent, listOf(tr("上月", "Previous month") to { shiftMonth(-1) }, tr("下月", "Next month") to { shiftMonth(1) }))
        val grid = ui.column()
        val list = ui.column()
        val header = LinearLayout(activity)
        listOf(tr("一", "Mon"), tr("二", "Tue"), tr("三", "Wed"), tr("四", "Thu"), tr("五", "Fri"), tr("六", "Sat"), tr("日", "Sun")).forEach {
            header.addView(ui.note(it).apply { gravity = android.view.Gravity.CENTER }, LinearLayout.LayoutParams(0, -2, 1f))
        }
        grid.addView(header)
        val rows = data.getJSONArray("rows")
        for (r in 0 until rows.length()) {
            val row = LinearLayout(activity)
            val cells = rows.getJSONArray(r)
            for (c in 0 until cells.length()) {
                val cell =
                    if (cells.isNull(c)) {
                        text("")
                    } else {
                        val d = cells.getJSONObject(c)
                        val day = d.getString("day")
                        list.addView(ui.settingRow(day, duration(d.getDouble("seconds"))) { if (!closed && !saving) load(day) })
                        button(day.takeLast(2)) { load(day) }.apply {
                            minimumWidth = dp(48)
                            minWidth = dp(48)
                            contentDescription = day + ": " + duration(d.getDouble("seconds"))
                        }
                    }
                row.addView(cell, LinearLayout.LayoutParams(0, -2, 1f).apply { if (c < cells.length() - 1) marginEnd = dp(4) })
            }
            grid.addView(row)
        }
        parent.addView(NativeStatsResponsive(activity, grid, list, 392))
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
        dialog =
            AlertDialog
                .Builder(activity)
                .setItems(labels.toTypedArray()) { _, index -> action(options[index]) }
                .setNegativeButton(tr("取消", "Cancel"), null)
                .show()
                .also { it.window?.setWindowAnimations(0) }
    }

    private fun range() {
        val c = date(state.anchor)
        val first =
            DatePickerDialog(activity, { _, y, m, d ->
                val from = String.format(Locale.ROOT, "%04d-%02d-%02d", y, m + 1, d)
                val second =
                    DatePickerDialog(activity, { _, ey, em, ed ->
                        val to = String.format(Locale.ROOT, "%04d-%02d-%02d", ey, em + 1, ed)
                        state.from = minOf(from, to)
                        state.to = maxOf(from, to)
                        state.changePeriod("range")
                        load()
                    }, y, m, d)
                dialog = second
                second.show()
            }, c.get(Calendar.YEAR), c.get(Calendar.MONTH), c.get(Calendar.DAY_OF_MONTH))
        dialog = first
        first.show()
    }

    private fun pickDay() {
        val c = date(state.anchor)
        val picker =
            DatePickerDialog(
                activity,
                { _, y, m, d -> load(String.format(Locale.ROOT, "%04d-%02d-%02d", y, m + 1, d)) },
                c.get(Calendar.YEAR),
                c.get(Calendar.MONTH),
                c.get(Calendar.DAY_OF_MONTH),
            )
        dialog = picker
        picker.show()
    }

    private inner class YearHeatmap(
        private val columns: JSONArray,
    ) : View(activity) {
        private val paint = Paint(Paint.ANTI_ALIAS_FLAG)

        init {
            contentDescription =
                tr("年度阅读日历，具体日期可通过月历或选择日期查看。", "Year reading calendar; use month/day controls for accessible day details.")
        }

        override fun onMeasure(
            widthMeasureSpec: Int,
            heightMeasureSpec: Int,
        ) {
            setMeasuredDimension(MeasureSpec.getSize(widthMeasureSpec), resolveSize(dp(100), heightMeasureSpec))
        }

        override fun onDraw(canvas: Canvas) {
            super.onDraw(canvas)
            if (columns.length() == 0) return
            val size = minOf(dp(12).toFloat(), width.toFloat() / columns.length())
            for (x in 0 until columns.length()) {
                val column = columns.getJSONArray(x)
                for (y in 0 until column.length()) {
                    if (!column.isNull(y)) {
                        val seconds = column.getJSONObject(y).getDouble("seconds")
                        paint.color =
                            when {
                                seconds <= 0 -> ui.paper
                                seconds < 60 -> ui.selectedSurface
                                seconds < current.getInt("goalMinutes") * 60 -> ui.secondary
                                else -> ui.primary
                            }
                        paint.style = Paint.Style.FILL
                        canvas.drawRect(x * size + 1, y * size + 1, (x + 1) * size - 1, (y + 1) * size - 1, paint)
                        if (seconds <= 0) {
                            paint.color = ui.secondary
                            paint.style = Paint.Style.STROKE
                            paint.strokeWidth = 1f
                            canvas.drawRect(x * size + 1, y * size + 1, (x + 1) * size - 1, (y + 1) * size - 1, paint)
                        }
                    }
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
