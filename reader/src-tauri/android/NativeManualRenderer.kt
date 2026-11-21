package io.pagewise.reader

import android.content.Context
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.method.LinkMovementMethod
import android.text.style.ClickableSpan
import android.text.style.URLSpan
import android.view.Gravity
import android.view.View
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TableLayout
import android.widget.TableRow
import android.widget.TextView
import org.commonmark.node.BlockQuote
import org.commonmark.node.FencedCodeBlock
import org.commonmark.node.Heading
import org.commonmark.node.IndentedCodeBlock
import org.commonmark.node.Node
import org.commonmark.parser.Parser
import org.commonmark.renderer.html.HtmlRenderer
import org.commonmark.renderer.text.TextContentRenderer
import java.util.Locale

/** Packaged, offline Markdown rendered as native text widgets; never executes HTML or fetches URLs. */
internal class NativeManualRenderer(
    private val context: Context,
    private val foreground: Int,
    private val background: Int,
    private val compact: Boolean = false,
    private val link: (String) -> Unit,
) {
    private val parser = Parser.builder().build()
    private val html =
        HtmlRenderer
            .builder()
            .escapeHtml(true)
            .sanitizeUrls(true)
            .build()
    private val plain = TextContentRenderer.builder().build()
    private val headings = mutableMapOf<String, View>()

    private sealed class Segment {
        data class Markdown(val raw: String) : Segment()
        data class Table(val headers: List<String>, val rows: List<List<String>>) : Segment()
    }

    private fun dp(n: Int) = (n * context.resources.displayMetrics.density).toInt()

    private fun splitPipeRow(line: String): List<String>? {
        val trimmed = line.trim()
        if (!trimmed.contains('|')) return null
        val core = trimmed.removePrefix("|").removeSuffix("|")
        val cells = core.split('|').map { it.trim() }
        return if (cells.size >= 2) cells else null
    }

    private fun isSeparatorRow(line: String, expectedCols: Int): Boolean {
        val cells = splitPipeRow(line) ?: return false
        if (cells.size != expectedCols) return false
        return cells.all { Regex("^:?-{2,}:?$").matches(it) }
    }

    private fun splitTables(markdown: String): List<Segment> {
        val lines = markdown.replace("\r\n", "\n").split('\n')
        val out = mutableListOf<Segment>()
        val mdBuf = StringBuilder()
        var inFence = false
        var i = 0
        fun flushMd() {
            if (mdBuf.isNotEmpty()) {
                out.add(Segment.Markdown(mdBuf.toString()))
                mdBuf.clear()
            }
        }
        while (i < lines.size) {
            val line = lines[i]
            val trimmed = line.trimStart()
            if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
                inFence = !inFence
                mdBuf.append(line).append('\n')
                i++
                continue
            }
            if (!inFence && i + 1 < lines.size) {
                val headers = splitPipeRow(line)
                if (headers != null && isSeparatorRow(lines[i + 1], headers.size)) {
                    flushMd()
                    val rows = mutableListOf<List<String>>()
                    i += 2
                    while (i < lines.size) {
                        val row = splitPipeRow(lines[i]) ?: break
                        val normalized = List(headers.size) { col -> row.getOrElse(col) { "" } }
                        rows.add(normalized)
                        i++
                    }
                    out.add(Segment.Table(headers, rows))
                    continue
                }
            }
            mdBuf.append(line).append('\n')
            i++
        }
        flushMd()
        return out
    }

    private fun safeInline(raw: String): CharSequence {
        val parsed = parser.parse(raw)
        val spanned = android.text.Html.fromHtml(html.render(parsed), android.text.Html.FROM_HTML_MODE_LEGACY)
        val safe = SpannableStringBuilder(spanned)
        for (span in safe.getSpans(0, safe.length, URLSpan::class.java)) {
            val start = safe.getSpanStart(span)
            val end = safe.getSpanEnd(span)
            val href = span.url
            safe.removeSpan(span)
            safe.setSpan(
                object : ClickableSpan() {
                    override fun onClick(widget: View) = link(href)
                },
                start,
                end,
                Spanned.SPAN_EXCLUSIVE_EXCLUSIVE,
            )
        }
        return safe.trimEnd()
    }

    private fun renderTable(headers: List<String>, rows: List<List<String>>): View {
        val divider = NativeUi.divider(background)
        val headerBg = NativeUi.mutedSurface(background)
        val cellBg = NativeUi.surface(background)
        val borderColor = NativeUi.border(this@NativeManualRenderer.background)
        val colCount = headers.size.coerceAtLeast(1)
        if (colCount <= 4) {
            val tableLayout =
                TableLayout(context).apply {
                    isStretchAllColumns = true
                    isShrinkAllColumns = true
                    background =
                        GradientDrawable().apply {
                            setColor(cellBg)
                            setStroke(dp(1), borderColor)
                            cornerRadius = 0f
                        }
                    setPadding(0, dp(2), 0, dp(2))
                }
            fun buildWrapRow(cells: List<String>, isHeader: Boolean): TableRow {
                val row =
                    TableRow(context).apply {
                        if (isHeader) setBackgroundColor(headerBg)
                    }
                cells.forEachIndexed { idx, cellText ->
                    val cellBgDrawable =
                        GradientDrawable().apply {
                            setColor(if (isHeader) headerBg else cellBg)
                            if (idx > 0) setStroke(dp(1), divider)
                        }
                    val tv =
                        TextView(context).apply {
                            text = safeInline(cellText)
                            textSize = if (compact) 13.5f else 14.5f
                            setTextColor(this@NativeManualRenderer.foreground)
                            setLinkTextColor(this@NativeManualRenderer.foreground)
                            movementMethod = LinkMovementMethod.getInstance()
                            fontFeatureSettings = "tnum"
                            setLineSpacing(dp(2).toFloat(), 1.35f)
                            setPadding(dp(8), dp(8), dp(8), dp(8))
                            background = cellBgDrawable
                            if (isHeader) setTypeface(null, Typeface.BOLD)
                        }
                    row.addView(tv, TableRow.LayoutParams(0, TableRow.LayoutParams.MATCH_PARENT, 1f))
                }
                return row
            }
            tableLayout.addView(buildWrapRow(headers, isHeader = true))
            rows.forEach { rowCells ->
                tableLayout.addView(
                    View(context).apply { setBackgroundColor(borderColor) },
                    TableLayout.LayoutParams(TableLayout.LayoutParams.MATCH_PARENT, dp(1)),
                )
                tableLayout.addView(buildWrapRow(rowCells, isHeader = false))
            }
            return LinearLayout(context).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(0, dp(6), 0, dp(8))
                addView(tableLayout, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
            }
        }
        val colMinPx = dp(96)
        val table =
            LinearLayout(context).apply {
                orientation = LinearLayout.VERTICAL
                background =
                    GradientDrawable().apply {
                        setColor(cellBg)
                        setStroke(dp(1), borderColor)
                        cornerRadius = 0f
                    }
            }

        fun buildRow(cells: List<String>, isHeader: Boolean): LinearLayout {
            val row =
                LinearLayout(context).apply {
                    orientation = LinearLayout.HORIZONTAL
                    if (isHeader) setBackgroundColor(headerBg)
                }
            cells.forEachIndexed { idx, cellText ->
                val tv =
                    TextView(context).apply {
                        text = safeInline(cellText)
                        textSize = if (compact) 13.5f else 14.5f
                        setTextColor(this@NativeManualRenderer.foreground)
                        setLinkTextColor(this@NativeManualRenderer.foreground)
                        movementMethod = LinkMovementMethod.getInstance()
                        fontFeatureSettings = "tnum"
                        setLineSpacing(dp(2).toFloat(), 1.35f)
                        setPadding(dp(10), dp(8), dp(10), dp(8))
                        minWidth = colMinPx
                        if (isHeader) setTypeface(null, Typeface.BOLD)
                    }
                row.addView(tv, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.MATCH_PARENT, 1f))
                if (idx < cells.lastIndex) {
                    row.addView(
                        View(context).apply { setBackgroundColor(divider) },
                        LinearLayout.LayoutParams(dp(1), LinearLayout.LayoutParams.MATCH_PARENT),
                    )
                }
            }
            return row
        }

        table.addView(buildRow(headers, isHeader = true))
        rows.forEach { rowCells ->
            table.addView(
                View(context).apply { setBackgroundColor(borderColor) },
                LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(1)),
            )
            table.addView(buildRow(rowCells, isHeader = false))
        }
        return NativeUi.configureEinkHorizontalScroll(
            HorizontalScrollView(context).apply {
                isHorizontalScrollBarEnabled = true
                setPadding(0, dp(6), 0, dp(8))
                addView(table, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT))
            },
        )
    }

    fun render(markdown: String): View {
        headings.clear()
        val result =
            LinearLayout(context).apply {
                orientation = LinearLayout.VERTICAL
                setBackgroundColor(this@NativeManualRenderer.background)
            }
        for (segment in splitTables(markdown)) {
            when (segment) {
                is Segment.Table -> {
                    result.addView(
                        renderTable(segment.headers, segment.rows),
                        LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT),
                    )
                }

                is Segment.Markdown -> {
                    var node: Node? = parser.parse(segment.raw).firstChild
                    while (node != null) {
                        val current = node
                        val text =
                            TextView(context).apply {
                                setTextColor(this@NativeManualRenderer.foreground)
                                setLinkTextColor(this@NativeManualRenderer.foreground)
                                setTextIsSelectable(true)
                                setPadding(
                                    if (compact) 0 else dp(4),
                                    dp(if (compact) 4 else 8),
                                    if (compact) 0 else dp(4),
                                    dp(if (compact) 4 else 8),
                                )
                                if (compact) {
                                    typeface = NativeUi.editorialTypeface(false)
                                    setLineSpacing(dp(2).toFloat(), 1.35f)
                                    textSize = 15f
                                } else {
                                    setLineSpacing(dp(4).toFloat(), 1.45f)
                                    textSize = 17f
                                }
                            }
                        when (current) {
                            is Heading -> {
                                text.text = plain.render(current).trim()
                                text.textSize =
                                    if (compact) {
                                        when (current.level) {
                                            1 -> 19f
                                            2 -> 17f
                                            else -> 15.5f
                                        }
                                    } else {
                                        when (current.level) {
                                            1 -> 27f
                                            2 -> 23f
                                            else -> 20f
                                        }
                                    }
                                text.setTypeface(if (compact) NativeUi.editorialTypeface(true) else null, Typeface.BOLD)
                                text.setPadding(
                                    if (compact) 0 else dp(4),
                                    dp(if (compact) 10 else 20),
                                    if (compact) 0 else dp(4),
                                    dp(if (compact) 4 else 8),
                                )
                                text.accessibilityHeadingCompat()
                                val slug =
                                    text.text
                                        .toString()
                                        .lowercase(Locale.ROOT)
                                        .replace(Regex("[^\\p{L}\\p{N}\\s_-]"), "")
                                        .trim()
                                        .replace(Regex("\\s+"), "-")
                                var unique = slug
                                var suffix = 1
                                while (headings.containsKey(unique)) unique = "$slug-${suffix++}"
                                headings[unique] = text
                                result.addView(text, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
                            }

                            is FencedCodeBlock -> {
                                text.text = current.literal.trimEnd()
                                text.typeface = NativeUi.monoTypeface(false)
                                text.fontFeatureSettings = "tnum"
                                text.textSize = 14f
                                text.setPadding(dp(12), dp(10), dp(12), dp(10))
                                text.background =
                                    GradientDrawable().apply {
                                        setColor(NativeUi.mutedSurface(this@NativeManualRenderer.background))
                                        setStroke(dp(1), NativeUi.divider(this@NativeManualRenderer.background))
                                        cornerRadius = 0f
                                    }
                                result.addView(
                                    text,
                                    LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
                                        topMargin = dp(4)
                                        bottomMargin = dp(6)
                                    },
                                )
                            }

                            is IndentedCodeBlock -> {
                                text.text = current.literal.trimEnd()
                                text.typeface = NativeUi.monoTypeface(false)
                                text.fontFeatureSettings = "tnum"
                                text.textSize = 14f
                                text.setPadding(dp(12), dp(10), dp(12), dp(10))
                                text.background =
                                    GradientDrawable().apply {
                                        setColor(NativeUi.mutedSurface(this@NativeManualRenderer.background))
                                        setStroke(dp(1), NativeUi.divider(this@NativeManualRenderer.background))
                                        cornerRadius = 0f
                                    }
                                result.addView(
                                    text,
                                    LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
                                        topMargin = dp(4)
                                        bottomMargin = dp(6)
                                    },
                                )
                            }

                            is BlockQuote -> {
                                val quoteRow =
                                    LinearLayout(context).apply {
                                        orientation = LinearLayout.HORIZONTAL
                                        gravity = Gravity.CENTER_VERTICAL
                                        setBackgroundColor(NativeUi.mutedSurface(this@NativeManualRenderer.background))
                                    }
                                quoteRow.addView(
                                    View(context).apply { setBackgroundColor(this@NativeManualRenderer.foreground) },
                                    LinearLayout.LayoutParams(dp(3), LinearLayout.LayoutParams.MATCH_PARENT),
                                )
                                text.text = safeInline(plain.render(current))
                                text.typeface = NativeUi.editorialTypeface(false)
                                text.setPadding(dp(12), dp(8), dp(10), dp(8))
                                text.movementMethod = LinkMovementMethod.getInstance()
                                quoteRow.addView(text, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
                                result.addView(
                                    quoteRow,
                                    LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
                                        topMargin = dp(4)
                                        bottomMargin = dp(6)
                                    },
                                )
                            }

                            else -> {
                                val spanned = android.text.Html.fromHtml(html.render(current), android.text.Html.FROM_HTML_MODE_LEGACY)
                                val safe = SpannableStringBuilder(spanned)
                                for (span in safe.getSpans(0, safe.length, URLSpan::class.java)) {
                                    val start = safe.getSpanStart(span)
                                    val end = safe.getSpanEnd(span)
                                    val href = span.url
                                    safe.removeSpan(span)
                                    safe.setSpan(
                                        object : ClickableSpan() {
                                            override fun onClick(widget: View) = link(href)
                                        },
                                        start,
                                        end,
                                        Spanned.SPAN_EXCLUSIVE_EXCLUSIVE,
                                    )
                                }
                                text.text = safe.trimEnd()
                                text.movementMethod = LinkMovementMethod.getInstance()
                                result.addView(text, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
                            }
                        }
                        node = current.next
                    }
                }
            }
        }
        return result
    }

    fun scrollToAnchor(
        scroll: ScrollView,
        encodedAnchor: String,
    ) {
        val raw = android.net.Uri.decode(encodedAnchor.removePrefix("#"))
        val normalized =
            raw
                .lowercase(Locale.ROOT)
                .replace(Regex("[^\\p{L}\\p{N}\\s_-]"), "")
                .trim()
                .replace(Regex("\\s+"), "-")
        val view = headings[raw] ?: headings[normalized] ?: headings.entries.firstOrNull { it.key.contains(normalized) }?.value ?: return
        scroll.post {
            val target = IntArray(2)
            val viewport = IntArray(2)
            view.getLocationInWindow(target)
            scroll.getLocationInWindow(viewport)
            scroll.scrollTo(0, (scroll.scrollY + target[1] - viewport[1]).coerceAtLeast(0))
            view.requestFocus()
        }
    }

    private fun View.accessibilityHeadingCompat() {
        if (android.os.Build.VERSION.SDK_INT >= 28) isAccessibilityHeading = true
    }
}
