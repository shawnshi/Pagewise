package io.pagewise.reader

internal data class NativeFlowSize(
    val width: Int,
    val height: Int,
)

internal data class NativeFlowRect(
    val left: Int,
    val top: Int,
    val right: Int,
    val bottom: Int,
)

/** The same measured-child geometry drives the Android ViewGroup and host invariants. */
internal fun nativeFlowRects(
    width: Int,
    children: List<NativeFlowSize>,
    gap: Int,
): List<NativeFlowRect> {
    require(width >= 0 && gap >= 0)
    var x = 0
    var y = 0
    var rowHeight = 0
    return children.map { child ->
        require(child.width >= 0 && child.height >= 0)
        val childWidth = child.width.coerceAtMost(width)
        if (x > 0 && x + childWidth > width) {
            x = 0
            y += rowHeight + gap
            rowHeight = 0
        }
        val rect = NativeFlowRect(x, y, x + childWidth, y + child.height)
        x += childWidth + gap
        rowHeight = maxOf(rowHeight, child.height)
        rect
    }
}

internal fun nativeStackForWidth(
    available: Int,
    density: Float,
    fontScale: Float,
    thresholdDp: Int,
): Boolean {
    require(available >= 0 && density.isFinite() && density > 0 && fontScale.isFinite() && fontScale > 0 && thresholdDp > 0)
    return available / density < thresholdDp * fontScale.coerceAtLeast(1f)
}

internal fun nativeMetadataRects(
    width: Int,
    heights: List<Int>,
    columns: Int,
    gap: Int,
): List<NativeFlowRect> {
    require(width >= 0 && columns in 1..2 && gap >= 0 && heights.all { it >= 0 })
    val cell = ((width - gap * (columns - 1)).coerceAtLeast(0)) / columns
    var y = 0
    val result = ArrayList<NativeFlowRect>()
    for (row in heights.indices.chunked(columns)) {
        val height = row.maxOf { heights[it] }
        row.forEachIndexed { column, index ->
            val left = column * (cell + gap)
            result.add(NativeFlowRect(left, y, (left + cell).coerceAtMost(width), y + height))
        }
        y += height + gap
    }
    return result
}

/** Actual 1.4 areas: Today/Trend main; Week/Milestones auxiliary; Calendar full width. */
internal fun nativeStatsRects(
    width: Int,
    heights: List<Int>,
    wide: Boolean,
    sideWidth: Int,
    gap: Int,
): List<NativeFlowRect> {
    require(width >= 0 && heights.size == 5 && heights.all { it >= 0 } && gap >= 0 && sideWidth in 0..width)
    if (!wide) {
        var top = 0
        return heights.map { height -> NativeFlowRect(0, top, width, top + height).also { top += height + gap } }
    }
    require(sideWidth + gap <= width)
    val main = width - sideWidth - gap
    val sideX = main + gap
    val trendY = heights[0] + gap
    val marksY = heights[1] + gap
    val calendarY = maxOf(trendY + heights[2], marksY + heights[4]) + gap
    return listOf(
        NativeFlowRect(0, 0, main, heights[0]),
        NativeFlowRect(sideX, 0, width, heights[1]),
        NativeFlowRect(0, trendY, main, trendY + heights[2]),
        NativeFlowRect(0, calendarY, width, calendarY + heights[3]),
        NativeFlowRect(sideX, marksY, width, marksY + heights[4]),
    )
}

internal val nativeBottomPages = listOf("library", "reading", "annotations", "stats", "settings")

internal fun nativeContentWidth(
    available: Int,
    maximum: Int,
) = available.coerceAtLeast(0).coerceAtMost(maximum.coerceAtLeast(0))

internal data class NativeEinkPalette(
    val background: Int,
    val surface: Int,
    val outline: Int,
    val divider: Int,
    val primary: Int,
    val secondary: Int,
    val disabled: Int,
    val highlight: Int,
)

private val nativeEinkLight =
    NativeEinkPalette(
        0xFFFFFFFF.toInt(),
        0xFFEEEEEE.toInt(),
        0xFF000000.toInt(),
        0xFFBBBBBB.toInt(),
        0xFF111111.toInt(),
        0xFF444444.toInt(),
        0xFF777777.toInt(),
        0xFFDDDDDD.toInt(),
    )
private val nativeEinkDark =
    NativeEinkPalette(
        0xFF000000.toInt(),
        0xFF222222.toInt(),
        0xFFFFFFFF.toInt(),
        0xFF555555.toInt(),
        0xFFEEEEEE.toInt(),
        0xFFCCCCCC.toInt(),
        0xFF999999.toInt(),
        0xFF333333.toInt(),
    )

private val archivalCallNumbers =
    mapOf(
        "philosophy-religion" to ("哲学与宗教" to "PHI"),
        "psychology-cognition" to ("心理与认知" to "PSY"),
        "computer-ai" to ("计算机与AI" to "CSI"),
        "biography-memoir" to ("传记与回忆" to "BIO"),
        "history-society" to ("历史与社会" to "HIS"),
        "economics-management" to ("经济与管理" to "ECO"),
        "science-nature" to ("科学与自然" to "SCI"),
        "literature-language" to ("文学与语言" to "LIT"),
        "art-design" to ("艺术与设计" to "ART"),
        "life-health" to ("生活与健康" to "LIF"),
        "unclassified" to ("未分类" to "UNC"),
    )

internal fun nativeCategoryCallNumber(
    raw: String,
    english: Boolean = false,
): String {
    val trimmed = raw.trim()
    if (trimmed.isEmpty()) return if (english) "Unclassified [UNC]" else "未分类 [UNC]"
    val entry = archivalCallNumbers[trimmed]
    if (entry != null) {
        return if (english) "$trimmed [${entry.second}]" else "${entry.first} [${entry.second}]"
    }
    for ((_, pair) in archivalCallNumbers) {
        if (trimmed == pair.first) return "${pair.first} [${pair.second}]"
    }
    return trimmed
}

internal fun nativeEinkPalette(background: Int): NativeEinkPalette =
    if ((background ushr 16 and 255) > 128) nativeEinkLight else nativeEinkDark

internal fun nativeIconStrokeWidth(
    strokeDp: Float,
    density: Float,
    scale: Float,
): Float {
    require((strokeDp == 1.5f || strokeDp == 2f) && density.isFinite() && density > 0 && scale.isFinite() && scale > 0)
    return strokeDp * density / scale
}
