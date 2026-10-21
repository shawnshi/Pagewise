package io.pagewise.reader

import android.app.Activity
import android.app.AlertDialog
import android.app.DatePickerDialog
import android.graphics.Canvas
import android.graphics.Paint
import android.text.InputType
import android.view.View
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
) {
    private val root = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }
    private val status = text("")
    private var current = JSONObject()
    private var english = false
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
    ) = TextView(activity).apply {
        this.text = value
        textSize = size
        setTextColor(ink)
        setPadding(dp(4), dp(8), dp(4), dp(8))
    }

    private fun button(
        value: String,
        action: () -> Unit,
    ) = Button(activity).apply {
        text = value
        isAllCaps = false
        minHeight = dp(48)
        setTextColor(ink)
        setOnClickListener {
            if (!closed &&
                !saving
            ) {
                action()
            }
        }
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
        if (root.childCount == 0) root.addView(status)
        status.text = tr("正在读取已确认的阅读记录…", "Loading confirmed reading records…")
        request("action.statisticsGet", payload(selected, dayBookOffset)) { result, error ->
            activity.runOnUiThread {
                if (closed || token != epoch) return@runOnUiThread
                if (error != null || result == null ||
                    !result.optBoolean("ok")
                ) {
                    status.text = error ?: "invalid_statistics_response"
                    return@runOnUiThread
                }
                try {
                    current = result
                    english = result.optString("language") == "en"
                    if (state.anchor.isEmpty()) state.anchor = result.getString("today")
                    if (state.calendarMonth.isEmpty()) state.calendarMonth = state.anchor.take(7)
                    draw(result)
                    if (selected != null) showDay(result.getJSONObject("selectedDay"))
                } catch (_: org.json.JSONException) {
                    status.text = "invalid_statistics_response"
                }
                repaint()
            }
        }
    }

    private fun controls(
        parent: LinearLayout,
        values: List<Pair<String, () -> Unit>>,
    ) {
        val row = LinearLayout(activity)
        values.forEach { (title, action) -> row.addView(button(title, action)) }
        parent.addView(android.widget.HorizontalScrollView(activity).apply { addView(row) })
    }

    private fun recoveryEntry() {
        root.addView(button(tr("核对设置提交 / 恢复", "Inspect settings / recovery")) { recoverSettings() })
    }

    private fun draw(result: JSONObject) {
        root.removeAllViews()
        status.text = ""
        root.addView(status)
        recoveryEntry()
        val today = result.getString("today")
        val overview = result.getJSONObject("overview")
        val period = result.getJSONObject("period")
        root.addView(text(tr("今天", "Today") + ": " + duration(overview.getDouble("todaySeconds")), 28f))
        root.addView(
            text(
                tr("昨天", "Yesterday") + ": " + duration(overview.getDouble("yesterdaySeconds")) + " · " + tr("连续阅读", "Current streak") +
                    " ${overview.getJSONObject("streak").getInt("current")} " +
                    tr("天", "days"),
            ),
        )
        root.addView(button(tr("每日目标", "Daily goal") + ": ${result.getInt("goalMinutes")} min") { editGoal() })
        val week = overview.getJSONArray("week")
        val todayWeek =
            (0 until week.length()).map { week.getJSONObject(it) }.firstOrNull { it.getBoolean("isToday") }
                ?: throw org.json.JSONException("missing_today")
        root.addView(
            android.widget.ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal).apply {
                max = 100
                progress = (todayWeek.getDouble("ratio") * 100).toInt().coerceIn(0, 100)
                progressTintList =
                    android.content.res.ColorStateList
                        .valueOf(ink)
                contentDescription = tr("今日目标进度", "Today's goal progress") + ": $progress%"
            },
            LinearLayout.LayoutParams(-1, dp(12)),
        )
        root.addView(
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
                root.addView(
                    button(tr("继续阅读：", "Continue: ") + recent.getString("title")) {
                        navigate(recent.getString("readerPath"))
                    },
                )
            }
        }
        if (result.optDouble("legacySeconds") > 0 && overview.getJSONObject("milestones").getDouble("totalSeconds") <= 0) {
            root.addView(
                text(
                    tr("书目保留累计阅读时间：", "Books retain cumulative reading time: ") + duration(result.getDouble("legacySeconds")) +
                        tr("；不虚构每日分布。", "; no daily distribution is fabricated."),
                ),
            )
        }
        root.addView(text(tr("本周（点击日期查看书目）", "This week (tap for books)"), 20f))
        controls(
            root,
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
            root,
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
            root,
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
                        choose(listOf("all", "book", "paper")) {
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
        root.addView(text(period.getString("from") + " — " + period.getString("to") + " [${state.kind}]", 18f))
        root.addView(
            text(
                duration(period.getDouble("seconds")) + " · ${period.getInt("activeDays")} " + tr("活跃日", "active days") +
                    " · ${period.getInt("bookCount")} " +
                    tr("本/篇", "books/papers"),
                22f,
            ),
        )
        root.addView(
            text(
                tr(
                    "活跃日平均（每天至少 60 秒）",
                    "Average per active day (at least 60s/day)",
                ) + ": " + duration(period.getDouble("activeAverageSeconds")),
            ),
        )
        period.optJSONObject("comparison")?.let { c ->
            root.addView(
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
            root.addView(
                bars(
                    (0 until trend.length()).map {
                        val item = trend.getJSONObject(it)
                        item.getString("label").takeLast(5) to
                            item.getDouble("seconds")
                    },
                ),
                LinearLayout.LayoutParams(-1, dp(176)),
            )
        }
        val cal = result.getJSONObject("calendar")
        root.addView(text(tr("年度日历", "Year calendar") + " · " + state.heatmapYear, 22f))
        controls(
            root,
            listOf(
                tr("选择年度范围", "Choose year scope") to {
                    val years = period.getJSONArray("years")
                    choose(listOf("recent") + (0 until years.length()).map { years.getInt(it).toString() }) {
                        state.heatmapYear = it
                        load()
                    }
                },
                tr("选择一天查看明细", "Choose day details") to { pickDay() },
            ),
        )
        val heat = cal.getJSONArray("heatmap")
        root.addView(
            android.widget.HorizontalScrollView(activity).apply {
                addView(YearHeatmap(heat), android.widget.FrameLayout.LayoutParams(dp(heat.length() * 9), dp(68)))
            },
        )
        calendar(cal)
        val marks = overview.getJSONObject("milestones")
        root.addView(text(tr("里程碑", "Milestones"), 22f))
        root.addView(
            text(
                tr("累计", "Total") + ": " + duration(marks.getDouble("totalSeconds")) + " · ${marks.getInt("activeDays")} " +
                    tr("阅读天", "active days") +
                    " · " +
                    tr("最长连续", "Longest streak") +
                    " ${marks.getInt("longestStreak")} " +
                    tr("天", "days"),
            ),
        )
        marks.optJSONObject("bestDay")?.let {
            root.addView(
                button(
                    tr("单日最长", "Best day") + ": ${it.getString("day")} · ${duration(it.getDouble("seconds"))}",
                ) { load(it.getString("day")) },
            )
        }
        marks.optJSONObject("topBook")?.let { addBook(root, it, tr("读得最久", "Top book") + ": ") }
        root.addView(text(tr("本期书目排行", "Period book ranking"), 22f))
        val books = result.getJSONObject("books")
        val items = books.getJSONArray("items")
        for (i in 0 until items.length()) addBook(root, items.getJSONObject(i))
        pager(books, state.bookOffset, {
            state.bookOffset = it
            load()
        })
        root.addView(text(tr("逐日记录", "Daily records"), 22f))
        val days = result.getJSONObject("days")
        val rows = days.getJSONArray("items")
        if (days.getInt("total") == 0) root.addView(text(tr("此范围没有已记录的阅读时间。", "No recorded reading time in this range.")))
        for (i in 0 until rows.length()) {
            val d = rows.getJSONObject(i)
            root.addView(button("${d.getString("day")}  ${duration(d.getDouble("seconds"))}") { load(d.getString("day")) })
        }
        pager(days, state.offset, {
            state.offset = it
            load()
        })
    }

    private fun pager(
        dto: JSONObject,
        offset: Int,
        move: (Int) -> Unit,
    ) {
        val total = dto.getInt("total")
        val limit = dto.getInt("limit")
        root.addView(text("${if (total == 0) 0 else offset + 1}–${(offset + limit).coerceAtMost(total)} / $total", 13f))
        val row = LinearLayout(activity)
        row.addView(button(tr("上页", "Previous page")) { move((offset - limit).coerceAtLeast(0)) }.apply { isEnabled = offset > 0 })
        row.addView(button(tr("下页", "Next page")) { move(offset + limit) }.apply { isEnabled = offset + limit < total })
        root.addView(row)
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
            parent.addView(button(title) { navigate("/book/${android.net.Uri.encode(id)}") })
        }
    }

    private fun calendar(data: JSONObject) {
        root.addView(text(tr("月历", "Calendar") + " · " + data.getString("month"), 22f))
        controls(root, listOf(tr("上月", "Previous month") to { shiftMonth(-1) }, tr("下月", "Next month") to { shiftMonth(1) }))
        val header = LinearLayout(activity)
        (1..7).forEach {
            header.addView(text(it.toString()).apply { gravity = android.view.Gravity.CENTER }, LinearLayout.LayoutParams(0, -2, 1f))
        }
        root.addView(header)
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
                        button(
                            d.getString("day").takeLast(2) + "\n" + duration(d.getDouble("seconds")),
                        ) { load(d.getString("day")) }.apply {
                            minWidth =
                                0
                            ; minimumWidth = 0
                            textSize = 12f
                            setPadding(0, dp(4), 0, dp(4))
                            contentDescription =
                                d.getString("day") + ": " + duration(d.getDouble("seconds"))
                        }
                    }
                row.addView(cell, LinearLayout.LayoutParams(0, -2, 1f))
            }
            root.addView(row)
        }
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
        action: (String) -> Unit,
    ) {
        if (options.isEmpty()) return
        dialog?.dismiss()
        dialog =
            AlertDialog
                .Builder(
                    activity,
                ).setItems(options.toTypedArray()) { _, index -> action(options[index]) }
                .setNegativeButton(tr("取消", "Cancel"), null)
                .show()
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
        private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = ink }

        init {
            contentDescription =
                tr("年度阅读日历，具体日期可通过月历或选择日期查看。", "Year reading calendar; use month/day controls for accessible day details.")
        }

        override fun onDraw(canvas: Canvas) {
            super.onDraw(canvas)
            val size = dp(9).toFloat()
            for (x in 0 until columns.length()) {
                val column = columns.getJSONArray(x)
                for (y in 0 until column.length()) {
                    if (!column.isNull(y)) {
                        val seconds = column.getJSONObject(y).getDouble("seconds")
                        paint.alpha =
                            if (seconds <= 0) {
                                25
                            } else if (seconds < 60) {
                                85
                            } else if (seconds < current.getInt("goalMinutes") * 60) {
                                165
                            } else {
                                255
                            }
                        canvas.drawRect(x * size + 1, y * size + 1, (x + 1) * size - 1, (y + 1) * size - 1, paint)
                    }
                }
            }
        }
    }

    private fun showDay(day: JSONObject) {
        val form = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }
        form.addView(text(day.getString("day") + " · " + duration(day.getDouble("seconds")), 22f))
        val books = day.getJSONArray("books")
        for (i in 0 until books.length()) addBook(form, books.getJSONObject(i))
        val offset = day.getInt("offset")
        val limit = day.getInt("limit")
        val total = day.getInt("totalBooks")
        form.addView(text("${if (total == 0) 0 else offset + 1}–${(offset + limit).coerceAtMost(total)} / $total"))
        val pager = LinearLayout(activity)
        pager.addView(
            button(tr("上页", "Previous page")) { load(day.getString("day"), (offset - limit).coerceAtLeast(0)) }.apply {
                isEnabled =
                    offset > 0
            },
        )
        pager.addView(
            button(tr("下页", "Next page")) { load(day.getString("day"), offset + limit) }.apply {
                isEnabled =
                    offset + limit < total
            },
        )
        form.addView(pager)
        dialog?.dismiss()
        dialog =
            AlertDialog
                .Builder(
                    activity,
                ).setView(ScrollView(activity).apply { addView(form) })
                .setPositiveButton(tr("关闭", "Close"), null)
                .show()
    }

    private fun editGoal() {
        val input =
            EditText(activity).apply {
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
        val alert =
            AlertDialog
                .Builder(
                    activity,
                ).setTitle(
                    tr("每日目标（0 为不设目标）", "Daily goal (0 disables goal)"),
                ).setView(form)
                .setNegativeButton(tr("取消", "Cancel"), null)
                .setNeutralButton(tr("核对恢复", "Recovery"), null)
                .setPositiveButton(tr("保存", "Save"), null)
                .create()
        dialog = alert
        alert.setCanceledOnTouchOutside(false)
        alert.setOnShowListener {
            alert.getButton(AlertDialog.BUTTON_NEUTRAL).setOnClickListener { if (!saving) recoverSettings() }
            alert.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                if (saving) return@setOnClickListener
                val value = input.text.toString().toIntOrNull()
                if (value == null || value !in 0..1440) {
                    error.text = "invalid_setting_value"
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
