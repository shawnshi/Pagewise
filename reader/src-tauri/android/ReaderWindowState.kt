package io.pagewise.reader

/** Reader intent survives focus/lifecycle changes; a paused or destroyed window cannot hold the screen on. */
class ReaderWindowState {
    var resumed = false
        private set
    private var destroyed = false
    private var immersiveRequested = false
    private var awakeRequested = false

    val immersive: Boolean get() = resumed && immersiveRequested
    val keepScreenOn: Boolean get() = resumed && awakeRequested

    fun requestImmersive(on: Boolean) {
        if (!destroyed) immersiveRequested = on
    }

    fun requestKeepScreenOn(on: Boolean) {
        if (!destroyed) awakeRequested = on
    }

    fun resume() {
        if (!destroyed) resumed = true
    }

    fun pause() {
        resumed = false
    }

    fun destroy() {
        resumed = false
        destroyed = true
        immersiveRequested = false
        awakeRequested = false
        epdState.onLifecyclePause()
        scribbleState.onLifecycleDestroy()
        hardwareKeyState.onLifecycleDestroy()
    }

    val epdState = OnyxEpdState()
    val scribbleState = OnyxScribbleState()
    val hardwareKeyState = OnyxHardwareKeyState()
    val checkpointState = OnyxReadingCheckpointState()

    fun canEnableRawDrawing(): Boolean = resumed && !destroyed && scribbleState.activeRawDrawing

    fun evaluateHardwareKey(
        keyCode: Int,
        action: Int,
        repeatCount: Int,
    ): OnyxKeyDecision = hardwareKeyState.resolveKeyAction(resumed && !destroyed, keyCode, action, repeatCount)
}

enum class OnyxWaveformMode(
    val wireName: String,
    val sdkCandidates: List<String>,
) {
    REGAL("regal", listOf("REGAL", "REGAL_PLUS", "GU")),
    GC("gc", listOf("GC", "GC16")),
    GU("gu", listOf("GU", "GU16", "PARTIAL")),
    DU("du", listOf("DU", "DU4")),
    A2("a2", listOf("A2", "ANIMATION", "ANIMATION_QUALITY")),
    ;

    companion object {
        fun fromWire(raw: String?): OnyxWaveformMode =
            when (raw?.trim()?.lowercase()) {
                "gc", "gc16", "full" -> GC
                "gu", "gu16", "partial" -> GU
                "du", "fast" -> DU
                "a2", "animation" -> A2
                else -> REGAL
            }
    }
}

class OnyxEpdState {
    var defaultMode: OnyxWaveformMode = OnyxWaveformMode.REGAL
        private set
    var currentMode: OnyxWaveformMode = OnyxWaveformMode.REGAL
        private set
    var fastModeActive: Boolean = false
        private set
    var fastScene: String = ""
        private set
    var pageTurnCount: Int = 0
        private set
    var gcIntervalPages: Int = 10
        private set

    fun configureGcInterval(pages: Int) {
        gcIntervalPages = pages.coerceIn(0, 100)
        if (gcIntervalPages == 0) pageTurnCount = 0
    }

    fun recordPageTurn(): OnyxWaveformMode {
        if (fastModeActive) return currentMode
        pageTurnCount += 1
        if (gcIntervalPages > 0 && pageTurnCount >= gcIntervalPages) {
            pageTurnCount = 0
            return OnyxWaveformMode.GC
        }
        return defaultMode
    }

    fun resetPageTurnCounter() {
        pageTurnCount = 0
    }

    fun enterFastMode(
        scene: String,
        mode: OnyxWaveformMode = OnyxWaveformMode.DU,
    ): Boolean {
        val changed = !fastModeActive || currentMode != mode || fastScene != scene
        fastModeActive = true
        fastScene = scene
        currentMode = mode
        return changed
    }

    fun exitFastMode(): Boolean {
        val wasFast = fastModeActive
        fastModeActive = false
        fastScene = ""
        currentMode = defaultMode
        return wasFast
    }

    fun setStaticMode(mode: OnyxWaveformMode) {
        defaultMode = mode
        if (!fastModeActive) currentMode = mode
    }

    fun onLifecyclePause(): Boolean = exitFastMode()
}

data class OnyxFrontLightSnapshot(
    val supported: Boolean,
    val ctmSupported: Boolean,
    val enabled: Boolean,
    val coldPercent: Int,
    val warmPercent: Int,
    val coldRaw: Int,
    val coldMin: Int,
    val coldMax: Int,
    val warmRaw: Int,
    val warmMin: Int,
    val warmMax: Int,
) {
    companion object {
        fun percentToRaw(
            percent: Int,
            min: Int,
            max: Int,
        ): Int {
            val safeMin = min.coerceAtLeast(0)
            val safeMax = max.coerceAtLeast(safeMin)
            if (safeMax == safeMin) return safeMin
            val clamped = percent.coerceIn(0, 100)
            return safeMin + kotlin.math.round((clamped / 100.0) * (safeMax - safeMin)).toInt()
        }

        fun rawToPercent(
            raw: Int,
            min: Int,
            max: Int,
        ): Int {
            val safeMin = min.coerceAtLeast(0)
            val safeMax = max.coerceAtLeast(safeMin)
            if (safeMax == safeMin) return 0
            val clamped = raw.coerceIn(safeMin, safeMax)
            return kotlin.math
                .round(((clamped - safeMin).toDouble() / (safeMax - safeMin).toDouble()) * 100.0)
                .toInt()
                .coerceIn(0, 100)
        }
    }
}

data class OnyxRectCss(
    val left: Float,
    val top: Float,
    val right: Float,
    val bottom: Float,
) {
    val valid: Boolean get() = right > left && bottom > top
}

class OnyxScribbleState {
    var enabled: Boolean = false
        private set
    var suspendedByModal: Boolean = false
        private set
    var strokeStyle: Int = STROKE_STYLE_FOUNTAIN
        private set
    var strokeWidth: Float = 3.0f
        private set
    var limitRect: OnyxRectCss? = null
        private set
    var excludeRects: List<OnyxRectCss> = emptyList()
        private set

    val activeRawDrawing: Boolean
        get() = enabled && !suspendedByModal && (limitRect?.valid == true)

    fun configure(
        enable: Boolean,
        style: Int,
        width: Float,
        limit: OnyxRectCss?,
        excludes: List<OnyxRectCss>,
    ) {
        enabled = enable
        strokeStyle = style.coerceIn(STROKE_STYLE_PENCIL, STROKE_STYLE_MARKER)
        strokeWidth = width.coerceIn(1.0f, 24.0f)
        limitRect = limit
        excludeRects = excludes.filter { it.valid }
    }

    fun setModalSuspended(suspended: Boolean): Boolean {
        val before = activeRawDrawing
        suspendedByModal = suspended
        return before != activeRawDrawing
    }

    fun onLifecyclePause() {
        suspendedByModal = false
    }

    fun onLifecycleDestroy() {
        enabled = false
        suspendedByModal = false
        limitRect = null
        excludeRects = emptyList()
    }

    companion object {
        const val STROKE_STYLE_PENCIL = 0
        const val STROKE_STYLE_FOUNTAIN = 1
        const val STROKE_STYLE_MARKER = 2
    }
}

data class OnyxKeyDecision(
    val intercept: Boolean,
    val direction: String?,
)

class OnyxHardwareKeyState {
    var captureEnabled: Boolean = false
        private set
    var volumeKeysEnabled: Boolean = true
        private set

    fun configure(
        capture: Boolean,
        volumeEnabled: Boolean = true,
    ) {
        captureEnabled = capture
        volumeKeysEnabled = volumeEnabled
    }

    fun onLifecycleDestroy() {
        captureEnabled = false
    }

    fun resolveKeyAction(
        windowActive: Boolean,
        keyCode: Int,
        action: Int,
        repeatCount: Int,
    ): OnyxKeyDecision {
        if (!windowActive || !captureEnabled) {
            return OnyxKeyDecision(intercept = false, direction = null)
        }
        val dir =
            when (keyCode) {
                KEYCODE_VOLUME_UP -> if (volumeKeysEnabled) "prev" else null
                KEYCODE_VOLUME_DOWN -> if (volumeKeysEnabled) "next" else null
                KEYCODE_PAGE_UP -> "prev"
                KEYCODE_PAGE_DOWN -> "next"
                else -> null
            } ?: return OnyxKeyDecision(intercept = false, direction = null)

        if (action == ACTION_DOWN && repeatCount == 0) {
            return OnyxKeyDecision(intercept = true, direction = dir)
        }
        // Intercept key-up and key-repeat without firing duplicate page turns so Android never shows the system volume bar.
        return OnyxKeyDecision(intercept = true, direction = null)
    }

    companion object {
        const val ACTION_DOWN = 0
        const val ACTION_UP = 1
        const val KEYCODE_VOLUME_UP = 24
        const val KEYCODE_VOLUME_DOWN = 25
        const val KEYCODE_PAGE_UP = 92
        const val KEYCODE_PAGE_DOWN = 93
    }
}

data class OnyxReadingCheckpoint(
    val bookId: String,
    val cfi: String,
    val progress: Double,
    val readingDeltaSeconds: Int,
    val updatedAtMs: Long,
)

class OnyxReadingCheckpointState {
    private var staged: OnyxReadingCheckpoint? = null
    private var dirty: Boolean = false

    @Synchronized
    fun stage(
        bookId: String,
        cfi: String,
        progress: Double,
        readingDeltaSeconds: Int,
        nowMs: Long = System.currentTimeMillis(),
    ): Boolean {
        val cleanId = bookId.trim()
        if (cleanId.isEmpty() || !progress.isFinite()) return false
        staged =
            OnyxReadingCheckpoint(
                bookId = cleanId,
                cfi = cfi.trim(),
                progress = progress.coerceIn(0.0, 1.0),
                readingDeltaSeconds = readingDeltaSeconds.coerceIn(0, 86400),
                updatedAtMs = nowMs,
            )
        dirty = true
        return true
    }

    @Synchronized
    fun peekDirtyForFlush(): OnyxReadingCheckpoint? {
        if (!dirty) return null
        return staged
    }

    @Synchronized
    fun markFlushed(flushed: OnyxReadingCheckpoint): Boolean {
        if (staged == flushed) {
            dirty = false
            return true
        }
        return false
    }

    @Synchronized
    fun takeDirtyForFlush(): OnyxReadingCheckpoint? {
        if (!dirty) return null
        dirty = false
        return staged
    }

    @Synchronized
    fun restoreFromDisk(checkpoint: OnyxReadingCheckpoint?) {
        if (checkpoint != null && staged == null) {
            staged = checkpoint
            dirty = false
        }
    }

    @Synchronized
    fun consume(): OnyxReadingCheckpoint? {
        val current = staged
        staged = null
        dirty = false
        return current
    }
}

object OnyxEpubTextMatcher {
    fun stripXmlToPlainText(xml: String): String {
        if (xml.isEmpty()) return ""
        val withoutBlocks =
            xml.replace(Regex("(?is)<(script|style|head)\\b[^>]*>.*?</\\1>"), " ")
        val sb = StringBuilder(withoutBlocks.length.coerceAtMost(65536))
        var inTag = false
        var lastWasSpace = true
        var i = 0
        val len = withoutBlocks.length
        while (i < len) {
            val ch = withoutBlocks[i]
            if (ch == '<') {
                inTag = true
                if (!lastWasSpace) {
                    sb.append(' ')
                    lastWasSpace = true
                }
                i++
                continue
            }
            if (ch == '>') {
                inTag = false
                i++
                continue
            }
            if (!inTag) {
                if (ch.isWhitespace()) {
                    if (!lastWasSpace) {
                        sb.append(' ')
                        lastWasSpace = true
                    }
                } else {
                    sb.append(ch)
                    lastWasSpace = false
                }
            }
            i++
        }
        return sb
            .toString()
            .replace("&nbsp;", " ")
            .replace("&amp;", "&")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .replace("&apos;", "'")
            .trim()
    }

    fun findExcerpts(
        plainText: String,
        query: String,
        maxHits: Int = 20,
    ): List<String> {
        val cleanQuery = query.trim()
        if (plainText.isEmpty() || cleanQuery.isEmpty() || maxHits <= 0) return emptyList()
        val lowerText = plainText.lowercase()
        val lowerQuery = cleanQuery.lowercase()
        val results = ArrayList<String>()
        var searchFrom = 0
        while (searchFrom < lowerText.length && results.size < maxHits) {
            val idx = lowerText.indexOf(lowerQuery, searchFrom)
            if (idx < 0) break
            val start = (idx - 40).coerceAtLeast(0)
            val end = (idx + cleanQuery.length + 45).coerceAtMost(plainText.length)
            val prefix = if (start > 0) "…" else ""
            val suffix = if (end < plainText.length) "…" else ""
            results.add(prefix + plainText.substring(start, end).trim() + suffix)
            searchFrom = idx + cleanQuery.length.coerceAtLeast(1)
        }
        return results
    }
}

