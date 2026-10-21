package io.pagewise.reader

import android.content.Context
import android.graphics.Typeface
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.method.LinkMovementMethod
import android.text.style.ClickableSpan
import android.text.style.URLSpan
import android.view.View
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
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

    private fun dp(n: Int) = (n * context.resources.displayMetrics.density).toInt()

    fun render(markdown: String): View {
        headings.clear()
        val result =
            LinearLayout(context).apply {
                orientation = LinearLayout.VERTICAL
                setBackgroundColor(this@NativeManualRenderer.background)
            }
        var node: Node? = parser.parse(markdown).firstChild
        while (node != null) {
            val current = node
            val text =
                TextView(context).apply {
                    setTextColor(this@NativeManualRenderer.foreground)
                    setLinkTextColor(this@NativeManualRenderer.foreground)
                    setTextIsSelectable(true)
                    setPadding(dp(4), dp(8), dp(4), dp(8))
                    setLineSpacing(dp(4).toFloat(), 1.12f)
                    textSize = 17f
                }
            when (current) {
                is Heading -> {
                    text.text = plain.render(current).trim()
                    text.textSize =
                        when (current.level) {
                            1 -> 27f
                            2 -> 23f
                            else -> 20f
                        }
                    text.setTypeface(null, Typeface.BOLD)
                    text.setPadding(dp(4), dp(20), dp(4), dp(8))
                    text.accessibilityHeadingCompat()
                    val slug =
                        text.text
                            .toString()
                            .lowercase(
                                Locale.ROOT,
                            ).replace(Regex("[^\\p{L}\\p{N}\\s_-]"), "")
                            .trim()
                            .replace(Regex("\\s+"), "-")
                    var unique = slug
                    var suffix = 1
                    while (headings.containsKey(unique)) unique = "$slug-${suffix++}"
                    headings[unique] = text
                }

                is FencedCodeBlock -> {
                    text.text = current.literal.trimEnd()
                    text.typeface = Typeface.MONOSPACE
                    text.textSize = 14f
                }

                is IndentedCodeBlock -> {
                    text.text = current.literal.trimEnd()
                    text.typeface = Typeface.MONOSPACE
                    text.textSize = 14f
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
                }
            }
            result.addView(text, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
            node = current.next
        }
        return result
    }

    fun scrollToAnchor(
        scroll: ScrollView,
        encodedAnchor: String,
    ) {
        val anchor = android.net.Uri.decode(encodedAnchor.removePrefix("#"))
        val view = headings[anchor] ?: return
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
