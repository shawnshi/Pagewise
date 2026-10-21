package io.pagewise.reader

// 覆盖 `tauri android init` 生成的 MainActivity (CI 在 init 后复制进 gen/android)。
// edge-to-edge 下网页铺到系统栏之下; 旧版 System WebView (如 Android 12 + Chromium 135)
// 不给 env(safe-area-inset-*) 赋值, 这里把系统栏 + 刘海的实际尺寸 (CSS px) 经
// window.LightReadInsets 交给前端 src/services/systemBars.ts; 前端再按页面实际深浅
// 回调 setBarsDark 切换状态栏 / 导航栏图标颜色。

import android.app.ActivityManager
import android.content.Intent
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.KeyEvent
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import java.util.Locale
import java.util.concurrent.atomic.AtomicInteger

class MainActivity : TauriActivity() {
    private var nativeBackView: WebView? = null
    private var nativeManagementSurface: NativeManagementSurface? = null

    internal fun managementWebView(): WebView? = nativeBackView

    internal fun attachManagementSurface(surface: NativeManagementSurface) {
        check(nativeManagementSurface == null || nativeManagementSurface === surface)
        nativeManagementSurface = surface
    }

    internal fun repaintManagementSurface() {
        onyxBridge?.scheduleOverlayRepaint(nativeBackView, "GU", 120)
    }

    private var nativeBackDispatching = false
    private val nativeBackCallback: OnBackPressedCallback =
        object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (nativeBackDispatching) return
                if (nativeManagementSurface?.handleBack() == true) return
                val webView = nativeBackView
                if (webView == null) {
                    fallbackNativeBack()
                    return
                }
                nativeBackDispatching = true
                webView.evaluateJavascript(
                    "(function(){var handle=window.__pagewiseReaderBack;return typeof handle==='function' && handle();})()",
                ) { handled ->
                    nativeBackDispatching = false
                    if (handled != "true") fallbackNativeBack()
                }
            }
        }

    private fun fallbackNativeBack() {
        nativeBackCallback.isEnabled = false
        try {
            onBackPressedDispatcher.onBackPressed()
        } finally {
            nativeBackCallback.isEnabled = true
        }
    }

    @Volatile
    private var insetsJson = "{\"top\":0,\"right\":0,\"bottom\":0,\"left\":0}"

    @Volatile
    private var readerEnvironmentJson = "{}"
    private val readerWindow = ReaderWindowState()
    private var onyxBridge: OnyxSdkBridge? = null
    private var onyxHardwareProfileJson = "{}"

    @Volatile
    private var performanceProbe = false
    private val performanceRecords = AtomicInteger(0)

    override fun onCreate(savedInstanceState: Bundle?) {
        performanceProbe = intent?.getBooleanExtra("io.pagewise.reader.PERF_PROBE", false) ?: false
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        val memory = getSystemService(ACTIVITY_SERVICE) as ActivityManager
        val bridge = OnyxSdkBridge(this, readerWindow)
        onyxBridge = bridge
        val brands = listOf(Build.MANUFACTURER, Build.BRAND).map { it.lowercase(Locale.ROOT) }
        val isBoox = brands.any { it == "onyx" || it == "boox" } || bridge.isBooxHardware()
        onyxHardwareProfileJson = bridge.buildHardwareProfileJson(memory.isLowRamDevice, memory.memoryClass)
        readerEnvironmentJson =
            org.json
                .JSONObject()
                .put("version", 1)
                .put("boox", isBoox)
                .put("lowRam", memory.isLowRamDevice)
                .put("memoryClassMb", memory.memoryClass)
                .toString()
        bridge.ingestExternalIntent(intent, nativeBackView)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        onyxBridge?.ingestExternalIntent(intent, nativeBackView)
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (nativeManagementSurface?.handleKey(event) == true) {
            repaintManagementSurface()
            return true
        }
        if (onyxBridge?.handleHardwareKeyEvent(nativeBackView, event) == true) {
            return true
        }
        return super.dispatchKeyEvent(event)
    }

    override fun onResume() {
        super.onResume()
        readerWindow.resume()
        applyReaderWindowState()
    }

    override fun onPause() {
        readerWindow.pause()
        applyKeepScreenOn(false)
        super.onPause()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus && readerWindow.resumed) applyReaderWindowState()
    }

    override fun onDestroy() {
        nativeManagementSurface?.close()
        nativeManagementSurface = null
        synchronized(performanceRecords) { performanceProbe = false }
        readerWindow.destroy()
        onyxBridge?.onLifecycleDestroy(nativeBackView)
        applyKeepScreenOn(false)
        super.onDestroy()
    }

    private fun applyReaderWindowState() {
        applyImmersive(readerWindow.immersive)
        applyKeepScreenOn(readerWindow.keepScreenOn)
        onyxBridge?.onLifecycleResume(nativeBackView)
    }

    override fun onWebViewCreate(webView: WebView) {
        nativeBackView = webView
        onyxBridge?.attachWebView(webView)
        // Wry installs its history callback during setWebView, before this hook.
        // PW-NATIVE-BACK-01: the reader must own the later dispatcher position.
        nativeBackCallback.remove()
        onBackPressedDispatcher.addCallback(this, nativeBackCallback)
        webView.addJavascriptInterface(InsetsBridge(), "LightReadInsets")

        ViewCompat.setOnApplyWindowInsetsListener(webView) { view, insets ->
            val bars =
                insets.getInsets(
                    WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
                )
            val density = view.resources.displayMetrics.density

            fun css(px: Int) = px / density
            insetsJson = "{\"top\":${css(bars.top)},\"right\":${css(bars.right)}," +
                "\"bottom\":${css(bars.bottom)},\"left\":${css(bars.left)}}"
            (view as WebView).evaluateJavascript("window.__lightreadApplyInsets?.()", null)
            // 交还 WebView 自身的处理, 新版 Chromium 仍据此填充 env()
            ViewCompat.onApplyWindowInsets(view, insets)
        }
        ViewCompat.requestApplyInsets(webView)
    }

    private var barsDark: Boolean? = null

    private fun applyBarsDark(dark: Boolean) {
        if (barsDark == dark) return
        barsDark = dark
        // 透明系统栏, 仅切换图标深浅; 背景由网页自身延伸到栏下
        val style =
            if (dark) {
                SystemBarStyle.dark(Color.TRANSPARENT)
            } else {
                SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT)
            }
        enableEdgeToEdge(style, style)
    }

    /** 沉浸阅读: 隐藏状态栏与导航栏 (从屏幕边缘滑动可临时呼出) */
    private fun applyImmersive(on: Boolean) {
        val controller = WindowCompat.getInsetsController(window, window.decorView)
        if (on) {
            controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            controller.hide(WindowInsetsCompat.Type.systemBars())
        } else {
            controller.show(WindowInsetsCompat.Type.systemBars())
        }
    }

    private fun applyKeepScreenOn(on: Boolean) {
        if (!readerWindow.resumed) {
            onyxBridge?.onLifecyclePause(nativeBackView)
        }
        if (on) {
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        } else {
            window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }

    private inner class InsetsBridge {
        @JavascriptInterface
        fun performanceProbeEnabled(): Boolean = performanceProbe

        // Explicit synthetic-fixture opt-in, not authentication: WebView exposes bridges to all frames.
        @JavascriptInterface
        fun recordPerformance(
            actionCode: Int,
            engineCode: Int,
            elapsedMs: Double,
            completed: Boolean,
        ): Boolean =
            synchronized(performanceRecords) {
                if (!performanceProbe || performanceRecords.get() >= 512 ||
                    !elapsedMs.isFinite() || elapsedMs < 0.0 || elapsedMs > 60000.0
                ) {
                    return@synchronized false
                }
                val action =
                    when (actionCode) {
                        0 -> if (engineCode == 0) "ready" else return@synchronized false
                        1 -> if (engineCode == 1 || engineCode == 2) "open" else return@synchronized false
                        2 -> if (engineCode == 1 || engineCode == 2) "turn" else return@synchronized false
                        else -> return@synchronized false
                    }
                val engine =
                    when (engineCode) {
                        0 -> "probe"
                        1 -> "reflow"
                        else -> "pdf"
                    }
                performanceRecords.incrementAndGet()
                Log.i(
                    "PagewisePerf",
                    String.format(
                        Locale.US,
                        "PWPERF action=%s engine=%s completed=%d ms=%.3f",
                        action,
                        engine,
                        if (completed) 1 else 0,
                        elapsedMs,
                    ),
                )
                true
            }

        @JavascriptInterface
        fun setImmersive(on: Boolean) {
            runOnUiThread {
                readerWindow.requestImmersive(on)
                if (readerWindow.resumed) applyImmersive(readerWindow.immersive)
            }
        }

        @JavascriptInterface
        fun setKeepScreenOn(on: Boolean) {
            runOnUiThread {
                readerWindow.requestKeepScreenOn(on)
                applyKeepScreenOn(readerWindow.keepScreenOn)
            }
        }

        @JavascriptInterface
        fun nativeFileJobsVersion(): Int = 1

        @JavascriptInterface
        fun nativeBookImportVersion(): Int = 1

        // Capability only: no settings, identity or credentials are exposed to frame bridges.
        @JavascriptInterface
        fun nativeStorageVersion(): Int = 1

        @JavascriptInterface
        fun nativePagesVersion(): Int = 1

        @JavascriptInterface
        fun getReaderEnvironment(): String = readerEnvironmentJson

        @JavascriptInterface
        fun getOnyxHardwareProfile(): String = onyxHardwareProfileJson

        @JavascriptInterface
        fun configureEpdGcInterval(pages: Int): String = onyxBridge?.configureGcInterval(pages) ?: "{}"

        @JavascriptInterface
        fun notifyEpdPageTurn(): String {
            val bridge = onyxBridge ?: return "{}"
            var result = "{}"
            runOnUiThread {
                result = bridge.notifyPageTurn(nativeBackView)
            }
            return result
        }

        @JavascriptInterface
        fun setEpdFastMode(
            enabled: Boolean,
            scene: String,
            mode: String,
        ): String {
            val bridge = onyxBridge ?: return "{}"
            runOnUiThread {
                bridge.setFastMode(nativeBackView, enabled, scene, mode)
            }
            return bridge.configureGcInterval(readerWindow.epdState.gcIntervalPages)
        }

        @JavascriptInterface
        fun repaintEpd(mode: String): String {
            val bridge = onyxBridge ?: return "{}"
            runOnUiThread {
                bridge.repaintScreen(nativeBackView, mode)
            }
            return bridge.configureGcInterval(readerWindow.epdState.gcIntervalPages)
        }

        @JavascriptInterface
        fun scheduleEpdFastExit(delayMs: Int) {
            runOnUiThread { onyxBridge?.scheduleFastExit(nativeBackView, delayMs) }
        }

        @JavascriptInterface
        fun scheduleEpdOverlayRepaint(
            mode: String,
            delayMs: Int,
        ) {
            runOnUiThread { onyxBridge?.scheduleOverlayRepaint(nativeBackView, mode, delayMs) }
        }

        @JavascriptInterface
        fun getEpdStatus(): String = onyxBridge?.epdStatus() ?: "{}"

        @JavascriptInterface
        fun getFrontLightState(): String = onyxBridge?.getFrontLightStateJson() ?: "{}"

        @JavascriptInterface
        fun setFrontLightEnabled(enabled: Boolean): String = onyxBridge?.setFrontLightEnabled(enabled) ?: "{}"

        @JavascriptInterface
        fun setColdLight(percent: Int): String = onyxBridge?.setColdLightPercent(percent) ?: "{}"

        @JavascriptInterface
        fun setWarmLight(percent: Int): String = onyxBridge?.setWarmLightPercent(percent) ?: "{}"

        @JavascriptInterface
        fun configureScribble(
            enabled: Boolean,
            style: Int,
            strokeWidth: Float,
            limitRectJson: String,
            excludeRectsJson: String,
        ): String {
            val bridge = onyxBridge ?: return "{}"
            runOnUiThread {
                bridge.configureScribble(nativeBackView, enabled, style, strokeWidth, limitRectJson, excludeRectsJson)
            }
            return bridge.setScribbleModalSuspended(null, readerWindow.scribbleState.suspendedByModal)
        }

        @JavascriptInterface
        fun setScribbleModalSuspended(suspended: Boolean): String {
            val bridge = onyxBridge ?: return "{}"
            runOnUiThread {
                bridge.setScribbleModalSuspended(nativeBackView, suspended)
            }
            return bridge.setScribbleModalSuspended(null, suspended)
        }

        @JavascriptInterface
        fun configureHardwareKeys(
            capture: Boolean,
            volumeKeysEnabled: Boolean,
        ): String = onyxBridge?.configureHardwareKeys(capture, volumeKeysEnabled) ?: "{}"

        @JavascriptInterface
        fun stageReadingCheckpoint(
            bookId: String,
            cfi: String,
            progress: Double,
            readingDeltaSeconds: Int,
        ): Boolean = onyxBridge?.stageReadingCheckpoint(bookId, cfi, progress, readingDeltaSeconds) ?: false

        @JavascriptInterface
        fun consumeReadingCheckpoint(): String = onyxBridge?.consumeReadingCheckpointJson() ?: "{}"

        @JavascriptInterface
        fun drainExternalOpenQueue(): String = onyxBridge?.drainExternalOpenQueueJson() ?: "[]"

        @JavascriptInterface
        fun commitStagedExternalFile(
            stagedPath: String,
            targetRelPath: String,
        ): Boolean = onyxBridge?.commitStagedExternalFile(stagedPath, targetRelPath) ?: false

        @JavascriptInterface
        fun searchNativeEpubText(
            bookRelPath: String,
            query: String,
            maxHits: Int,
        ): String = onyxBridge?.searchNativeEpubText(bookRelPath, query, maxHits) ?: "[]"

        @JavascriptInterface
        fun openNativePdfInfo(bookRelPath: String): String = onyxBridge?.openNativePdfInfo(bookRelPath) ?: "{}"

        @JavascriptInterface
        fun renderNativePdfPage(
            bookRelPath: String,
            pageNumber: Int,
            targetWidth: Int,
            targetHeight: Int,
        ): String = onyxBridge?.renderNativePdfPageDataUrl(bookRelPath, pageNumber, targetWidth, targetHeight) ?: ""

        @JavascriptInterface
        fun get(): String = insetsJson

        @JavascriptInterface
        fun setBarsDark(dark: Boolean) {
            runOnUiThread { applyBarsDark(dark) }
        }
    }
}

internal interface NativeManagementSurface : java.io.Closeable {
    fun handleBack(): Boolean

    fun handleKey(event: KeyEvent): Boolean
}
