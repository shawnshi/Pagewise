package io.pagewise.reader

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ColorFilter
import android.graphics.Typeface
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.StateListDrawable
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView

/** Monochrome UI primitives; business state and persistence remain with their existing owners. */
internal object NativeUi {
    fun dp(
        context: Context,
        value: Int,
    ) = (value * context.resources.displayMetrics.density + 0.5f).toInt()

    fun surface(background: Int) = nativeEinkPalette(background).background

    fun mutedSurface(background: Int) = nativeEinkPalette(background).surface

    fun border(background: Int) = nativeEinkPalette(background).outline

    fun divider(background: Int) = nativeEinkPalette(background).divider

    fun secondary(background: Int) = nativeEinkPalette(background).secondary

    fun disabled(background: Int) = nativeEinkPalette(background).disabled

    fun shape(
        context: Context,
        background: Int,
        outlined: Boolean = true,
    ): GradientDrawable =
        GradientDrawable().apply {
            setColor(surface(background))
            if (outlined) setStroke(dp(context, 1), border(background))
            cornerRadius = dp(context, 8).toFloat()
        }

    private fun actionable(
        context: Context,
        background: Int,
        selected: Boolean = false,
        outlined: Boolean = true,
    ): StateListDrawable {
        val ink = if (Color.red(background) > 128) Color.BLACK else Color.WHITE
        return StateListDrawable().apply {
            addState(intArrayOf(android.R.attr.state_focused), shape(context, background).apply { setStroke(dp(context, 2), ink) })
            addState(
                intArrayOf(android.R.attr.state_pressed),
                shape(context, background).apply {
                    setColor(mutedSurface(background))
                    setStroke(dp(context, 2), ink)
                },
            )
            addState(intArrayOf(), shape(context, background, outlined).apply { if (selected) setColor(mutedSurface(background)) })
        }
    }

    fun button(
        context: Context,
        value: String,
        ink: Int,
        background: Int,
        click: () -> Unit,
    ): Button =
        Button(context).apply {
            text = value
            contentDescription = value
            textSize = 14f
            isAllCaps = false
            stateListAnimator = null
            elevation = 0f
            includeFontPadding = true
            minWidth = dp(context, 48)
            minimumWidth = dp(context, 48)
            minHeight = dp(context, 48)
            minimumHeight = dp(context, 48)
            maxLines = 2
            ellipsize = TextUtils.TruncateAt.END
            setTextColor(
                android.content.res.ColorStateList(
                    arrayOf(intArrayOf(-android.R.attr.state_enabled), intArrayOf()),
                    intArrayOf(disabled(background), ink),
                ),
            )
            this.background = actionable(context, background)
            setPadding(dp(context, 12), dp(context, 6), dp(context, 12), dp(context, 6))
            setOnClickListener { click() }
        }

    fun glyph(
        context: Context,
        kind: String,
        ink: Int,
        size: Int = 20,
    ): Drawable =
        NativeUiIcon(context, kind, ink).apply {
            setBounds(0, 0, dp(context, size), dp(context, size))
        }

    fun iconTextButton(
        context: Context,
        label: String,
        kind: String,
        ink: Int,
        background: Int,
        click: () -> Unit,
    ): Button =
        button(context, label, ink, background, click).apply {
            val icon = NativeUiIcon(context, kind, ink).apply { setBounds(0, 0, dp(context, 18), dp(context, 18)) }
            setCompoundDrawablesRelative(icon, null, null, null)
            compoundDrawablePadding = dp(context, 6)
        }

    fun primaryButton(
        context: Context,
        label: String,
        ink: Int,
        background: Int,
        click: () -> Unit,
    ): Button =
        button(context, label, surface(background), background, click).apply {
            setTextColor(
                android.content.res.ColorStateList(
                    arrayOf(intArrayOf(-android.R.attr.state_enabled), intArrayOf()),
                    intArrayOf(disabled(background), surface(background)),
                ),
            )
            val fill =
                GradientDrawable().apply {
                    setColor(ink)
                    cornerRadius = dp(context, 4).toFloat()
                }
            this.background =
                StateListDrawable().apply {
                    addState(intArrayOf(-android.R.attr.state_enabled), shape(context, background))
                    addState(
                        intArrayOf(android.R.attr.state_focused),
                        fill.constantState!!.newDrawable().mutate().apply {
                            (this as GradientDrawable).setStroke(dp(context, 2), surface(background))
                        },
                    )
                    addState(intArrayOf(), fill)
                }
        }

    fun bookRowBackground(
        context: Context,
        background: Int,
        reading: Boolean,
    ): Drawable {
        if (reading) return actionable(context, background)
        val fill = shape(context, background, false).apply { cornerRadius = 0f }
        val line = GradientDrawable().apply { setColor(divider(background)) }
        val normal =
            android.graphics.drawable.LayerDrawable(arrayOf(fill, line)).apply {
                setLayerHeight(1, dp(context, 1))
                setLayerGravity(1, Gravity.BOTTOM)
            }
        return StateListDrawable().apply {
            addState(
                intArrayOf(android.R.attr.state_focused),
                shape(context, background).apply {
                    setStroke(
                        dp(context, 2),
                        if (Color.red(background) >
                            128
                        ) {
                            Color.BLACK
                        } else {
                            Color.WHITE
                        },
                    )
                },
            )
            addState(
                intArrayOf(android.R.attr.state_selected),
                shape(context, background).apply {
                    setStroke(
                        dp(context, 2),
                        if (Color.red(background) >
                            128
                        ) {
                            Color.BLACK
                        } else {
                            Color.WHITE
                        },
                    )
                },
            )
            addState(
                intArrayOf(android.R.attr.state_pressed),
                shape(context, background, false).apply { setColor(mutedSurface(background)) },
            )
            addState(intArrayOf(), normal)
        }
    }

    fun iconButton(
        context: Context,
        label: String,
        kind: String,
        ink: Int,
        background: Int,
        click: () -> Unit,
    ): ImageButton =
        ImageButton(context).apply {
            contentDescription = label
            scaleType = ImageView.ScaleType.FIT_XY
            setImageDrawable(NativeUiIcon(context, kind, ink))
            this.background = actionable(context, background, outlined = false)
            setPadding(dp(context, 12), dp(context, 12), dp(context, 12), dp(context, 12))
            minimumWidth = dp(context, 48)
            minimumHeight = dp(context, 48)
            layoutParams = LinearLayout.LayoutParams(dp(context, 48), dp(context, 48))
            setOnClickListener { click() }
        }

    fun navigationItem(
        context: Context,
        label: String,
        page: String,
        selected: Boolean,
        ink: Int,
        background: Int,
        click: () -> Unit,
    ): View =
        LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            minimumHeight = dp(context, 64)
            setPadding(dp(context, 4), dp(context, 5), dp(context, 4), dp(context, 5))
            this.background = actionable(context, background, selected, outlined = false)
            contentDescription = label
            isSelected = selected
            isFocusable = true
            isClickable = true
            accessibilityDelegate =
                object : View.AccessibilityDelegate() {
                    override fun onInitializeAccessibilityNodeInfo(
                        host: View,
                        info: android.view.accessibility.AccessibilityNodeInfo,
                    ) {
                        super.onInitializeAccessibilityNodeInfo(host, info)
                        info.className = Button::class.java.name
                    }
                }
            addView(
                View(context).apply {
                    setBackgroundColor(ink)
                    visibility = if (selected) View.VISIBLE else View.INVISIBLE
                    importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
                },
                LinearLayout.LayoutParams(dp(context, 24), dp(context, 3)).apply { bottomMargin = dp(context, 3) },
            )
            addView(
                ImageView(context).apply {
                    scaleType = ImageView.ScaleType.FIT_XY
                    setImageDrawable(NativeUiIcon(context, if (page == "annotations") "notes" else page, ink, selected))
                    importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
                },
                LinearLayout.LayoutParams(dp(context, 28), dp(context, 28)),
            )
            addView(
                TextView(context).apply {
                    text = label
                    textSize = 14f
                    gravity = Gravity.CENTER
                    setLineSpacing(0f, 1.35f)
                    setTextColor(ink)
                    setTypeface(null, if (selected) Typeface.BOLD else Typeface.NORMAL)
                    importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
                },
                LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT),
            )
            setOnClickListener { click() }
        }

    fun card(
        context: Context,
        background: Int,
        padding: Int = 24,
    ): LinearLayout =
        LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            this.background = shape(context, background)
            setPadding(dp(context, padding), dp(context, padding), dp(context, padding), dp(context, padding))
            layoutParams = LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(context, 16) }
        }

    fun styleTab(
        view: Button,
        selected: Boolean,
        ink: Int,
        background: Int,
    ) {
        view.isSelected = selected
        view.setTypeface(null, if (selected) Typeface.BOLD else Typeface.NORMAL)
        view.background = actionable(view.context, background, selected, outlined = false)
        view.setTextColor(ink)
    }

    fun section(
        context: Context,
        label: String,
        ink: Int,
    ): TextView =
        TextView(context).apply {
            text = label
            textSize = 18f
            setTypeface(null, Typeface.BOLD)
            setTextColor(ink)
            setPadding(0, dp(context, 20), 0, dp(context, 10))
        }

    fun settingRow(
        context: Context,
        label: String,
        value: String,
        ink: Int,
        background: Int,
        click: () -> Unit,
    ): View =
        NativeSettingRow(context).apply {
            setPadding(0, dp(context, 6), 0, dp(context, 6))
            addView(
                TextView(context).apply {
                    text = label
                    textSize = 14f
                    setTextColor(ink)
                    setPadding(0, dp(context, 8), dp(context, 12), dp(context, 8))
                },
            )
            addView(button(context, value.ifEmpty { "—" }, ink, background, click).apply { contentDescription = "$label: $value" })
        }
}

internal class NativeContentColumn(
    context: Context,
) : LinearLayout(context) {
    var maxContentDp: Int = 1200
        set(value) {
            require(value > 0)
            field = value
            requestLayout()
        }

    init {
        orientation = VERTICAL
    }

    override fun onMeasure(
        widthMeasureSpec: Int,
        heightMeasureSpec: Int,
    ) {
        val width = nativeContentWidth(MeasureSpec.getSize(widthMeasureSpec), NativeUi.dp(context, maxContentDp))
        super.onMeasure(MeasureSpec.makeMeasureSpec(width, MeasureSpec.getMode(widthMeasureSpec)), heightMeasureSpec)
    }
}

/** Existing page content and rail switch using measured width; neither child is recreated on resize. */
internal class NativeReferencePane(
    context: Context,
    private val collapseWidthDp: Int = 552,
) : LinearLayout(context) {
    private var stacked: Boolean? = null

    override fun onMeasure(
        widthMeasureSpec: Int,
        heightMeasureSpec: Int,
    ) {
        val stack =
            nativeStackForWidth(
                MeasureSpec.getSize(widthMeasureSpec),
                resources.displayMetrics.density,
                resources.configuration.fontScale,
                collapseWidthDp,
            )
        if (stacked != stack && childCount == 3) {
            stacked = stack
            orientation = if (stack) VERTICAL else HORIZONTAL
            gravity = Gravity.TOP
            getChildAt(0).visibility = if (stack) GONE else VISIBLE
            getChildAt(0).layoutParams =
                LayoutParams(NativeUi.dp(context, 200), LayoutParams.WRAP_CONTENT).apply { marginEnd = NativeUi.dp(context, 20) }
            getChildAt(1).visibility = if (stack) VISIBLE else GONE
            getChildAt(1).layoutParams =
                LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply { bottomMargin = NativeUi.dp(context, 10) }
            getChildAt(2).layoutParams =
                if (stack) {
                    LayoutParams(
                        LayoutParams.MATCH_PARENT,
                        LayoutParams.WRAP_CONTENT,
                    )
                } else {
                    LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f)
                }
        }
        super.onMeasure(widthMeasureSpec, heightMeasureSpec)
    }
}

/** Buttons reflow; horizontal scrolling is reserved explicitly for tabs and category chips. */
internal class NativeActionFlow(
    context: Context,
) : ViewGroup(context) {
    private var rects = emptyList<NativeFlowRect>()
    private val gap = NativeUi.dp(context, 6)
    var centerRows: Boolean = false
        set(value) {
            if (field != value) {
                field = value
                requestLayout()
            }
        }

    override fun generateDefaultLayoutParams() = LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT)

    override fun onMeasure(
        widthMeasureSpec: Int,
        heightMeasureSpec: Int,
    ) {
        val width = MeasureSpec.getSize(widthMeasureSpec)
        val available = (width - paddingLeft - paddingRight).coerceAtLeast(0)
        val visible = (0 until childCount).map { getChildAt(it) }.filter { it.visibility != GONE }
        for (child in visible) {
            child.measure(
                MeasureSpec.makeMeasureSpec(available, MeasureSpec.AT_MOST),
                MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED),
            )
        }
        rects = nativeFlowRects(available, visible.map { NativeFlowSize(it.measuredWidth, it.measuredHeight) }, gap)
        val height = (rects.maxOfOrNull { it.bottom } ?: 0) + paddingTop + paddingBottom
        setMeasuredDimension(resolveSize(width, widthMeasureSpec), resolveSize(height, heightMeasureSpec))
    }

    override fun onLayout(
        changed: Boolean,
        left: Int,
        top: Int,
        right: Int,
        bottom: Int,
    ) {
        val visible = (0 until childCount).map { getChildAt(it) }.filter { it.visibility != GONE }
        val width = (right - left - paddingLeft - paddingRight).coerceAtLeast(0)
        val rowWidths = rects.groupBy { it.top }.mapValues { entry -> entry.value.maxOf { it.right } }
        visible.forEachIndexed { index, child ->
            val rect = rects.getOrNull(index) ?: return@forEachIndexed
            val shift = if (centerRows) ((width - rowWidths.getValue(rect.top)) / 2).coerceAtLeast(0) else 0
            val x = if (layoutDirection == LAYOUT_DIRECTION_RTL) width - rect.right - shift else rect.left + shift
            child.layout(paddingLeft + x, paddingTop + rect.top, paddingLeft + x + rect.right - rect.left, paddingTop + rect.bottom)
        }
    }
}

internal class NativeBookHeading(
    context: Context,
) : LinearLayout(context) {
    private var stacked: Boolean? = null

    override fun onMeasure(
        widthMeasureSpec: Int,
        heightMeasureSpec: Int,
    ) {
        val stack =
            nativeStackForWidth(
                MeasureSpec.getSize(widthMeasureSpec),
                resources.displayMetrics.density,
                resources.configuration.fontScale,
                430,
            )
        if (stacked != stack && childCount == 2) {
            stacked = stack
            orientation = if (stack) VERTICAL else HORIZONTAL
            gravity = Gravity.TOP
            getChildAt(0).layoutParams =
                if (stack) {
                    LayoutParams(
                        LayoutParams.MATCH_PARENT,
                        LayoutParams.WRAP_CONTENT,
                    )
                } else {
                    LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f)
                }
            getChildAt(1).layoutParams =
                LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply {
                    marginStart =
                        if (stack) 0 else NativeUi.dp(context, 16)
                }
        }
        super.onMeasure(widthMeasureSpec, heightMeasureSpec)
    }
}

internal class NativeBookActions(
    context: Context,
) : LinearLayout(context) {
    override fun onMeasure(
        widthMeasureSpec: Int,
        heightMeasureSpec: Int,
    ) {
        val vertical =
            nativeStackForWidth(
                MeasureSpec.getSize(widthMeasureSpec),
                resources.displayMetrics.density,
                resources.configuration.fontScale,
                520,
            )
        orientation = if (vertical) VERTICAL else HORIZONTAL
        gravity = Gravity.CENTER
        super.onMeasure(widthMeasureSpec, heightMeasureSpec)
    }
}

internal class NativeBookHero(
    context: Context,
) : LinearLayout(context) {
    private var stacked: Boolean? = null

    override fun onMeasure(
        widthMeasureSpec: Int,
        heightMeasureSpec: Int,
    ) {
        val narrow =
            nativeStackForWidth(
                MeasureSpec.getSize(widthMeasureSpec),
                resources.displayMetrics.density,
                resources.configuration.fontScale,
                592,
            )
        val stack = childCount < 2 || narrow
        if (stacked != stack && childCount > 0) {
            stacked = stack
            orientation = if (stack) VERTICAL else HORIZONTAL
            gravity = if (stack) Gravity.CENTER_HORIZONTAL else Gravity.TOP
            if (childCount > 1) {
                val cover = getChildAt(0)
                cover.layoutParams =
                    LayoutParams(NativeUi.dp(context, 140), NativeUi.dp(context, 196)).apply {
                        marginEnd = if (stack) 0 else NativeUi.dp(context, 24)
                        bottomMargin = if (stack) NativeUi.dp(context, 16) else 0
                    }
            }
            getChildAt(childCount - 1).layoutParams =
                if (stack) {
                    LayoutParams(
                        LayoutParams.MATCH_PARENT,
                        LayoutParams.WRAP_CONTENT,
                    )
                } else {
                    LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f)
                }
        }
        (getChildAt(childCount - 1) as? ViewGroup)?.let { identity ->
            for (i in 0 until identity.childCount) {
                val child = identity.getChildAt(i)
                if (child is NativeActionFlow) child.centerRows = narrow
                (child as? TextView)?.apply {
                    textAlignment = if (narrow) TEXT_ALIGNMENT_CENTER else TEXT_ALIGNMENT_VIEW_START
                    gravity = Gravity.TOP or if (narrow) Gravity.CENTER_HORIZONTAL else Gravity.START
                }
            }
        }
        super.onMeasure(widthMeasureSpec, heightMeasureSpec)
    }
}

internal class NativeStatsDashboard(
    context: Context,
) : ViewGroup(context) {
    private var rects = emptyList<NativeFlowRect>()

    override fun generateDefaultLayoutParams() = LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT)

    override fun onMeasure(
        widthMeasureSpec: Int,
        heightMeasureSpec: Int,
    ) {
        val width = MeasureSpec.getSize(widthMeasureSpec)
        val available = (width - paddingLeft - paddingRight).coerceAtLeast(0)
        val wide = !nativeStackForWidth(available, resources.displayMetrics.density, resources.configuration.fontScale, 904)
        val gap = NativeUi.dp(context, 20)
        val side = minOf(NativeUi.dp(context, 340), available)
        val main = (available - side - gap).coerceAtLeast(0)
        if (childCount == 5) {
            for (i in 0..4) {
                val childWidth =
                    if (!wide || i == 3) {
                        available
                    } else if (i == 0 || i == 2) {
                        main
                    } else {
                        side
                    }
                getChildAt(
                    i,
                ).measure(
                    MeasureSpec.makeMeasureSpec(childWidth, MeasureSpec.EXACTLY),
                    MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED),
                )
            }
            rects = nativeStatsRects(available, (0..4).map { getChildAt(it).measuredHeight }, wide, side, gap)
        } else {
            rects = emptyList()
        }
        setMeasuredDimension(
            resolveSize(width, widthMeasureSpec),
            resolveSize((rects.maxOfOrNull { it.bottom } ?: 0) + paddingTop + paddingBottom, heightMeasureSpec),
        )
    }

    override fun onLayout(
        changed: Boolean,
        left: Int,
        top: Int,
        right: Int,
        bottom: Int,
    ) {
        val width = right - left - paddingLeft - paddingRight
        rects.forEachIndexed { index, rect ->
            val x = if (layoutDirection == LAYOUT_DIRECTION_RTL) width - rect.right else rect.left
            getChildAt(index).layout(
                paddingLeft + x,
                paddingTop + rect.top,
                paddingLeft + x + rect.right - rect.left,
                paddingTop + rect.bottom,
            )
        }
    }
}

internal class NativeMetadataGrid(
    context: Context,
    private val breakpointDp: Int = 700,
    spacingDp: Int = 12,
) : ViewGroup(context) {
    private var rects = emptyList<NativeFlowRect>()
    private val gap = NativeUi.dp(context, spacingDp)

    override fun generateDefaultLayoutParams() = LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT)

    override fun onMeasure(
        widthMeasureSpec: Int,
        heightMeasureSpec: Int,
    ) {
        val width = MeasureSpec.getSize(widthMeasureSpec)
        val available = (width - paddingLeft - paddingRight).coerceAtLeast(0)
        val columns =
            if (nativeStackForWidth(
                    available,
                    resources.displayMetrics.density,
                    resources.configuration.fontScale,
                    breakpointDp,
                )
            ) {
                1
            } else {
                2
            }
        val cell = ((available - gap * (columns - 1)).coerceAtLeast(0)) / columns
        val children = (0 until childCount).map { getChildAt(it) }.filter { it.visibility != GONE }
        children.forEach {
            it.measure(MeasureSpec.makeMeasureSpec(cell, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
        }
        rects = nativeMetadataRects(available, children.map { it.measuredHeight }, columns, gap)
        setMeasuredDimension(
            resolveSize(width, widthMeasureSpec),
            resolveSize((rects.maxOfOrNull { it.bottom } ?: 0) + paddingTop + paddingBottom, heightMeasureSpec),
        )
    }

    override fun onLayout(
        changed: Boolean,
        left: Int,
        top: Int,
        right: Int,
        bottom: Int,
    ) {
        val width = (right - left - paddingLeft - paddingRight).coerceAtLeast(0)
        val children = (0 until childCount).map { getChildAt(it) }.filter { it.visibility != GONE }
        children.forEachIndexed { index, child ->
            val rect = rects.getOrNull(index) ?: return@forEachIndexed
            val x = if (layoutDirection == LAYOUT_DIRECTION_RTL) width - rect.right else rect.left
            child.layout(paddingLeft + x, paddingTop + rect.top, paddingLeft + x + rect.right - rect.left, paddingTop + rect.bottom)
        }
    }
}

private class NativeSettingRow(
    context: Context,
) : LinearLayout(context) {
    private var stacked: Boolean? = null

    override fun onMeasure(
        widthMeasureSpec: Int,
        heightMeasureSpec: Int,
    ) {
        val available = MeasureSpec.getSize(widthMeasureSpec)
        val stack = available < NativeUi.dp(context, (480 * resources.configuration.fontScale).toInt())
        if (stacked != stack && childCount == 2) {
            stacked = stack
            orientation = if (stack) VERTICAL else HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            getChildAt(0).layoutParams =
                if (stack) {
                    LayoutParams(
                        LayoutParams.MATCH_PARENT,
                        LayoutParams.WRAP_CONTENT,
                    )
                } else {
                    LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f)
                }
            getChildAt(1).layoutParams =
                LayoutParams(if (stack) LayoutParams.MATCH_PARENT else LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT)
            (getChildAt(1) as TextView).maxWidth = if (stack) Int.MAX_VALUE else minOf(NativeUi.dp(context, 240), available / 2)
        }
        super.onMeasure(widthMeasureSpec, heightMeasureSpec)
    }
}

/** Built-in outline glyphs; paths are never supplied by document content. */
internal fun nativeIconVectorXml(
    kind: String,
    emphasis: Boolean = false,
): String {
    val name =
        when (kind) {
            "reading" -> "currently-reading"
            "history" -> "reading-history"
            "stats" -> "reading-history"
            "toc" -> "table-of-contents"
            "search" -> "search-library"
            "searchInBook" -> "search-in-book"
            "ai" -> "reading-assistant"
            "audio" -> "read-aloud"
            "readingModes" -> "reading-modes"
            "bookmarkBorder" -> "bookmarks"
            "recovery" -> "reading-history"
            else -> kind
        }
    val paths =
        when (name) {
            "library" -> listOf("M4 3h6v18H4z", "M14 4l5-1 3 17-5 1z")
            "currently-reading" -> listOf("M12 5C9 3 5 3 2 5v15c3-2 7-2 10 0 3-2 7-2 10 0V5c-3-2-7-2-10 0Z", "M12 5v15")
            "notes" -> listOf("M4 3h13v17H4z", "M8 7h5M8 11h5M8 15h3M17 6h3v16H7")
            "reading-history" -> listOf("M4 7A9 9 0 1 1 3 15", "M3 3v5h5M12 7v5l3 2")
            "settings" -> listOf("M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1Z", "M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0")
            "table-of-contents" -> listOf("M4 6h.1M4 12h.1M4 18h.1", "M9 6h11M9 12h11M9 18h11")
            "annotations" -> listOf("M4 3h12l4 4v14H4z", "M15 3v5h5M8 12h8M8 16h6")
            "bookmarks" -> listOf("M6 3h12v18l-6-4-6 4Z")
            "read-aloud" -> listOf("M4 9h4l5-5v16l-5-5H4z", "M17 8c3 2 3 6 0 8")
            "reading-assistant" -> listOf("M3 4h14v12H9l-6 5Z", "M19 2v6M16 5h6")
            "search-in-book" -> listOf("M3 4h12v16H3z", "M7 8h4", "M20 15a4 4 0 1 1-8 0 4 4 0 0 1 8 0M19 18l3 4")
            "reading-modes" -> listOf("M3 4h18v16H3z", "M12 4v16M7 8h1M7 12h1M16 8h1M16 12h1")
            "typography" -> listOf("M3 20 9 4l6 16M5 15h8", "M16 20l3-8 3 8M17 17h4")
            "search-library" -> listOf("M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0M15 15l6 6")
            "singlePage" -> listOf("M5 3h14v18H5z")
            "facingPages" -> listOf("M3 4h7v16H3zM14 4h7v16h-7z")
            "folder" -> listOf("M3 6h7l2 3h9v11H3z")
            "refresh" -> listOf("M4 9a8 8 0 0 1 13-4l3 3M20 3v5h-5", "M20 15a8 8 0 0 1-13 4l-3-3M4 21v-5h5")
            "info" -> listOf("M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0", "M12 7v.1M12 11v6")
            "back" -> listOf("M10 5 3 12l7 7M3 12h18")
            "fullscreen" -> listOf("M3 9V3h6M15 3h6v6M21 15v6h-6M9 21H3v-6")
            "fullscreenExit" -> listOf("M9 3v6H3M15 3v6h6M21 15h-6v6M3 15h6v6")
            "more" -> listOf("M5 12h.1M12 12h.1M19 12h.1")
            "next" -> listOf("M8 4l8 8-8 8")
            "thumbnails" -> listOf("M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z")
            "zoomIn" -> listOf("M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0M15 15l6 6", "M6 10h8M10 6v8")
            "zoomOut" -> listOf("M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0M15 15l6 6", "M6 10h8")
            "print" -> listOf("M6 8V3h12v5M6 17H3V8h18v9h-3", "M6 14h12v7H6z")
            "slideshow" -> listOf("M3 3h18v14H3z", "M10 6l6 4-6 4zM12 17v4M8 21h8")
            "close" -> listOf("M5 5l14 14M19 5 5 19")
            "delete" -> listOf("M3 6h18M8 6V3h8v3M5 6l1 15h12l1-15", "M10 10v7M14 10v7")
            "pin" -> listOf("M8 3h8l-1 7 4 4H5l4-4z", "M12 14v7")
            "bookmark" -> listOf("M6 3h12v18l-6-4-6 4Z", "M9 9l2 2 4-4")
            "menu" -> listOf("M3 6h18M3 12h18M3 18h18")
            else -> listOf("M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0", "M12 7v.1M12 11v6")
        }
    val stroke = if (emphasis) "2" else "1.5"
    val data =
        paths.joinToString("") {
            """<path android:fillColor="#00000000" android:strokeColor="#ff000000" android:strokeWidth="$stroke" android:pathData="$it"/>"""
        }
    return """<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="24dp" android:height="24dp" android:viewportWidth="24" android:viewportHeight="24">$data</vector>"""
}

private class NativeUiIcon(
    context: Context,
    kind: String,
    ink: Int,
    emphasis: Boolean = false,
) : Drawable() {
    private data class Segment(
        val path: android.graphics.Path,
        val width: Float,
    )

    private val density = context.resources.displayMetrics.density
    private val paint =
        android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply {
            color = ink
            style = android.graphics.Paint.Style.STROKE
            strokeCap = android.graphics.Paint.Cap.ROUND
            strokeJoin = android.graphics.Paint.Join.ROUND
        }
    private val segments: List<Segment> =
        buildList {
            val namespace = "http://schemas.android.com/apk/res/android"
            val parser =
                android.util.Xml
                    .newPullParser()
                    .apply { setInput(java.io.StringReader(nativeIconVectorXml(kind, emphasis))) }
            while (parser.eventType != org.xmlpull.v1.XmlPullParser.END_DOCUMENT) {
                if (parser.eventType == org.xmlpull.v1.XmlPullParser.START_TAG && parser.name == "path") {
                    add(
                        Segment(
                            requireNotNull(
                                androidx.core.graphics.PathParser.createPathFromPathData(
                                    requireNotNull(parser.getAttributeValue(namespace, "pathData")),
                                ),
                            ),
                            parser.getAttributeValue(namespace, "strokeWidth").toFloat(),
                        ),
                    )
                }
                parser.next()
            }
        }

    override fun draw(canvas: Canvas) {
        val scale = minOf(bounds.width(), bounds.height()) / 24f
        if (scale <= 0f) return
        val saved = canvas.save()
        canvas.translate(bounds.left + (bounds.width() - 24f * scale) / 2f, bounds.top + (bounds.height() - 24f * scale) / 2f)
        canvas.scale(scale, scale)
        for (segment in segments) {
            paint.strokeWidth = nativeIconStrokeWidth(segment.width, density, scale)
            canvas.drawPath(segment.path, paint)
        }
        canvas.restoreToCount(saved)
    }

    override fun getIntrinsicWidth() = 24

    override fun getIntrinsicHeight() = 24

    override fun setAlpha(alpha: Int) {
        paint.alpha = alpha
        invalidateSelf()
    }

    override fun setColorFilter(colorFilter: ColorFilter?) {
        paint.colorFilter = colorFilter
        invalidateSelf()
    }

    @Deprecated("Deprecated in Android")
    override fun getOpacity() = android.graphics.PixelFormat.TRANSLUCENT
}
