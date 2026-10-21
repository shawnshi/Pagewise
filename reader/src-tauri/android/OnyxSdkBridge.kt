package io.pagewise.reader

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Rect
import android.graphics.pdf.PdfRenderer
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import android.util.Base64
import android.view.KeyEvent
import android.view.View
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.lang.reflect.InvocationHandler
import java.lang.reflect.Method
import java.lang.reflect.Proxy
import java.util.Locale
import java.util.UUID
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
    private val epdClass: Class<*>? = findClass("com.onyx.android.sdk.api.device.epd.EpdController")
    private val updateModeClass: Class<*>? = findClass("com.onyx.android.sdk.api.device.epd.UpdateMode")
    private val frontLightClass: Class<*>? = findClass("com.onyx.android.sdk.api.device.FrontLightController")
    private val deviceClass: Class<*>? = findClass("com.onyx.android.sdk.device.Device")
    private val deviceUtilsClass: Class<*>? = findClass("com.onyx.android.sdk.utils.DeviceUtils")
    private val deviceEnvClass: Class<*>? = findClass("com.onyx.android.sdk.device.DeviceEnvironment")
    private val touchHelperClass: Class<*>? = findClass("com.onyx.android.sdk.pen.TouchHelper")
    private val rawInputCallbackClass: Class<*>? = findClass("com.onyx.android.sdk.pen.RawInputCallback")

    private val epdHandler = Handler(Looper.getMainLooper())
    private var pendingFastExit: Runnable? = null
    private var pendingOverlayRepaint: Runnable? = null

    private var touchHelperInstance: Any? = null
    private val externalOpenQueue = ArrayList<JSONObject>()
    private var activePdfPath: String? = null
    private var activePdfDescriptor: ParcelFileDescriptor? = null
    private var activePdfRenderer: PdfRenderer? = null

    init {
        restoreCheckpointFromDisk()
    }

    fun isBooxHardware(): Boolean {
        val brands =
            listOf(Build.MANUFACTURER, Build.BRAND, Build.DEVICE, Build.PRODUCT)
                .mapNotNull { it?.lowercase(Locale.ROOT) }
        if (brands.any { it.contains("onyx") || it.contains("boox") }) return true
        val sysBrand = readSystemProperty("ro.product.manufacturer").lowercase(Locale.ROOT)
        if (sysBrand.contains("onyx") || sysBrand.contains("boox")) return true
        if (readSystemProperty("ro.onyx.model").isNotEmpty()) return true
        return epdClass != null || deviceClass != null
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
        val hasFrontLight = queryHasFrontLight() || boox
        val hasCtm = queryHasCtmBrightness() || boox
        val sdkReady = epdClass != null || frontLightClass != null || deviceClass != null
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
            .put("epdController", epdClass != null || boox)
            .put("frontLight", hasFrontLight)
            .put("ctmLight", hasCtm)
            .put("stylus", touchHelperClass != null || boox)
            .put("colorEink", colorEink)
            .toString()
    }

    // =========================================================================
    // 1. EpdController: Waveform & Refresh Control
    // =========================================================================

    fun attachWebView(webView: WebView) {
        invokeStatic(
            epdClass,
            "setWebViewContrastOptimize",
            arrayOf(View::class.java, Boolean::class.javaPrimitiveType!!),
            arrayOf(webView, true),
        )
        applyViewDefaultUpdateMode(webView, windowState.epdState.defaultMode)
    }

    fun configureGcInterval(pages: Int): String {
        windowState.epdState.configureGcInterval(pages)
        return buildEpdStatusJson()
    }

    fun notifyPageTurn(webView: WebView?): String {
        val targetMode = windowState.epdState.recordPageTurn()
        if (targetMode == OnyxWaveformMode.GC) {
            repaintScreen(webView, OnyxWaveformMode.GC)
        } else {
            repaintScreen(webView, targetMode)
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
        val task =
            Runnable {
                pendingOverlayRepaint = null
                if (windowState.resumed) repaintScreen(webView, if (mode == "gc") "gc" else "regal")
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
            if (changed) {
                invokeStatic(
                    epdClass,
                    "applyApplicationFastMode",
                    arrayOf(String::class.java, Boolean::class.javaPrimitiveType!!, Boolean::class.javaPrimitiveType!!),
                    arrayOf(context.packageName, true, true),
                )
                if (webView != null) applyViewDefaultUpdateMode(webView, fastMode)
            }
        } else {
            val wasFast = windowState.epdState.exitFastMode()
            if (wasFast) {
                invokeStatic(
                    epdClass,
                    "applyApplicationFastMode",
                    arrayOf(String::class.java, Boolean::class.javaPrimitiveType!!, Boolean::class.javaPrimitiveType!!),
                    arrayOf(context.packageName, false, true),
                )
                if (webView != null) {
                    applyViewDefaultUpdateMode(webView, windowState.epdState.defaultMode)
                    repaintScreen(webView, OnyxWaveformMode.REGAL)
                }
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
        val enumVal = resolveUpdateModeEnum(mode)
        if (enumVal != null && updateModeClass != null) {
            val repainted =
                invokeStatic(
                    epdClass,
                    "repaintEveryThing",
                    arrayOf(updateModeClass),
                    arrayOf(enumVal),
                )
            if (!repainted && webView != null) {
                invokeStatic(
                    epdClass,
                    "invalidate",
                    arrayOf(View::class.java, updateModeClass),
                    arrayOf(webView, enumVal),
                )
            }
        }
        webView?.postInvalidate()
    }

    private fun applyViewDefaultUpdateMode(
        webView: WebView,
        mode: OnyxWaveformMode,
    ) {
        val enumVal = resolveUpdateModeEnum(mode) ?: return
        val modeCls = updateModeClass ?: return
        invokeStatic(
            epdClass,
            "setViewDefaultUpdateMode",
            arrayOf(View::class.java, modeCls),
            arrayOf(webView, enumVal),
        )
    }

    private fun resolveUpdateModeEnum(mode: OnyxWaveformMode): Any? {
        val cls = updateModeClass ?: return null
        val constants = cls.enumConstants ?: return null
        for (candidate in mode.sdkCandidates) {
            for (constant in constants) {
                if ((constant as? Enum<*>)?.name.equals(candidate, ignoreCase = true)) {
                    return constant
                }
            }
        }
        return constants.firstOrNull()
    }

    private fun buildEpdStatusJson(): String =
        JSONObject()
            .put("mode", windowState.epdState.currentMode.wireName)
            .put("defaultMode", windowState.epdState.defaultMode.wireName)
            .put("fastMode", windowState.epdState.fastModeActive)
            .put("scene", windowState.epdState.fastScene)
            .put("pageTurnCount", windowState.epdState.pageTurnCount)
            .put("gcIntervalPages", windowState.epdState.gcIntervalPages)
            .toString()

    // =========================================================================
    // 2. FrontLightController: Dual-Color-Temperature (Cold & Warm) Control
    // =========================================================================

    private var cachedColdPercent: Int = 45
    private var cachedWarmPercent: Int = 35
    private var cachedLightEnabled: Boolean = true

    fun getFrontLightStateJson(): String {
        val snap = readFrontLightSnapshot()
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
        cachedLightEnabled = enabled
        val method = if (enabled) "openFrontLight" else "closeFrontLight"
        invokeStatic(frontLightClass, method, arrayOf(Context::class.java), arrayOf(context))
        return getFrontLightStateJson()
    }

    fun setColdLightPercent(percent: Int): String {
        val clamped = percent.coerceIn(0, 100)
        cachedColdPercent = clamped
        val (minVal, maxVal) = queryLightRange("getColdLightValues")
        val raw = OnyxFrontLightSnapshot.percentToRaw(clamped, minVal, maxVal)
        val ok =
            invokeStatic(
                frontLightClass,
                "setColdLightDeviceValue",
                arrayOf(Context::class.java, Int::class.javaPrimitiveType!!),
                arrayOf(context, raw),
            )
        if (!ok) {
            invokeStatic(
                frontLightClass,
                "setBrightness",
                arrayOf(Context::class.java, Int::class.javaPrimitiveType!!),
                arrayOf(context, raw),
            )
        }
        if (clamped > 0 && !cachedLightEnabled) {
            setFrontLightEnabled(true)
        }
        return getFrontLightStateJson()
    }

    fun setWarmLightPercent(percent: Int): String {
        val clamped = percent.coerceIn(0, 100)
        cachedWarmPercent = clamped
        val (minVal, maxVal) = queryLightRange("getWarmLightValues")
        val raw = OnyxFrontLightSnapshot.percentToRaw(clamped, minVal, maxVal)
        invokeStatic(
            frontLightClass,
            "setWarmLightDeviceValue",
            arrayOf(Context::class.java, Int::class.javaPrimitiveType!!),
            arrayOf(context, raw),
        )
        if (clamped > 0 && !cachedLightEnabled) {
            setFrontLightEnabled(true)
        }
        return getFrontLightStateJson()
    }

    private fun readFrontLightSnapshot(): OnyxFrontLightSnapshot {
        val supported = queryHasFrontLight() || isBooxHardware()
        val ctm = queryHasCtmBrightness() || isBooxHardware()
        val enabled =
            invokeStaticReturn(frontLightClass, "isFrontLightOn", arrayOf(Context::class.java), arrayOf(context)) as? Boolean
                ?: cachedLightEnabled
        val (coldMin, coldMax) = queryLightRange("getColdLightValues")
        val (warmMin, warmMax) = queryLightRange("getWarmLightValues")

        val coldRaw =
            (
                invokeStaticReturn(
                    frontLightClass,
                    "getColdLightConfigValue",
                    arrayOf(Context::class.java),
                    arrayOf(context),
                ) as? Number
            )?.toInt()
                ?: (
                    invokeStaticReturn(
                        frontLightClass,
                        "getBrightness",
                        arrayOf(Context::class.java),
                        arrayOf(context),
                    ) as? Number
                )?.toInt()
                ?: OnyxFrontLightSnapshot.percentToRaw(cachedColdPercent, coldMin, coldMax)
        val warmRaw =
            (
                invokeStaticReturn(
                    frontLightClass,
                    "getWarmLightConfigValue",
                    arrayOf(Context::class.java),
                    arrayOf(context),
                ) as? Number
            )?.toInt()
                ?: OnyxFrontLightSnapshot.percentToRaw(cachedWarmPercent, warmMin, warmMax)

        val coldPercent =
            if (frontLightClass != null) {
                OnyxFrontLightSnapshot.rawToPercent(coldRaw, coldMin, coldMax)
            } else {
                cachedColdPercent
            }
        val warmPercent =
            if (frontLightClass != null) {
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
        invokeStaticReturn(frontLightClass, "hasFrontLight", arrayOf(Context::class.java), arrayOf(context)) as? Boolean ?: false

    private fun queryHasCtmBrightness(): Boolean =
        invokeStaticReturn(frontLightClass, "hasCTMBrightness", arrayOf(Context::class.java), arrayOf(context)) as? Boolean ?: false

    private fun queryLightRange(valuesMethod: String): Pair<Int, Int> {
        val rawValues = invokeStaticReturn(frontLightClass, valuesMethod, arrayOf(Context::class.java), arrayOf(context))
        when (rawValues) {
            is IntArray -> {
                if (rawValues.isNotEmpty()) return Pair(rawValues.minOrNull() ?: 0, rawValues.maxOrNull() ?: 255)
            }

            is Array<*> -> {
                val ints = rawValues.mapNotNull { (it as? Number)?.toInt() }
                if (ints.isNotEmpty()) return Pair(ints.minOrNull() ?: 0, ints.maxOrNull() ?: 255)
            }

            is Collection<*> -> {
                val ints = rawValues.mapNotNull { (it as? Number)?.toInt() }
                if (ints.isNotEmpty()) return Pair(ints.minOrNull() ?: 0, ints.maxOrNull() ?: 255)
            }
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
        if (changed) {
            syncRawDrawingState(webView)
        }
        return buildScribbleStatusJson()
    }

    fun onLifecycleResume(webView: WebView?) {
        syncRawDrawingState(webView)
    }

    fun onLifecyclePause(webView: WebView?) {
        cancelPendingEpdWork()
        val exitedFast = windowState.epdState.onLifecyclePause()
        if (exitedFast) {
            invokeStatic(
                epdClass,
                "applyApplicationFastMode",
                arrayOf(String::class.java, Boolean::class.javaPrimitiveType!!, Boolean::class.javaPrimitiveType!!),
                arrayOf(context.packageName, false, true),
            )
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
            invokeInstance(helper, "closeRawDrawing", emptyArray(), emptyArray())
        }
        touchHelperInstance = null
        closeActivePdfRenderer()
    }

    private fun syncRawDrawingState(webView: WebView?) {
        val shouldEnable = windowState.canEnableRawDrawing()
        if (!shouldEnable || webView == null) {
            setNativeRawDrawingEnabled(false)
            return
        }
        val helper = ensureTouchHelper(webView)
        val density =
            webView.resources.displayMetrics.density
                .coerceAtLeast(1.0f)
        val limitCss = windowState.scribbleState.limitRect ?: return
        val limitRect = cssToPhysicalRect(limitCss, density)
        val excludeRects = windowState.scribbleState.excludeRects.map { cssToPhysicalRect(it, density) }

        if (helper != null) {
            invokeInstance(
                helper,
                "setStrokeWidth",
                arrayOf(Float::class.javaPrimitiveType!!),
                arrayOf(windowState.scribbleState.strokeWidth * density),
            )
            invokeInstance(
                helper,
                "setStrokeStyle",
                arrayOf(Int::class.javaPrimitiveType!!),
                arrayOf(windowState.scribbleState.strokeStyle),
            )
            invokeInstance(helper, "setLimitRect", arrayOf(Rect::class.java, java.util.List::class.java), arrayOf(limitRect, excludeRects))
            invokeInstance(helper, "openRawDrawing", emptyArray(), emptyArray())
            invokeInstance(helper, "setRawDrawingRenderEnabled", arrayOf(Boolean::class.javaPrimitiveType!!), arrayOf(true))
            invokeInstance(helper, "setRawDrawingEnabled", arrayOf(Boolean::class.javaPrimitiveType!!), arrayOf(true))
        }
    }

    private fun setNativeRawDrawingEnabled(enabled: Boolean) {
        val helper = touchHelperInstance ?: return
        invokeInstance(helper, "setRawDrawingEnabled", arrayOf(Boolean::class.javaPrimitiveType!!), arrayOf(enabled))
    }

    private fun ensureTouchHelper(webView: WebView): Any? {
        if (touchHelperInstance != null) return touchHelperInstance
        val helperCls = touchHelperClass ?: return null
        val callbackCls = rawInputCallbackClass ?: return null
        if (!callbackCls.isInterface) {
            return null
        }
        val callbackProxy =
            Proxy.newProxyInstance(
                callbackCls.classLoader,
                arrayOf(callbackCls),
                InvocationHandler { _, method, args ->
                    handleRawInputCallback(webView, method.name, args)
                },
            )
        touchHelperInstance =
            invokeStaticReturn(
                helperCls,
                "create",
                arrayOf(View::class.java, callbackCls),
                arrayOf(webView, callbackProxy),
            )
        return touchHelperInstance
    }

    private fun handleRawInputCallback(
        webView: WebView,
        methodName: String,
        args: Array<out Any?>?,
    ): Any? {
        when (methodName) {
            "onRawDrawingTouchPointListReceived" -> {
                val pointList = args?.getOrNull(0) ?: return null
                emitTouchPointListToWebView(webView, "stroke", pointList)
            }

            "onRawErasingTouchPointListReceived" -> {
                val pointList = args?.getOrNull(0) ?: return null
                emitTouchPointListToWebView(webView, "erase", pointList)
            }
        }
        return null
    }

    private fun emitTouchPointListToWebView(
        webView: WebView,
        kind: String,
        pointListObj: Any,
    ) {
        val density =
            webView.resources.displayMetrics.density
                .coerceAtLeast(1.0f)
        val rawPoints = invokeInstanceReturn(pointListObj, "getPoints", emptyArray(), emptyArray()) as? Iterable<*> ?: return
        val pointsJson = JSONArray()
        for (pt in rawPoints) {
            if (pt == null) continue
            val x = readFloatFieldOrGetter(pt, "x") / density
            val y = readFloatFieldOrGetter(pt, "y") / density
            val pressure = readFloatFieldOrGetter(pt, "pressure", 0.5f)
            val size = readFloatFieldOrGetter(pt, "size", 1.0f)
            val timestamp = readLongFieldOrGetter(pt, "timestamp", System.currentTimeMillis())
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
            .put("active", windowState.canEnableRawDrawing())
            .put("suspendedByModal", windowState.scribbleState.suspendedByModal)
            .put("strokeStyle", windowState.scribbleState.strokeStyle)
            .put("strokeWidth", windowState.scribbleState.strokeWidth.toDouble())
            .toString()

    // =========================================================================
    // 4. DeviceUtils / DeviceEnvironment & Reflection Helpers
    // =========================================================================

    private fun resolveDeviceModel(): String {
        val fromUtils = invokeStaticReturn(deviceUtilsClass, "getDeviceModel", emptyArray(), emptyArray()) as? String
        if (!fromUtils.isNullOrBlank()) return fromUtils
        val fromEnv = invokeStaticReturn(deviceEnvClass, "getDeviceModel", emptyArray(), emptyArray()) as? String
        if (!fromEnv.isNullOrBlank()) return fromEnv
        val propModel = readSystemProperty("ro.onyx.model")
        if (propModel.isNotBlank()) return propModel
        return Build.MODEL ?: "BOOX"
    }

    private fun readSystemProperty(key: String): String {
        val sysProp = findClass("android.os.SystemProperties") ?: return ""
        return (invokeStaticReturn(sysProp, "get", arrayOf(String::class.java, String::class.java), arrayOf(key, "")) as? String)
            ?.trim()
            .orEmpty()
    }

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

    private fun findClass(name: String): Class<*>? = runCatching { Class.forName(name) }.getOrNull()

    private fun invokeStatic(
        cls: Class<*>?,
        methodName: String,
        paramTypes: Array<Class<*>>,
        args: Array<Any?>,
    ): Boolean {
        if (cls == null) return false
        return runCatching {
            val m: Method = cls.getDeclaredMethod(methodName, *paramTypes)
            m.isAccessible = true
            m.invoke(null, *args)
            true
        }.getOrDefault(false)
    }

    private fun invokeStaticReturn(
        cls: Class<*>?,
        methodName: String,
        paramTypes: Array<Class<*>>,
        args: Array<Any?>,
    ): Any? {
        if (cls == null) return null
        return runCatching {
            val m: Method = cls.getDeclaredMethod(methodName, *paramTypes)
            m.isAccessible = true
            m.invoke(null, *args)
        }.getOrNull()
    }

    private fun invokeInstance(
        target: Any,
        methodName: String,
        paramTypes: Array<Class<*>>,
        args: Array<Any?>,
    ): Boolean =
        runCatching {
            val m: Method = target.javaClass.getMethod(methodName, *paramTypes)
            m.isAccessible = true
            m.invoke(target, *args)
            true
        }.getOrDefault(false)

    private fun invokeInstanceReturn(
        target: Any,
        methodName: String,
        paramTypes: Array<Class<*>>,
        args: Array<Any?>,
    ): Any? =
        runCatching {
            val m: Method = target.javaClass.getMethod(methodName, *paramTypes)
            m.isAccessible = true
            m.invoke(target, *args)
        }.getOrNull()

    private fun readFloatFieldOrGetter(
        target: Any,
        name: String,
        fallback: Float = 0.0f,
    ): Float {
        runCatching {
            val f = target.javaClass.getField(name)
            return (f.get(target) as? Number)?.toFloat() ?: fallback
        }
        val getter = "get" + name.replaceFirstChar { it.uppercase(Locale.ROOT) }
        return (invokeInstanceReturn(target, getter, emptyArray(), emptyArray()) as? Number)?.toFloat() ?: fallback
    }

    private fun readLongFieldOrGetter(
        target: Any,
        name: String,
        fallback: Long = 0L,
    ): Long {
        runCatching {
            val f = target.javaClass.getField(name)
            return (f.get(target) as? Number)?.toLong() ?: fallback
        }
        val getter = "get" + name.replaceFirstChar { it.uppercase(Locale.ROOT) }
        return (invokeInstanceReturn(target, getter, emptyArray(), emptyArray()) as? Number)?.toLong() ?: fallback
    }

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
        val decision = windowState.evaluateHardwareKey(event.keyCode, event.action, event.repeatCount)
        if (!decision.intercept) return false
        val direction = decision.direction
        if (direction != null && webView != null) {
            notifyPageTurn(webView)
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
        }
        if (uris.isEmpty()) return

        var added = false
        synchronized(externalOpenQueue) {
            for (uri in uris) {
                val staged = stageExternalUriToCache(uri) ?: continue
                externalOpenQueue.add(staged)
                added = true
            }
        }
        if (added && webView != null) {
            webView.post {
                webView.evaluateJavascript("window.__pagewiseNativeExternalOpen?.()", null)
            }
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
            val filesRoot = context.filesDir.canonicalFile
            val source = File(stagedPath).canonicalFile
            if (!source.path.startsWith(cacheRoot.path + File.separator) || !source.isFile) {
                return false
            }
            val cleanRel = targetRelPath.replace('\\', '/').trimStart('/')
            if (cleanRel.isEmpty() || cleanRel.contains("..")) return false
            val target = File(filesRoot, cleanRel).canonicalFile
            if (!target.path.startsWith(filesRoot.path + File.separator)) return false
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
            val root = context.filesDir.canonicalFile
            val target = File(root, cleanRel).canonicalFile
            if (target.path.startsWith(root.path + File.separator) && target.isFile) target else null
        }.getOrNull()
    }
}
