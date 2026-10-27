package io.pagewise.reader

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.StateListDrawable
import android.text.SpannableString
import android.text.Spanned
import android.text.style.RelativeSizeSpan
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

internal class NativeStatsSettingsUi(
    private val context: Context,
    val ink: Int,
    val paper: Int,
) {
    private val dark = ink == Color.WHITE
    val primary = if (dark) Color.WHITE else Color.BLACK
    val body = Color.parseColor(if (dark) "#EEEEEE" else "#111111")
    val secondary = Color.parseColor(if (dark) "#CCCCCC" else "#444444")
    val hairline = Color.parseColor(if (dark) "#555555" else "#BBBBBB")
    val sunkenSurface = Color.parseColor(if (dark) "#222222" else "#EEEEEE")
    val selectedSurface = Color.parseColor(if (dark) "#333333" else "#DDDDDD")

    fun dp(value: Int) = NativeUi.dp(context, value)

    fun text(
        value: String,
        size: Float = 16f,
        strong: Boolean = false,
    ): TextView =
        TextView(context).apply {
            text = value
            textSize = size
            setTextColor(if (strong) primary else body)
            typeface =
                if (strong && android.os.Build.VERSION.SDK_INT >= 28) Typeface.create(Typeface.DEFAULT, 500, false) else Typeface.DEFAULT
            setPadding(0, dp(6), 0, dp(6))
            if (android.os.Build.VERSION.SDK_INT >= 28) lineHeight = (size * resources.displayMetrics.scaledDensity * 1.5f).toInt()
        }

    fun field() =
        android.widget.EditText(context).apply {
            textSize = 16f
            minimumHeight = dp(56)
            minimumWidth = dp(48)
            setTextColor(body)
            setHintTextColor(secondary)
            backgroundTintList = ColorStateList.valueOf(primary)
            setPadding(dp(12), dp(12), dp(12), dp(12))
        }

    fun note(value: String) = text(value, 13f).apply { setTextColor(secondary) }

    fun heading(value: String) =
        text(value, 18f, true).apply {
            typeface = NativeUi.editorialTypeface(true)
        }

    fun column() = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }

    fun metric(
        value: String,
        label: String,
    ): View =
        column().apply {
            addView(
                note("EX LIBRIS · $label").apply {
                    typeface = NativeUi.monoTypeface(true)
                    fontFeatureSettings = "tnum"
                },
            )
            addView(
                text(value, 36f).apply {
                    typeface = NativeUi.editorialTypeface(true)
                    fontFeatureSettings = "'tnum' 1"
                    text =
                        SpannableString(value).apply {
                            Regex("\\b(?:h|min|s)\\b").findAll(value).forEach {
                                setSpan(RelativeSizeSpan(.45f), it.range.first, it.range.last + 1, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                            }
                        }
                    contentDescription = "$label: $value"
                },
            )
        }

    fun factBox(
        title: String,
        value: String,
        hint: String = "",
    ): View =
        column().apply {
            background = shape(paper, hairline, 1)
            setPadding(dp(12), dp(10), dp(12), dp(10))
            addView(
                note(title).apply {
                    textSize = 11f
                    typeface = NativeUi.monoTypeface(true)
                    fontFeatureSettings = "tnum"
                    setPadding(0, 0, 0, dp(2))
                },
            )
            addView(
                text(value, 20f, true).apply {
                    typeface = NativeUi.editorialTypeface(true)
                    fontFeatureSettings = "tnum"
                    setPadding(0, 0, 0, dp(2))
                },
            )
            if (hint.isNotEmpty()) {
                addView(
                    note(hint).apply {
                        textSize = 11f
                        typeface = NativeUi.monoTypeface(false)
                        setPadding(0, 0, 0, 0)
                    },
                )
            }
        }

    fun shape(
        fill: Int,
        stroke: Int,
        width: Int = 1,
    ) = GradientDrawable().apply {
        setColor(fill)
        cornerRadius = 0f
        setStroke(dp(width), stroke)
    }

    private fun states(
        selected: Boolean,
        outlined: Boolean,
    ) = StateListDrawable().apply {
        addState(intArrayOf(-android.R.attr.state_enabled), shape(selectedSurface, secondary))
        addState(intArrayOf(android.R.attr.state_pressed), shape(primary, primary, 2))
        addState(intArrayOf(android.R.attr.state_focused), shape(if (selected) selectedSurface else paper, primary, 2))
        addState(intArrayOf(), shape(if (selected) selectedSurface else paper, if (outlined || selected) secondary else paper))
    }

    fun decorate(
        view: View,
        selected: Boolean = false,
        outlined: Boolean = true,
    ) {
        view.background = states(selected, outlined)
        view.elevation = 0f
        view.stateListAnimator = null
        view.isSelected = selected
        if (view is TextView) {
            view.setTextColor(
                ColorStateList(
                    arrayOf(intArrayOf(-android.R.attr.state_enabled), intArrayOf(android.R.attr.state_pressed), intArrayOf()),
                    intArrayOf(secondary, paper, primary),
                ),
            )
        }
    }

    fun button(
        label: String,
        selected: Boolean = false,
        click: () -> Unit,
    ): Button =
        NativeUi.button(context, label, ink, paper, click).apply {
            textSize = 16f
            minimumHeight = dp(56)
            minHeight = dp(56)
            maxLines = Int.MAX_VALUE
            setPadding(dp(12), dp(8), dp(12), dp(8))
            decorate(this, selected)
        }

    fun card(
        title: String? = null,
        emphatic: Boolean = false,
    ): LinearLayout =
        column().apply {
            setPadding(dp(20), dp(16), dp(20), dp(16))
            if (emphatic) {
                val outer = shape(paper, primary, 2)
                val inner = shape(paper, hairline, 1)
                val inset = dp(3)
                background =
                    android.graphics.drawable.LayerDrawable(arrayOf(outer, inner)).apply {
                        setLayerInset(1, inset, inset, inset, inset)
                    }
            } else {
                background = shape(paper, primary, 1)
            }
            layoutParams = ViewGroup.MarginLayoutParams(-1, -2).apply { bottomMargin = dp(20) }
            if (title != null) addView(heading(title))
        }

    fun settingRow(
        label: String,
        summary: String,
        click: () -> Unit,
    ): View =
        ScopedSettingRow(context).apply {
            minimumHeight = dp(72)
            setPadding(dp(12), dp(12), dp(12), dp(12))
            addView(text(label, 16f, true))
            addView(note(summary.ifBlank { "—" }))
            for (i in 0 until childCount) {
                (getChildAt(i) as? TextView)?.apply {
                    isDuplicateParentStateEnabled = true
                    setTextColor(
                        ColorStateList(
                            arrayOf(intArrayOf(-android.R.attr.state_enabled), intArrayOf(android.R.attr.state_pressed), intArrayOf()),
                            intArrayOf(
                                secondary,
                                paper,
                                if (i ==
                                    0
                                ) {
                                    primary
                                } else {
                                    secondary
                                },
                            ),
                        ),
                    )
                }
            }
            isClickable = true
            isFocusable = true
            contentDescription = "$label: $summary"
            decorate(this, outlined = false)
            setOnClickListener { click() }
        }

    private class ScopedSettingRow(
        context: Context,
    ) : LinearLayout(context) {
        override fun onMeasure(
            widthMeasureSpec: Int,
            heightMeasureSpec: Int,
        ) {
            val width = MeasureSpec.getSize(widthMeasureSpec)
            val stacked = width < NativeUi.dp(context, (480 * resources.configuration.fontScale).toInt())
            orientation = if (stacked) VERTICAL else HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            if (childCount == 2) {
                getChildAt(0).layoutParams = if (stacked) LayoutParams(-1, -2) else LayoutParams(0, -2, 1f)
                getChildAt(1).layoutParams = LayoutParams(if (stacked) -1 else -2, -2)
                (getChildAt(1) as TextView).maxWidth = if (stacked) Int.MAX_VALUE else width / 2
            }
            super.onMeasure(widthMeasureSpec, heightMeasureSpec)
        }
    }
}

internal class NativeSettingsUiState {
    var requested: String? = null
    var group = "general"
    var directory = true
    val positions = mutableMapOf<String, Int>()
}

internal class NativeSettingsPageLayout(
    context: Context,
    private val navigation: View,
    private val content: View,
) : ViewGroup(context) {
    var directory: Boolean = true
        set(value) {
            field = value
            requestLayout()
        }
    var wide: Boolean = false
        private set
    var onWideChanged: ((Boolean) -> Unit)? = null

    init {
        addView(navigation)
        addView(content)
    }

    fun scrollActive(direction: Int): Boolean =
        ((if (directory && !wide) navigation else content) as? ScrollView)?.pageScroll(direction) == true

    override fun onMeasure(
        widthMeasureSpec: Int,
        heightMeasureSpec: Int,
    ) {
        val width = MeasureSpec.getSize(widthMeasureSpec)
        val height =
            if (MeasureSpec.getMode(heightMeasureSpec) ==
                MeasureSpec.UNSPECIFIED
            ) {
                resources.displayMetrics.heightPixels
            } else {
                MeasureSpec.getSize(heightMeasureSpec)
            }
        // The controller keeps 24dp insets on either side of the 960dp window breakpoint.
        wide = width >= NativeUi.dp(context, 912)
        onWideChanged?.invoke(wide)
        navigation.visibility = if (wide || directory) View.VISIBLE else View.GONE
        content.visibility = if (wide || !directory) View.VISIBLE else View.GONE
        val navWidth = if (wide) NativeUi.dp(context, 232) else width
        if (navigation.visibility ==
            View.VISIBLE
        ) {
            navigation.measure(
                MeasureSpec.makeMeasureSpec(navWidth, MeasureSpec.EXACTLY),
                MeasureSpec.makeMeasureSpec(height, MeasureSpec.EXACTLY),
            )
        }
        val contentWidth = if (wide) (width - navWidth - NativeUi.dp(context, 24)).coerceAtLeast(0) else width
        if (content.visibility ==
            View.VISIBLE
        ) {
            content.measure(
                MeasureSpec.makeMeasureSpec(contentWidth, MeasureSpec.EXACTLY),
                MeasureSpec.makeMeasureSpec(height, MeasureSpec.EXACTLY),
            )
        }
        setMeasuredDimension(width, height)
    }

    override fun onLayout(
        changed: Boolean,
        left: Int,
        top: Int,
        right: Int,
        bottom: Int,
    ) {
        if (navigation.visibility == View.VISIBLE) navigation.layout(0, 0, navigation.measuredWidth, height)
        if (content.visibility == View.VISIBLE) {
            val x = if (wide) navigation.measuredWidth + NativeUi.dp(context, 24) else 0
            content.layout(x, 0, width, height)
        }
    }
}

internal class NativeStatsSettingsDialog(
    activity: Activity,
    title: String,
    content: View,
    ui: NativeStatsSettingsUi,
    captions: List<Pair<Int, String>>,
) : AlertDialog(activity) {
    private val paper = ui.paper
    private val actions =
        captions.associate { (which, caption) ->
            which to
                ui.button(caption) { if (which == BUTTON_NEGATIVE) dismiss() }.apply {
                    id =
                        when (which) {
                            BUTTON_POSITIVE -> android.R.id.button1
                            BUTTON_NEGATIVE -> android.R.id.button2
                            else -> android.R.id.button3
                        }
                }
        }

    init {
        val body =
            ScrollView(activity).apply {
                isFillViewport = false
                addView(
                    ui.column().apply {
                        setPadding(ui.dp(16), ui.dp(8), ui.dp(16), ui.dp(8))
                        addView(ui.heading(title))
                        addView(content)
                    },
                )
            }
        val footer =
            NativeActionFlow(activity).apply {
                setPadding(ui.dp(12), ui.dp(8), ui.dp(12), ui.dp(8))
                actions.values.forEach { addView(it) }
            }
        setView(BoundedDialogContent(activity, body, footer))
        setCanceledOnTouchOutside(false)
    }

    override fun getButton(whichButton: Int): Button? = actions[whichButton] ?: super.getButton(whichButton)

    override fun onStart() {
        super.onStart()
        window?.setWindowAnimations(0)
        window?.setDimAmount(0f)
        window?.setBackgroundDrawable(android.graphics.drawable.ColorDrawable(paper))
    }

    private class BoundedDialogContent(
        context: Context,
        private val body: View,
        private val footer: View,
    ) : ViewGroup(context) {
        init {
            addView(body)
            addView(footer)
        }

        override fun onMeasure(
            widthMeasureSpec: Int,
            heightMeasureSpec: Int,
        ) {
            val width = resolveSize(resources.displayMetrics.widthPixels, widthMeasureSpec)
            val limit =
                if (MeasureSpec.getMode(heightMeasureSpec) ==
                    MeasureSpec.UNSPECIFIED
                ) {
                    (resources.displayMetrics.heightPixels * .8f).toInt()
                } else {
                    MeasureSpec.getSize(heightMeasureSpec)
                }
            val childWidth = MeasureSpec.makeMeasureSpec((width - paddingLeft - paddingRight).coerceAtLeast(0), MeasureSpec.EXACTLY)
            val available = (limit - paddingTop - paddingBottom).coerceAtLeast(0)
            footer.measure(childWidth, MeasureSpec.makeMeasureSpec(available, MeasureSpec.AT_MOST))
            body.measure(childWidth, MeasureSpec.makeMeasureSpec((available - footer.measuredHeight).coerceAtLeast(0), MeasureSpec.AT_MOST))
            setMeasuredDimension(
                width,
                resolveSize(body.measuredHeight + footer.measuredHeight + paddingTop + paddingBottom, heightMeasureSpec),
            )
        }

        override fun onLayout(
            changed: Boolean,
            left: Int,
            top: Int,
            right: Int,
            bottom: Int,
        ) {
            val footerTop = (height - paddingBottom - footer.measuredHeight).coerceAtLeast(paddingTop)
            body.layout(paddingLeft, paddingTop, width - paddingRight, minOf(paddingTop + body.measuredHeight, footerTop))
            footer.layout(paddingLeft, footerTop, width - paddingRight, footerTop + footer.measuredHeight)
        }
    }
}

internal class NativeStatsResponsive(
    context: Context,
    private val large: View,
    private val small: View,
    private val minWidthDp: Int,
) : ViewGroup(context) {
    init {
        addView(large)
        addView(small)
    }

    override fun onMeasure(
        widthMeasureSpec: Int,
        heightMeasureSpec: Int,
    ) {
        val width = MeasureSpec.getSize(widthMeasureSpec)
        val useLarge = width >= NativeUi.dp(context, (minWidthDp * resources.configuration.fontScale.coerceAtLeast(1f)).toInt())
        large.visibility = if (useLarge) View.VISIBLE else View.GONE
        small.visibility = if (useLarge) View.GONE else View.VISIBLE
        val active = if (useLarge) large else small
        active.measure(MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY), heightMeasureSpec)
        setMeasuredDimension(width, active.measuredHeight)
    }

    override fun onLayout(
        changed: Boolean,
        left: Int,
        top: Int,
        right: Int,
        bottom: Int,
    ) {
        val active = if (large.visibility == View.VISIBLE) large else small
        active.layout(0, 0, width, active.measuredHeight)
    }
}

internal class NativeStatsOverviewLayout(
    context: Context,
) : ViewGroup(context) {
    private var wide = false
    private val gap get() = NativeUi.dp(context, 24)

    init {
        clipToPadding = false
    }

    override fun onMeasure(
        widthMeasureSpec: Int,
        heightMeasureSpec: Int,
    ) {
        val width = MeasureSpec.getSize(widthMeasureSpec)
        wide = width >= NativeUi.dp(context, (912 * resources.configuration.fontScale.coerceAtLeast(1f)).toInt())
        val primaryWidth = if (wide) (width - gap) * 2 / 3 else width
        for (i in 0 until childCount) {
            getChildAt(i).measure(
                MeasureSpec.makeMeasureSpec(
                    if (wide &&
                        i > 0
                    ) {
                        width - primaryWidth - gap
                    } else {
                        primaryWidth
                    },
                    MeasureSpec.EXACTLY,
                ),
                MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED),
            )
        }
        val total =
            if (wide) {
                maxOf(getChildAt(0)?.measuredHeight ?: 0, (1 until childCount).sumOf { getChildAt(it).measuredHeight + gap })
            } else {
                (
                    0 until
                        childCount
                ).sumOf { getChildAt(it).measuredHeight + gap }
            }
        setMeasuredDimension(width, total)
    }

    override fun onLayout(
        changed: Boolean,
        left: Int,
        top: Int,
        right: Int,
        bottom: Int,
    ) {
        var y = 0
        for (i in 0 until childCount) {
            val child = getChildAt(i)
            if (wide && i == 0) {
                child.layout(0, 0, child.measuredWidth, child.measuredHeight)
            } else {
                val x = if (wide) getChildAt(0).measuredWidth + gap else 0
                child.layout(x, y, x + child.measuredWidth, y + child.measuredHeight)
                y += child.measuredHeight + gap
            }
        }
    }
}

internal class NativeStatsGoalRule(
    context: Context,
    private val ui: NativeStatsSettingsUi,
    ratio: Double,
) : View(context) {
    private val fraction = ratio.also { if (!it.isFinite()) throw org.json.JSONException("invalid_goal_ratio") }.coerceIn(0.0, 1.0)
    private val paint = android.graphics.Paint()

    override fun onDraw(canvas: android.graphics.Canvas) {
        super.onDraw(canvas)
        val w = width.toFloat()
        val h = height.toFloat()
        val stroke = ui.dp(1).toFloat().coerceAtLeast(1f)
        paint.style = android.graphics.Paint.Style.FILL
        paint.color = ui.sunkenSurface
        canvas.drawRect(0f, 0f, w, h, paint)
        if (fraction > 0.0) {
            paint.color = ui.primary
            canvas.drawRect(0f, 0f, (w * fraction).toFloat(), h, paint)
        }
        paint.color = ui.hairline
        paint.strokeWidth = stroke
        for (q in intArrayOf(25, 50, 75)) {
            val x = w * (q / 100f)
            canvas.drawLine(x, 0f, x, h, paint)
        }
        paint.style = android.graphics.Paint.Style.STROKE
        paint.color = ui.primary
        paint.strokeWidth = stroke
        val half = stroke / 2f
        canvas.drawRect(half, half, w - half, h - half, paint)
    }
}
