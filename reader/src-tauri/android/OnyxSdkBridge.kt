package io.pagewise.reader

import android.content.ActivityNotFoundException
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Rect
import android.graphics.pdf.PdfRenderer
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.util.Base64
import android.util.Log
import android.view.KeyEvent
import android.view.View
import android.webkit.WebView
import com.onyx.android.sdk.api.device.FrontLightController
import com.onyx.android.sdk.api.device.epd.EpdController
import com.onyx.android.sdk.api.device.epd.UpdateMode
import com.onyx.android.sdk.data.note.TouchPoint
import com.onyx.android.sdk.pen.RawInputCallback
import com.onyx.android.sdk.pen.TouchHelper
import com.onyx.android.sdk.pen.data.TouchPointList
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.util.Locale
import java.util.UUID
import java.util.concurrent.Executors
import java.util.zip.ZipFile

/**
 * Unified adapter for Onyx BOOX SDK (`com.onyx.android.sdk`):
 * 1. `onyxsdk-device`: `EpdController` & `UpdateMode` waveform/refresh management
 * 2. `onyxsdk-pen` / `onyxsdk-scribble`: `TouchHelper` & `RawInputCallback` low-latency Wacom EMR scribble
 * 3. `FrontLightController`: CTM dual-color-temperature (cold + warm) frontlight control
 * 4. `Device` / `DeviceUtils` / `DeviceEnvironment`: hardware profile & system environment inspection
 */
class OnyxSdkBridge(
    private val context: Context,
    private val windowState: ReaderWindowState,
) {
    private val epdHandler = Handler(Looper.getMainLooper())
    private val ioExecutor = Executors.newSingleThreadExecutor()
    private var pendingFastExit: Runnable? = null
    private var pendingOverlayRepaint: Runnable? = null
    private var managementOverlayView: View? = null

    @Volatile
    private var touchHelperInstance: TouchHelper? = null

    @Volatile
    private var lastEpdApplied: Boolean = false
    private val epdProbeReady: Boolean
    private val regalSupported: Boolean
    private val maxTouchPressure: Float
    private val externalOpenQueue = ArrayList<JSONObject>()
    private var activePdfPath: String? = null
    private var activePdfDescriptor: ParcelFileDescriptor? = null
    private var activePdfRenderer: PdfRenderer? = null

    init {
        restoreCheckpointFromDisk()
        val boox = isBooxHardware()
        regalSupported = if (boox) runCatching { EpdController.supportRegal() }.getOrDefault(false) else false
        maxTouchPressure =
            if (boox) {
                runCatching { EpdController.getMaxTouchPressure() }.getOrDefault(0f)
            } else {
                0f
            }
        epdProbeReady =
            boox &&
            runCatching {
                EpdController.getSystemDefaultUpdateMode()
                true
            }.getOrDefault(regalSupported || maxTouchPressure > 0f)
        val hasFl = if (boox) queryHasFrontLight() else false
        val hasCtm = if (boox) queryHasCtmBrightness() else false
        Log.i(
            "OnyxSdkBridge",
            "probe boox=$boox epd=$epdProbeReady regal=$regalSupported frontLight=$hasFl ctm=$hasCtm maxPressure=$maxTouchPressure model=${resolveDeviceModel()}",
        )
    }

    fun isBooxHardware(): Boolean {
        val brands =
            listOf(Build.MANUFACTURER, Build.BRAND)
                .mapNotNull { it?.lowercase(Locale.ROOT) }
        if (brands.any { it.contains("onyx") || it.contains("boox") }) return true
        val sysMfg = readSystemProperty("ro.product.manufacturer").lowercase(Locale.ROOT)
        val sysBrand = readSystemProperty("ro.product.brand").lowercase(Locale.ROOT)
        if (sysMfg.contains("onyx") || sysMfg.contains("boox") || sysBrand.contains("onyx") || sysBrand.contains("boox")) return true
        if (readSystemProperty("ro.onyx.model").isNotEmpty()) return true
        return readSystemProperty("ro.vendor.build.onyxid").isNotEmpty()
    }

    fun buildHardwareProfileJson(
        lowRam: Boolean,
        memoryClassMb: Int,
    ): String {
        val metrics = context.resources.displayMetrics
        val widthPx = metrics.widthPixels.coerceAtLeast(1)
        val heightPx = metrics.heightPixels.coerceAtLeast(1)
        val densityDpi = metrics.densityDpi.coerceAtLeast(72)
        val boox = isBooxHardware()
        val hasFrontLight = boox && queryHasFrontLight()
        val hasCtm = hasFrontLight && queryHasCtmBrightness()
        val epdReady = boox && epdProbeReady
        val stylusReady = boox && (touchHelperInstance != null || maxTouchPressure > 0f)
        val sdkReady = boox && (epdReady || hasFrontLight || stylusReady)
        val modelName = resolveDeviceModel()
        val colorEink =
            modelName.lowercase(Locale.ROOT).let {
                it.contains("color") || it.contains("ultra c") || it.contains("air3 c") || it.contains("air 3c") || it.contains("tab10c") ||
                    it.contains("t10c")
            }
        return JSONObject()
            .put("version", 1)
            .put("boox", boox)
            .put("sdkAvailable", sdkReady)
            .put("model", modelName)
            .put("lowRam", lowRam)
            .put("memoryClassMb", memoryClassMb)
            .put("physicalWidthPx", widthPx)
            .put("physicalHeightPx", heightPx)
            .put("densityDpi", densityDpi)
            .put("epdController", epdReady)
            .put("frontLight", hasFrontLight)
            .put("ctmLight", hasCtm)
            .put("stylus", stylusReady)
            .put("colorEink", colorEink)
            .toString()
    }

    // =========================================================================
    // 1. EpdController: Waveform & Refresh Control
    // =========================================================================

    fun attachWebView(webView: WebView) {
        if (isBooxHardware()) {
            runCatching { EpdController.setWebViewContrastOptimize(webView, true) }
        }
        applyViewDefaultUpdateMode(webView, windowState.epdState.defaultMode)
    }

    fun attachManagementOverlay(overlay: View) {
        managementOverlayView = overlay
        if (!isBooxHardware()) return
        val enumVal = resolveUpdateModeEnum(OnyxWaveformMode.GU) ?: return
        runCatching { EpdController.setViewDefaultUpdateMode(overlay, enumVal) }
    }

    fun configureGcInterval(pages: Int): String {
        windowState.epdState.configureGcInterval(pages)
        return buildEpdStatusJson()
    }

    fun notifyPageTurn(webView: WebView?): String {
        val targetMode = windowState.epdState.recordPageTurn()
        if (targetMode == OnyxWaveformMode.GC) {
            repaintScreen(webView, OnyxWaveformMode.GC)
        }
        return buildEpdStatusJson()
    }

    fun epdStatus(): String = buildEpdStatusJson()

    fun scheduleFastExit(
        webView: WebView?,
        delayMs: Int,
    ) {
        pendingFastExit?.let { epdHandler.removeCallbacks(it) }
        val task =
            Runnable {
                pendingFastExit = null
                if (windowState.resumed) setFastMode(webView, false, "", "regal")
            }
        pendingFastExit = task
        epdHandler.postDelayed(task, delayMs.coerceIn(16, 2000).toLong())
    }

    fun scheduleOverlayRepaint(
        webView: WebView?,
        mode: String,
        delayMs: Int,
    ) {
        pendingOverlayRepaint?.let { epdHandler.removeCallbacks(it) }
        val resolvedMode = OnyxWaveformMode.fromWire(mode)
        val task =
            Runnable {
                pendingOverlayRepaint = null
                if (windowState.resumed) repaintScreen(webView, resolvedMode)
            }
        pendingOverlayRepaint = task
        epdHandler.postDelayed(task, delayMs.coerceIn(0, 2000).toLong())
    }

    private fun cancelPendingEpdWork() {
        pendingFastExit?.let { epdHandler.removeCallbacks(it) }
        pendingOverlayRepaint?.let { epdHandler.removeCallbacks(it) }
        pendingFastExit = null
        pendingOverlayRepaint = null
    }

    fun setFastMode(
        webView: WebView?,
        enabled: Boolean,
        scene: String,
        modeWire: String?,
    ): String {
        pendingFastExit?.let { epdHandler.removeCallbacks(it) }
        pendingFastExit = null
        if (enabled) {
            val fastMode = OnyxWaveformMode.fromWire(modeWire ?: "du")
            val changed = windowState.epdState.enterFastMode(scene.ifBlank { "scroll" }, fastMode)
            if (changed && isBooxHardware()) {
                val enumVal = resolveUpdateModeEnum(fastMode) ?: UpdateMode.DU
                val appApplied =
                    runCatching {
                        EpdController.applyAppScopeUpdate(context.packageName, true, true, enumVal, Int.MAX_VALUE)
                    }.getOrDefault(false)
                val sysApplied =
                    if (!appApplied) {
                        runCatching {
                            EpdController.applySystemFastMode(true)
                            true
                        }.getOrDefault(false)
                    } else {
                        false
                    }
                val viewApplied = webView?.let { applyViewDefaultUpdateMode(it, fastMode) } ?: false
                lastEpdApplied = appApplied || sysApplied || viewApplied
            }
        } else {
            val wasFast = windowState.epdState.exitFastMode()
            if (wasFast && isBooxHardware()) {
                val cleared = runCatching { EpdController.clearAppScopeUpdate(true) }.getOrDefault(false)
                val sysCleared =
                    if (!cleared) {
                        runCatching {
                            EpdController.applySystemFastMode(false)
                            true
                        }.getOrDefault(false)
                    } else {
                        false
                    }
                val viewApplied =
                    if (webView != null) {
                        val v = applyViewDefaultUpdateMode(webView, windowState.epdState.defaultMode)
                        repaintScreen(webView, OnyxWaveformMode.REGAL)
                        v || lastEpdApplied
                    } else {
                        false
                    }
                lastEpdApplied = cleared || sysCleared || viewApplied
            }
        }
        return buildEpdStatusJson()
    }

    fun repaintScreen(
        webView: WebView?,
        modeWire: String?,
    ): String {
        val mode = OnyxWaveformMode.fromWire(modeWire)
        repaintScreen(webView, mode)
        if (mode == OnyxWaveformMode.GC) {
            windowState.epdState.resetPageTurnCounter()
        }
        return buildEpdStatusJson()
    }

    private fun repaintScreen(
        webView: WebView?,
        mode: OnyxWaveformMode,
    ) {
        val targetView: View? =
            managementOverlayView?.takeIf { it.isAttachedToWindow && it.visibility == View.VISIBLE } ?: webView
        val enumVal = resolveUpdateModeEnum(mode)
        var applied = false
        if (isBooxHardware() && enumVal != null) {
            if (mode == OnyxWaveformMode.GC) {
                applied =
                    runCatching {
                        EpdController.repaintEveryThing(enumVal)
                        true
                    }.getOrDefault(false)
            }
            if (!applied && targetView != null) {
                applied =
                    runCatching {
                        EpdController.invalidate(targetView, enumVal)
                        true
                    }.getOrDefault(false)
            }
        }
        lastEpdApplied = applied
        targetView?.postInvalidate()
    }

    private fun applyViewDefaultUpdateMode(
        webView: WebView,
        mode: OnyxWaveformMode,
    ): Boolean {
        if (!isBooxHardware()) return false
        val enumVal = resolveUpdateModeEnum(mode) ?: return false
        val ok = runCatching { EpdController.setViewDefaultUpdateMode(webView, enumVal) }.getOrDefault(false)
        lastEpdApplied = ok
        return ok
    }

    private fun resolveUpdateModeEnum(mode: OnyxWaveformMode): UpdateMode? =
        when (mode) {
            OnyxWaveformMode.REGAL -> if (regalSupported) UpdateMode.REGAL else UpdateMode.GU
            OnyxWaveformMode.GC -> UpdateMode.GC
            OnyxWaveformMode.GU -> UpdateMode.GU
            OnyxWaveformMode.DU -> UpdateMode.DU
            OnyxWaveformMode.A2 -> UpdateMode.ANIMATION_QUALITY
        }

    private fun buildEpdStatusJson(): String =
        JSONObject()
            .put("mode", windowState.epdState.currentMode.wireName)
            .put("defaultMode", windowState.epdState.defaultMode.wireName)
            .put("fastMode", windowState.epdState.fastModeActive)
            .put("scene", windowState.epdState.fastScene)
            .put("pageTurnCount", windowState.epdState.pageTurnCount)
            .put("gcIntervalPages", windowState.epdState.gcIntervalPages)
            .put("applied", lastEpdApplied)
            .toString()

    // =========================================================================
    // 2. FrontLightController: Dual-Color-Temperature (Cold & Warm) Control
    // =========================================================================

    private val frontLightLock = Any()
    @Volatile private var cachedColdPercent: Int = 45
    @Volatile private var cachedWarmPercent: Int = 35
    @Volatile private var cachedLightEnabled: Boolean = true

    fun getFrontLightStateJson(): String {
        val snap = synchronized(frontLightLock) { readFrontLightSnapshot() }
        return JSONObject()
            .put("supported", snap.supported)
            .put("ctmSupported", snap.ctmSupported)
            .put("enabled", snap.enabled)
            .put("cold", snap.coldPercent)
            .put("warm", snap.warmPercent)
            .put("coldRaw", snap.coldRaw)
            .put("coldMin", snap.coldMin)
            .put("coldMax", snap.coldMax)
            .put("warmRaw", snap.warmRaw)
            .put("warmMin", snap.warmMin)
            .put("warmMax", snap.warmMax)
            .toString()
    }

    fun setFrontLightEnabled(enabled: Boolean): String {
        synchronized(frontLightLock) {
            val applied =
                if (isBooxHardware()) {
                    runCatching {
                        if (enabled) FrontLightController.turnOn(context) else FrontLightController.turnOff(context)
                        true
                    }.getOrDefault(false)
                } else {
                    true
                }
            if (applied) cachedLightEnabled = enabled
        }
        return getFrontLightStateJson()
    }

    fun setColdLightPercent(percent: Int): String {
        val clamped = percent.coerceIn(0, 100)
        synchronized(frontLightLock) {
            val (minVal, maxVal) = queryLightRange(cold = true)
            val raw = OnyxFrontLightSnapshot.percentToRaw(clamped, minVal, maxVal)
            val applied =
                if (isBooxHardware()) {
                    val primaryOk =
                        runCatching {
                            if (clamped > 0 && !cachedLightEnabled) FrontLightController.turnOn(context)
                            FrontLightController.setColdLightDeviceValue(context, raw)
                        }.getOrDefault(false)
                    if (primaryOk) {
                        true
                    } else {
                        runCatching {
                            FrontLightController.setBrightness(context, raw)
                            true
                        }.getOrDefault(false)
                    }
                } else {
                    true
                }
            if (applied) {
                cachedColdPercent = clamped
                if (clamped > 0 && !cachedLightEnabled) cachedLightEnabled = true
            }
        }
        return getFrontLightStateJson()
    }

    fun setWarmLightPercent(percent: Int): String {
        val clamped = percent.coerceIn(0, 100)
        synchronized(frontLightLock) {
            val (minVal, maxVal) = queryLightRange(cold = false)
            val raw = OnyxFrontLightSnapshot.percentToRaw(clamped, minVal, maxVal)
            val applied =
                if (isBooxHardware()) {
                    runCatching {
                        if (clamped > 0 && !cachedLightEnabled) FrontLightController.turnOn(context)
                        FrontLightController.setWarmLightDeviceValue(context, raw)
                    }.getOrDefault(false)
                } else {
                    true
                }
            if (applied) {
                cachedWarmPercent = clamped
                if (clamped > 0 && !cachedLightEnabled) cachedLightEnabled = true
            }
        }
        return getFrontLightStateJson()
    }

    private fun readFrontLightSnapshot(): OnyxFrontLightSnapshot {
        val boox = isBooxHardware()
        val supported = boox && queryHasFrontLight()
        val ctm = supported && queryHasCtmBrightness()
        val hwEnabled =
            if (boox) {
                runCatching { FrontLightController.isLightOn(context) }.getOrNull()
            } else {
                null
            }
        if (hwEnabled != null) {
            cachedLightEnabled = hwEnabled
        }
        val enabled = hwEnabled ?: cachedLightEnabled
        val (coldMin, coldMax) = queryLightRange(cold = true)
        val (warmMin, warmMax) = queryLightRange(cold = false)

        val coldRaw =
            if (boox) {
                runCatching { FrontLightController.getColdLightConfigValue(context) }.getOrNull()
                    ?: runCatching { FrontLightController.getBrightness(context) }.getOrNull()
                    ?: OnyxFrontLightSnapshot.percentToRaw(cachedColdPercent, coldMin, coldMax)
            } else {
                OnyxFrontLightSnapshot.percentToRaw(cachedColdPercent, coldMin, coldMax)
            }
        val warmRaw =
            if (boox) {
                runCatching { FrontLightController.getWarmLightConfigValue(context) }.getOrNull()
                    ?: OnyxFrontLightSnapshot.percentToRaw(cachedWarmPercent, warmMin, warmMax)
            } else {
                OnyxFrontLightSnapshot.percentToRaw(cachedWarmPercent, warmMin, warmMax)
            }

        val coldPercent =
            if (supported) {
                OnyxFrontLightSnapshot.rawToPercent(coldRaw, coldMin, coldMax)
            } else {
                cachedColdPercent
            }
        val warmPercent =
            if (supported) {
                OnyxFrontLightSnapshot.rawToPercent(warmRaw, warmMin, warmMax)
            } else {
                cachedWarmPercent
            }
        return OnyxFrontLightSnapshot(
            supported = supported,
            ctmSupported = ctm,
            enabled = enabled,
            coldPercent = coldPercent,
            warmPercent = warmPercent,
            coldRaw = coldRaw,
            coldMin = coldMin,
            coldMax = coldMax,
            warmRaw = warmRaw,
            warmMin = warmMin,
            warmMax = warmMax,
        )
    }

    private fun queryHasFrontLight(): Boolean =
        runCatching {
            FrontLightController.hasFLBrightness(context) || FrontLightController.hasCTMBrightness(context)
        }.getOrDefault(false)

    private fun queryHasCtmBrightness(): Boolean =
        runCatching { FrontLightController.hasCTMBrightness(context) }.getOrDefault(false)

    private fun queryLightRange(cold: Boolean): Pair<Int, Int> {
        if (!isBooxHardware()) return Pair(0, 32)
        val rawValues =
            runCatching {
                if (cold) FrontLightController.getColdLightValues(context) else FrontLightController.getWarmLightValues(context)
            }.getOrNull()
        val ints = rawValues?.map { it }?.filter { it >= 0 }.orEmpty()
        if (ints.isNotEmpty()) {
            return Pair(ints.minOrNull() ?: 0, ints.maxOrNull() ?: 255)
        }
        return Pair(0, 32)
    }

    // =========================================================================
    // 3. TouchHelper & RawInputCallback: Low-Latency Wacom EMR Scribble
    // =========================================================================

    fun configureScribble(
        webView: WebView?,
        enabled: Boolean,
        style: Int,
        strokeWidth: Float,
        limitRectJson: String?,
        excludeRectsJson: String?,
    ): String {
        val limit = parseCssRect(limitRectJson)
        val excludes = parseCssRectArray(excludeRectsJson)
        windowState.scribbleState.configure(enabled, style, strokeWidth, limit, excludes)
        syncRawDrawingState(webView)
        return buildScribbleStatusJson()
    }

    fun setScribbleModalSuspended(
        webView: WebView?,
        suspended: Boolean,
    ): String {
        val changed = windowState.scribbleState.setModalSuspended(suspended)
        if (changed || webView != null) {
            syncRawDrawingState(webView)
        }
        return buildScribbleStatusJson()
    }

    fun scribbleStatus(): String = buildScribbleStatusJson()

    fun onLifecycleResume(webView: WebView?) {
        syncRawDrawingState(webView)
    }

    fun onLifecyclePause(webView: WebView?) {
        cancelPendingEpdWork()
        val exitedFast = windowState.epdState.onLifecyclePause()
        if (exitedFast && isBooxHardware()) {
            val cleared = runCatching { EpdController.clearAppScopeUpdate(true) }.getOrDefault(false)
            if (!cleared) {
                runCatching { EpdController.applySystemFastMode(false) }
            }
        }
        windowState.scribbleState.onLifecyclePause()
        setNativeRawDrawingEnabled(false)
        flushCheckpointToDisk()
        closeActivePdfRenderer()
    }

    fun onLifecycleDestroy(webView: WebView?) {
        cancelPendingEpdWork()
        flushCheckpointToDisk()
        setNativeRawDrawingEnabled(false)
        val helper = touchHelperInstance
        if (helper != null) {
            runCatching { helper.closeRawDrawing() }
        }
        touchHelperInstance = null
        closeActivePdfRenderer()
        runCatching { ioExecutor.shutdownNow() }
    }

    private fun syncRawDrawingState(webView: WebView?) {
        val shouldEnable = isBooxHardware() && windowState.canEnableRawDrawing()
        if (!shouldEnable || webView == null) {
            setNativeRawDrawingEnabled(false)
            return
        }
        val helper = ensureTouchHelper(webView) ?: return
        val density =
            webView.resources.displayMetrics.density
                .coerceAtLeast(1.0f)
        val limitCss = windowState.scribbleState.limitRect ?: return
        val limitRect = cssToPhysicalRect(limitCss, density)
        val excludeRects = windowState.scribbleState.excludeRects.map { cssToPhysicalRect(it, density) }

        runCatching {
            helper.setStrokeWidth(windowState.scribbleState.strokeWidth * density)
            helper.setStrokeStyle(windowState.scribbleState.strokeStyle)
            helper.setLimitRect(limitRect, excludeRects)
            helper.enableSideBtnErase(true)
            if (!helper.isRawDrawingCreated()) {
                helper.openRawDrawing()
            }
            helper.setRawDrawingRenderEnabled(true)
            helper.setRawDrawingEnabled(true)
        }.onFailure { err ->
            Log.w("OnyxSdkBridge", "syncRawDrawingState failed", err)
        }
    }

    private fun setNativeRawDrawingEnabled(enabled: Boolean) {
        val helper = touchHelperInstance ?: return
        runCatching { helper.setRawDrawingEnabled(enabled) }
    }

    private fun ensureTouchHelper(webView: WebView): TouchHelper? {
        touchHelperInstance?.let { return it }
        if (!isBooxHardware()) return null
        val created =
            runCatching {
                TouchHelper.create(webView, PagewiseRawInputCallback(this, webView))
            }.onFailure { err ->
                Log.w("OnyxSdkBridge", "TouchHelper.create failed", err)
            }.getOrNull()
        touchHelperInstance = created
        return created
    }

    private class PagewiseRawInputCallback(
        private val bridge: OnyxSdkBridge,
        private val webView: WebView,
    ) : RawInputCallback() {
        override fun onBeginRawDrawing(
            b: Boolean,
            touchPoint: TouchPoint?,
        ) {}

        override fun onEndRawDrawing(
            b: Boolean,
            touchPoint: TouchPoint?,
        ) {}

        override fun onRawDrawingTouchPointMoveReceived(touchPoint: TouchPoint?) {}

        override fun onRawDrawingTouchPointListReceived(touchPointList: TouchPointList?) {
            val points = touchPointList?.getPoints() ?: return
            bridge.emitTouchPointListToWebView(webView, "stroke", points)
        }

        override fun onBeginRawErasing(
            b: Boolean,
            touchPoint: TouchPoint?,
        ) {}

        override fun onEndRawErasing(
            b: Boolean,
            touchPoint: TouchPoint?,
        ) {}

        override fun onRawErasingTouchPointMoveReceived(touchPoint: TouchPoint?) {}

        override fun onRawErasingTouchPointListReceived(touchPointList: TouchPointList?) {
            val points = touchPointList?.getPoints() ?: return
            bridge.emitTouchPointListToWebView(webView, "erase", points)
        }
    }

    private fun emitTouchPointListToWebView(
        webView: WebView,
        kind: String,
        rawPoints: List<TouchPoint>,
    ) {
        val density =
            webView.resources.displayMetrics.density
                .coerceAtLeast(1.0f)
        val maxPressure = maxTouchPressure.takeIf { it > 0f } ?: 4096f
        val pointsJson = JSONArray()
        for (pt in rawPoints) {
            val x = pt.x / density
            val y = pt.y / density
            val rawPressure = pt.pressure
            val pressure =
                if (rawPressure > 0f) {
                    (rawPressure / maxPressure).coerceIn(0.05f, 1.0f)
                } else {
                    0.5f
                }
            val size = pt.size.takeIf { it > 0f } ?: 1.0f
            val timestamp = pt.timestamp.takeIf { it > 0L } ?: System.currentTimeMillis()
            pointsJson.put(
                JSONObject()
                    .put("x", x.toDouble())
                    .put("y", y.toDouble())
                    .put("p", pressure.toDouble())
                    .put("s", size.toDouble())
                    .put("t", timestamp),
            )
        }
        if (pointsJson.length() == 0) return
        val eventJson =
            JSONObject()
                .put("kind", kind)
                .put("style", windowState.scribbleState.strokeStyle)
                .put("width", windowState.scribbleState.strokeWidth.toDouble())
                .put("points", pointsJson)
                .toString()
        webView.post {
            webView.evaluateJavascript("window.__pagewiseOnyxScribbleEvent?.($eventJson)", null)
        }
    }

    private fun buildScribbleStatusJson(): String =
        JSONObject()
            .put("enabled", windowState.scribbleState.enabled)
            .put("active", isBooxHardware() && windowState.canEnableRawDrawing() && touchHelperInstance != null)
            .put("nativeHelperReady", touchHelperInstance != null)
            .put("suspendedByModal", windowState.scribbleState.suspendedByModal)
            .put("strokeStyle", windowState.scribbleState.strokeStyle)
            .put("strokeWidth", windowState.scribbleState.strokeWidth.toDouble())
            .toString()

    // =========================================================================
    // 4. Device Model & System Property Helpers
    // =========================================================================

    private fun resolveDeviceModel(): String {
        val propModel = readSystemProperty("ro.onyx.model")
        if (propModel.isNotBlank()) return propModel
        return Build.MODEL ?: "BOOX"
    }

    private fun readSystemProperty(key: String): String =
        runCatching {
            val sysProp = Class.forName("android.os.SystemProperties")
            val getter = sysProp.getDeclaredMethod("get", String::class.java, String::class.java)
            getter.isAccessible = true
            (getter.invoke(null, key, "") as? String)?.trim().orEmpty()
        }.getOrDefault("")

    private fun parseCssRect(raw: String?): OnyxRectCss? {
        if (raw.isNullOrBlank()) return null
        return runCatching {
            val obj = JSONObject(raw)
            OnyxRectCss(
                left = obj.optDouble("left", 0.0).toFloat(),
                top = obj.optDouble("top", 0.0).toFloat(),
                right = obj.optDouble("right", 0.0).toFloat(),
                bottom = obj.optDouble("bottom", 0.0).toFloat(),
            )
        }.getOrNull()?.takeIf { it.valid }
    }

    private fun parseCssRectArray(raw: String?): List<OnyxRectCss> {
        if (raw.isNullOrBlank()) return emptyList()
        return runCatching {
            val arr = JSONArray(raw)
            val list = ArrayList<OnyxRectCss>(arr.length())
            for (i in 0 until arr.length()) {
                val obj = arr.optJSONObject(i) ?: continue
                val rect =
                    OnyxRectCss(
                        left = obj.optDouble("left", 0.0).toFloat(),
                        top = obj.optDouble("top", 0.0).toFloat(),
                        right = obj.optDouble("right", 0.0).toFloat(),
                        bottom = obj.optDouble("bottom", 0.0).toFloat(),
                    )
                if (rect.valid) list.add(rect)
            }
            list
        }.getOrDefault(emptyList())
    }

    private fun cssToPhysicalRect(
        css: OnyxRectCss,
        density: Float,
    ): Rect =
        Rect(
            kotlin.math.round(css.left * density).toInt(),
            kotlin.math.round(css.top * density).toInt(),
            kotlin.math.round(css.right * density).toInt(),
            kotlin.math.round(css.bottom * density).toInt(),
        )

    // =========================================================================
    // 5. Stage 1: Hardware Page-Turn Keys & Cover-Sleep Reading Checkpoint
    // =========================================================================

    fun configureHardwareKeys(
        capture: Boolean,
        volumeKeysEnabled: Boolean,
    ): String {
        windowState.hardwareKeyState.configure(capture, volumeKeysEnabled)
        return JSONObject()
            .put("captureEnabled", windowState.hardwareKeyState.captureEnabled)
            .put("volumeKeysEnabled", windowState.hardwareKeyState.volumeKeysEnabled)
            .toString()
    }

    fun handleHardwareKeyEvent(
        webView: WebView?,
        event: KeyEvent,
    ): Boolean {
        val audioActive =
            SystemTtsService.isActivelySpeaking() ||
                ((context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager)?.isMusicActive == true)
        val decision = windowState.evaluateHardwareKey(event.keyCode, event.action, event.repeatCount, audioActive)
        if (!decision.intercept) return false
        val direction = decision.direction
        if (direction != null && webView != null) {
            webView.post {
                webView.evaluateJavascript("window.__pagewiseHardwarePageTurn?.('$direction')", null)
            }
        }
        return true
    }

    fun stageReadingCheckpoint(
        bookId: String,
        cfi: String,
        progress: Double,
        readingDeltaSeconds: Int,
    ): Boolean = windowState.checkpointState.stage(bookId, cfi, progress, readingDeltaSeconds)

    fun consumeReadingCheckpointJson(): String {
        val cp = windowState.checkpointState.consume()
        val file = checkpointFile()
        if (file.exists()) {
            runCatching { file.delete() }
        }
        if (cp == null) return "{}"
        return JSONObject()
            .put("bookId", cp.bookId)
            .put("cfi", cp.cfi)
            .put("progress", cp.progress)
            .put("readingDeltaSeconds", cp.readingDeltaSeconds)
            .put("updatedAtMs", cp.updatedAtMs)
            .toString()
    }

    private fun checkpointFile(): File = File(context.filesDir, "onyx-reading-checkpoint.json")

    private fun flushCheckpointToDisk() {
        val dirty = windowState.checkpointState.peekDirtyForFlush() ?: return
        val written =
            runCatching {
                val payload =
                    JSONObject()
                        .put("bookId", dirty.bookId)
                        .put("cfi", dirty.cfi)
                        .put("progress", dirty.progress)
                        .put("readingDeltaSeconds", dirty.readingDeltaSeconds)
                        .put("updatedAtMs", dirty.updatedAtMs)
                        .toString()
                val target = checkpointFile()
                val temp = File(context.filesDir, "onyx-reading-checkpoint.tmp")
                FileOutputStream(temp).use { out ->
                    out.write(payload.toByteArray(Charsets.UTF_8))
                    out.fd.sync()
                }
                if (!temp.renameTo(target)) {
                    FileOutputStream(target).use { out ->
                        out.write(payload.toByteArray(Charsets.UTF_8))
                        out.fd.sync()
                    }
                    temp.delete()
                }
                true
            }.getOrDefault(false)
        if (written) {
            windowState.checkpointState.markFlushed(dirty)
        }
    }

    private fun restoreCheckpointFromDisk() {
        val file = checkpointFile()
        if (!file.isFile) return
        runCatching {
            val obj = JSONObject(file.readText(Charsets.UTF_8))
            val bookId = obj.optString("bookId", "").trim()
            if (bookId.isNotEmpty()) {
                windowState.checkpointState.restoreFromDisk(
                    OnyxReadingCheckpoint(
                        bookId = bookId,
                        cfi = obj.optString("cfi", ""),
                        progress = obj.optDouble("progress", 0.0).coerceIn(0.0, 1.0),
                        readingDeltaSeconds = obj.optInt("readingDeltaSeconds", 0).coerceAtLeast(0),
                        updatedAtMs = obj.optLong("updatedAtMs", 0L),
                    ),
                )
            }
        }
    }

    // =========================================================================
    // 6. Stage 2: Zero-Copy Android `content://` External Intent Ingestion
    // =========================================================================

    fun ingestExternalIntent(
        intent: Intent?,
        webView: WebView?,
    ) {
        if (intent == null) return
        val action = intent.action ?: return
        val uris = ArrayList<Uri>()
        if (action == Intent.ACTION_VIEW) {
            intent.data?.let { uris.add(it) }
        } else if (action == Intent.ACTION_SEND) {
            @Suppress("DEPRECATION")
            val streamUri = intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)
            if (streamUri != null) uris.add(streamUri)
        } else if (action == Intent.ACTION_SEND_MULTIPLE) {
            @Suppress("DEPRECATION")
            val list = intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)
            if (list != null) uris.addAll(list.filterNotNull())
        }
        if (uris.isEmpty() || ioExecutor.isShutdown) return

        try {
            ioExecutor.execute {
                val batch = ArrayList<JSONObject>()
                for (uri in uris) {
                    val staged = stageExternalUriToCache(uri) ?: continue
                    batch.add(staged)
                }
                if (batch.isEmpty()) return@execute
                synchronized(externalOpenQueue) {
                    externalOpenQueue.addAll(batch)
                }
                if (webView != null) {
                    webView.post {
                        webView.evaluateJavascript("window.__pagewiseNativeExternalOpen?.()", null)
                    }
                }
            }
        } catch (_: java.util.concurrent.RejectedExecutionException) {
            return
        }
    }

    fun drainExternalOpenQueueJson(): String {
        val arr = JSONArray()
        synchronized(externalOpenQueue) {
            for (item in externalOpenQueue) {
                arr.put(item)
            }
            externalOpenQueue.clear()
        }
        return arr.toString()
    }

    fun commitStagedExternalFile(
        stagedPath: String,
        targetRelPath: String,
    ): Boolean {
        return runCatching {
            val cacheRoot = context.cacheDir.canonicalFile
            val dataRoot = context.dataDir.canonicalFile
            val source = File(stagedPath).canonicalFile
            if (!source.path.startsWith(cacheRoot.path + File.separator) || !source.isFile) {
                return false
            }
            val cleanRel = targetRelPath.replace('\\', '/').trimStart('/')
            if (cleanRel.isEmpty() || cleanRel.contains("..")) return false
            val target = File(dataRoot, cleanRel).canonicalFile
            if (!target.path.startsWith(dataRoot.path + File.separator)) return false
            target.parentFile?.mkdirs()
            if (source.renameTo(target)) {
                return true
            }
            source.inputStream().use { input ->
                FileOutputStream(target).use { output ->
                    val buf = ByteArray(65536)
                    while (true) {
                        val n = input.read(buf)
                        if (n <= 0) break
                        output.write(buf, 0, n)
                    }
                    output.fd.sync()
                }
            }
            source.delete()
            true
        }.getOrDefault(false)
    }

    private fun stageExternalUriToCache(uri: Uri): JSONObject? {
        return runCatching {
            val displayName = resolveUriDisplayName(uri)
            val ext = displayName.substringAfterLast('.', "").lowercase(Locale.ROOT)
            val allowed = setOf("epub", "mobi", "pdf", "txt", "md", "markdown")
            if (ext !in allowed) return null
            val dest = File(context.cacheDir, "onyx-ext-${UUID.randomUUID()}.$ext")
            var totalBytes = 0L
            val maxBytes = 512L * 1024L * 1024L
            val input = context.contentResolver.openInputStream(uri) ?: return null
            input.use { stream ->
                FileOutputStream(dest).use { out ->
                    val buf = ByteArray(65536)
                    while (true) {
                        val read = stream.read(buf)
                        if (read <= 0) break
                        totalBytes += read
                        if (totalBytes > maxBytes) {
                            dest.delete()
                            return null
                        }
                        out.write(buf, 0, read)
                    }
                    out.fd.sync()
                }
            }
            if (totalBytes <= 0L) {
                dest.delete()
                return null
            }
            JSONObject()
                .put("stagedPath", dest.canonicalPath)
                .put("fileName", displayName)
                .put("ext", ext)
                .put("size", totalBytes)
        }.getOrNull()
    }

    private fun resolveUriDisplayName(uri: Uri): String {
        if (uri.scheme == "content") {
            runCatching {
                context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                    if (cursor.moveToFirst()) {
                        val idx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                        if (idx >= 0) {
                            val name = cursor.getString(idx)?.trim()
                            if (!name.isNullOrEmpty()) return name
                        }
                    }
                }
            }
        }
        return uri.lastPathSegment?.substringAfterLast('/')?.takeIf { it.isNotBlank() } ?: "book.epub"
    }

    // =========================================================================
    // 7. Stage 3: Native ZipFile Central-Directory EPUB Full-Text Search
    // =========================================================================

    fun searchNativeEpubText(
        bookRelPath: String,
        query: String,
        maxHits: Int,
    ): String {
        val cleanQuery = query.trim()
        if (cleanQuery.isEmpty() || maxHits <= 0) return "[]"
        val file = resolveSafeBookFile(bookRelPath) ?: return "[]"
        return runCatching {
            val hitsArray = JSONArray()
            var totalHits = 0
            ZipFile(file).use { zip ->
                val entries = zip.entries()
                while (entries.hasMoreElements() && totalHits < maxHits) {
                    val entry = entries.nextElement()
                    if (entry.isDirectory) continue
                    val nameLower = entry.name.lowercase(Locale.ROOT)
                    if (!nameLower.endsWith(".xhtml") && !nameLower.endsWith(".html") && !nameLower.endsWith(".htm")) {
                        continue
                    }
                    if (entry.size > 8L * 1024L * 1024L) continue
                    val xml = zip.getInputStream(entry).bufferedReader(Charsets.UTF_8).use { it.readText() }
                    val plain = OnyxEpubTextMatcher.stripXmlToPlainText(xml)
                    val remaining = (maxHits - totalHits).coerceAtMost(20)
                    val excerpts = OnyxEpubTextMatcher.findExcerpts(plain, cleanQuery, remaining)
                    if (excerpts.isNotEmpty()) {
                        val excJson = JSONArray()
                        for (ex in excerpts) excJson.put(ex)
                        hitsArray.put(
                            JSONObject()
                                .put("href", entry.name)
                                .put("count", excerpts.size)
                                .put("excerpts", excJson),
                        )
                        totalHits += excerpts.size
                    }
                }
            }
            hitsArray.toString()
        }.getOrDefault("[]")
    }

    // =========================================================================
    // 8. Stage 4: Native Android `PdfRenderer` Low-Memory Page Rasterizer
    // =========================================================================

    @Synchronized
    fun openNativePdfInfo(bookRelPath: String): String {
        val renderer = ensurePdfRenderer(bookRelPath) ?: return "{}"
        return runCatching {
            val pageCount = renderer.pageCount
            var firstW = 0
            var firstH = 0
            if (pageCount > 0) {
                renderer.openPage(0).use { page ->
                    firstW = page.width
                    firstH = page.height
                }
            }
            JSONObject()
                .put("supported", true)
                .put("pageCount", pageCount)
                .put("firstPageWidth", firstW)
                .put("firstPageHeight", firstH)
                .toString()
        }.getOrDefault("{}")
    }

    @Synchronized
    fun renderNativePdfPageDataUrl(
        bookRelPath: String,
        pageNumber: Int,
        targetWidth: Int,
        targetHeight: Int,
    ): String {
        val renderer = ensurePdfRenderer(bookRelPath) ?: return ""
        val pageIndex = pageNumber - 1
        if (pageIndex < 0 || pageIndex >= renderer.pageCount) return ""
        val w = targetWidth.coerceIn(64, 4096)
        val h = targetHeight.coerceIn(64, 4096)
        return runCatching {
            val bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
            try {
                val canvas = Canvas(bitmap)
                canvas.drawColor(Color.WHITE)
                renderer.openPage(pageIndex).use { page ->
                    page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                }
                val out = ByteArrayOutputStream(65536)
                bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
                "data:image/png;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
            } finally {
                bitmap.recycle()
            }
        }.getOrDefault("")
    }

    @Synchronized
    private fun ensurePdfRenderer(bookRelPath: String): PdfRenderer? {
        val file = resolveSafeBookFile(bookRelPath) ?: return null
        val canonical = file.canonicalPath
        if (activePdfPath == canonical && activePdfRenderer != null) {
            return activePdfRenderer
        }
        closeActivePdfRenderer()
        var pfd: ParcelFileDescriptor? = null
        return try {
            val opened = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
            pfd = opened
            val renderer = PdfRenderer(opened)
            activePdfPath = canonical
            activePdfDescriptor = opened
            activePdfRenderer = renderer
            renderer
        } catch (_: Throwable) {
            runCatching { pfd?.close() }
            null
        }
    }

    @Synchronized
    private fun closeActivePdfRenderer() {
        runCatching { activePdfRenderer?.close() }
        runCatching { activePdfDescriptor?.close() }
        activePdfRenderer = null
        activePdfDescriptor = null
        activePdfPath = null
    }

    private fun resolveSafeBookFile(bookRelPath: String): File? {
        val cleanRel = bookRelPath.replace('\\', '/').trimStart('/')
        if (cleanRel.isEmpty() || cleanRel.contains("..")) return null
        return runCatching {
            for (root in listOf(context.dataDir.canonicalFile, context.filesDir.canonicalFile)) {
                val target = File(root, cleanRel).canonicalFile
                if (target.path.startsWith(root.path + File.separator) && target.isFile) {
                    return@runCatching target
                }
            }
            null
        }.getOrNull()
    }

    // =========================================================================
    // 9. Stage 5: System Dictionary Lookup & Ex Libris Sleep Cover Generator
    // =========================================================================

    fun lookupSystemDictionary(rawWord: String): Boolean {
        val word = rawWord.trim().take(120)
        if (word.isEmpty()) return false
        return runCatching {
            val intent =
                Intent(Intent.ACTION_PROCESS_TEXT).apply {
                    type = "text/plain"
                    putExtra(Intent.EXTRA_PROCESS_TEXT, word)
                    putExtra(Intent.EXTRA_PROCESS_TEXT_READONLY, true)
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
            val pm = context.packageManager
            if (intent.resolveActivity(pm) != null) {
                try {
                    context.startActivity(intent)
                    return true
                } catch (_: ActivityNotFoundException) {
                    // Fall through to search intent
                }
            }
            val searchIntent =
                Intent(Intent.ACTION_SEARCH).apply {
                    putExtra("query", word)
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
            if (searchIntent.resolveActivity(pm) != null) {
                try {
                    context.startActivity(searchIntent)
                    return true
                } catch (_: ActivityNotFoundException) {
                    return false
                }
            }
            false
        }.getOrDefault(false)
    }

    private fun decodeScaledCoverBitmap(
        file: File,
        maxW: Int,
        maxH: Int,
    ): Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.absolutePath, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        var sample = 1
        while (bounds.outWidth / sample > maxW * 2 && bounds.outHeight / sample > maxH * 2) {
            sample *= 2
        }
        val opts = BitmapFactory.Options().apply { inSampleSize = sample.coerceAtLeast(1) }
        return BitmapFactory.decodeFile(file.absolutePath, opts)
    }

    private fun exportSleepCoverToMediaStore(bmp: Bitmap) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
        runCatching {
            val resolver = context.contentResolver
            val prefs = context.getSharedPreferences("pagewise_onyx_prefs", Context.MODE_PRIVATE)
            val existingUriStr = prefs.getString("sleep_cover_uri", null)
            if (!existingUriStr.isNullOrBlank()) {
                val overwritten =
                    runCatching {
                        val existingUri = Uri.parse(existingUriStr)
                        resolver.openOutputStream(existingUri, "wt")?.use { out ->
                            if (!bmp.compress(Bitmap.CompressFormat.PNG, 100, out)) {
                                throw IllegalStateException("PNG compression failed")
                            }
                        } ?: throw IllegalStateException("Unable to open saved MediaStore URI")
                        true
                    }.getOrDefault(false)
                if (overwritten) return
            }
            val collection = MediaStore.Images.Media.EXTERNAL_CONTENT_URI
            val relPath = "Pictures/Screensaver"
            runCatching {
                resolver.delete(
                    collection,
                    "${MediaStore.MediaColumns.DISPLAY_NAME} = ? AND ${MediaStore.MediaColumns.RELATIVE_PATH} LIKE ?",
                    arrayOf("pagewise_sleep_cover.png", "$relPath%"),
                )
            }
            val values =
                ContentValues().apply {
                    put(MediaStore.MediaColumns.DISPLAY_NAME, "pagewise_sleep_cover.png")
                    put(MediaStore.MediaColumns.MIME_TYPE, "image/png")
                    put(MediaStore.MediaColumns.RELATIVE_PATH, relPath)
                    put(MediaStore.MediaColumns.IS_PENDING, 1)
                }
            val uri = resolver.insert(collection, values) ?: return
            var committed = false
            try {
                resolver.openOutputStream(uri)?.use { out ->
                    if (!bmp.compress(Bitmap.CompressFormat.PNG, 100, out)) {
                        throw IllegalStateException("PNG compression failed")
                    }
                } ?: throw IllegalStateException("Unable to open MediaStore stream")
                values.clear()
                values.put(MediaStore.MediaColumns.IS_PENDING, 0)
                resolver.update(uri, values, null, null)
                prefs.edit().putString("sleep_cover_uri", uri.toString()).apply()
                committed = true
            } finally {
                if (!committed) runCatching { resolver.delete(uri, null, null) }
            }
        }
    }

    fun generateSleepCover(
        title: String,
        author: String,
        progressPercent: Int,
        coverRelPath: String,
    ): String {
        val cleanTitle = title.trim().ifEmpty { "Pagewise" }
        val cleanAuthor = author.trim()
        val pct = progressPercent.coerceIn(0, 100)
        if (ioExecutor.isShutdown) return ""
        val outDir = File(context.dataDir, "exports").apply { mkdirs() }
        val outFile = File(outDir, "pagewise_sleep_cover.png")
        try {
            ioExecutor.execute {
                runCatching {
                    val metrics = context.resources.displayMetrics
                    val w = metrics.widthPixels.takeIf { it >= 320 } ?: 1404
                    val h = metrics.heightPixels.takeIf { it >= 320 } ?: 1872
                    val sx = w / 1404f
                    val sy = h / 1872f
                    val sMin = minOf(sx, sy)
                    val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
                    try {
                        val canvas = Canvas(bmp)
                        canvas.drawColor(Color.WHITE)
                        val inkPaint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply { color = Color.BLACK }
                        val subPaint =
                            android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply {
                                color = Color.parseColor("#444444")
                                textAlign = android.graphics.Paint.Align.CENTER
                            }
                        val rulePaint =
                            android.graphics.Paint().apply {
                                color = Color.BLACK
                                style = android.graphics.Paint.Style.STROKE
                                strokeWidth = 6f * sMin
                            }
                        canvas.drawRect(72f * sx, 72f * sy, w - 72f * sx, h - 72f * sy, rulePaint)
                        rulePaint.strokeWidth = 2f * sMin
                        rulePaint.color = Color.parseColor("#BBBBBB")
                        canvas.drawRect(88f * sx, 88f * sy, w - 88f * sx, h - 88f * sy, rulePaint)

                        subPaint.textSize = 28f * sMin
                        subPaint.typeface = android.graphics.Typeface.MONOSPACE
                        canvas.drawText("EX LIBRIS · PAGEWISE", w / 2f, 180f * sy, subPaint)

                        val boxW = 640f * sMin
                        val boxH = 880f * sMin
                        val coverFile = if (coverRelPath.isNotBlank()) resolveSafeBookFile(coverRelPath) else null
                        val coverBmp = coverFile?.let { decodeScaledCoverBitmap(it, boxW.toInt().coerceAtLeast(120), boxH.toInt().coerceAtLeast(160)) }
                        if (coverBmp != null) {
                            val cw = coverBmp.width.coerceAtLeast(1).toFloat()
                            val ch = coverBmp.height.coerceAtLeast(1).toFloat()
                            val fitScale = minOf(boxW / cw, boxH / ch)
                            val dw = cw * fitScale
                            val dh = ch * fitScale
                            val left = (w - dw) / 2f
                            val top = 260f * sy + (boxH - dh) / 2f
                            val dest = android.graphics.RectF(left, top, left + dw, top + dh)
                            canvas.drawBitmap(coverBmp, null, dest, null)
                            rulePaint.color = Color.BLACK
                            rulePaint.strokeWidth = 4f * sMin
                            canvas.drawRect(dest, rulePaint)
                            coverBmp.recycle()
                        }

                        inkPaint.textAlign = android.graphics.Paint.Align.CENTER
                        inkPaint.textSize = 54f * sMin
                        inkPaint.typeface = android.graphics.Typeface.create(android.graphics.Typeface.SERIF, android.graphics.Typeface.BOLD)
                        canvas.drawText(cleanTitle.take(28), w / 2f, 1280f * sy, inkPaint)

                        if (cleanAuthor.isNotEmpty()) {
                            subPaint.textSize = 36f * sMin
                            subPaint.typeface = android.graphics.Typeface.SERIF
                            canvas.drawText(cleanAuthor.take(40), w / 2f, 1355f * sy, subPaint)
                        }

                        val barLeft = 280f * sx
                        val barRight = w - 280f * sx
                        val barTop = 1460f * sy
                        val barBottom = 1484f * sy
                        rulePaint.color = Color.BLACK
                        rulePaint.strokeWidth = 3f * sMin
                        canvas.drawRect(barLeft, barTop, barRight, barBottom, rulePaint)
                        if (pct > 0) {
                            inkPaint.style = android.graphics.Paint.Style.FILL
                            canvas.drawRect(barLeft, barTop, barLeft + (barRight - barLeft) * (pct / 100f), barBottom, inkPaint)
                        }
                        subPaint.textSize = 28f * sMin
                        subPaint.typeface = android.graphics.Typeface.MONOSPACE
                        canvas.drawText("READING PROGRESS · $pct%", w / 2f, 1545f * sy, subPaint)

                        FileOutputStream(outFile).use { out ->
                            bmp.compress(Bitmap.CompressFormat.PNG, 100, out)
                            out.fd.sync()
                        }
                        exportSleepCoverToMediaStore(bmp)
                    } finally {
                        bmp.recycle()
                    }
                }
            }
        } catch (_: java.util.concurrent.RejectedExecutionException) {
            return ""
        }
        return outFile.absolutePath
    }
}
