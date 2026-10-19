package io.pagewise.reader

// Transport only. The started/bound service owns TTS, focus, the disk queue and
// the independent listening checkpoint. Destroying the WebView only unbinds.
import android.app.Activity
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.appcompat.app.AppCompatActivity
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.util.concurrent.atomic.AtomicBoolean

@TauriPlugin
class SystemTtsPlugin(
    private val activity: Activity,
) : Plugin(activity) {
    private val main = Handler(Looper.getMainLooper())
    private var service: SystemTtsService? = null
    private var bound = false

    @Volatile private var destroyed = false
    private val waiting = ArrayList<(SystemTtsService?) -> Unit>()
    private val connection =
        object : ServiceConnection {
            override fun onServiceConnected(
                name: ComponentName?,
                binder: IBinder?,
            ) {
                service = (binder as? SystemTtsService.LocalBinder)?.service
                val callbacks = waiting.toList()
                waiting.clear()
                callbacks.forEach { it(service) }
            }

            override fun onServiceDisconnected(name: ComponentName?) {
                service = null
            }
        }

    private fun connected(callback: (SystemTtsService?) -> Unit) {
        if (destroyed) {
            callback(null)
            return
        }
        service?.let {
            callback(it)
            return
        }
        if (waiting.size >= 64) {
            callback(null)
            return
        }
        waiting.add(callback)
        if (!bound) {
            bound = activity.bindService(Intent(activity, SystemTtsService::class.java), connection, Context.BIND_AUTO_CREATE)
            if (!bound) {
                val callbacks = waiting.toList()
                waiting.clear()
                callbacks.forEach { it(null) }
            }
        }
    }

    private fun run(
        invoke: Invoke,
        timeoutMs: Long = 20_000,
        block: (SystemTtsService, (JSObject) -> Unit, (String) -> Unit) -> Unit,
    ) {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            main.post { run(invoke, timeoutMs, block) }
            return
        }
        val settled = AtomicBoolean(false)
        val timeout = Runnable { if (settled.compareAndSet(false, true)) invoke.reject("tts_unavailable", "tts_unavailable") }
        main.postDelayed(timeout, timeoutMs)
        val resolve: (
            JSObject,
        ) -> Unit = { value ->
            if (settled.compareAndSet(false, true)) {
                main.removeCallbacks(timeout)
                main.post { invoke.resolve(value) }
            }
        }
        val reject: (
            String,
        ) -> Unit = { code ->
            if (settled.compareAndSet(false, true)) {
                main.removeCallbacks(timeout)
                main.post { invoke.reject(code, code) }
            }
        }
        try {
            connected { owner ->
                if (settled.get()) return@connected
                if (owner == null) {
                    reject("tts_unavailable")
                    return@connected
                }
                owner.submit({ settled.get() || destroyed }, { reject("tts_unavailable") }) {
                    owner.ready { ready ->
                        if (settled.get() || destroyed) return@ready
                        if (!ready) {
                            reject("tts_unavailable")
                        } else {
                            try {
                                block(owner, resolve, reject)
                            } catch (error: Exception) {
                                android.util.Log.e("PagewiseSpeech", "Speech transport failed", error)
                                reject("io_error")
                            }
                        }
                    }
                }
            }
        } catch (error: RuntimeException) {
            android.util.Log.e("PagewiseSpeech", "Service connection failed", error)
            reject("background_unavailable")
        }
    }

    @Command
    fun available(invoke: Invoke) = run(invoke) { owner, resolve, _ -> resolve(owner.voices()) }

    @Command
    fun session(invoke: Invoke) {
        val args = invoke.getArgs()
        val action = args.getString("action")
        val payload = args.optJSONObject("payload") ?: org.json.JSONObject()
        run(invoke) { owner, resolve, reject -> owner.dispatch(action, payload, resolve, reject) }
    }

    @Command
    fun speak(invoke: Invoke) = runLegacy(invoke, false)

    @Command
    fun speakBatch(invoke: Invoke) = runLegacy(invoke, true)

    private fun runLegacy(
        invoke: Invoke,
        batch: Boolean,
    ) {
        run(invoke, 6 * 60 * 60 * 1000L) { owner, resolve, reject ->
            val args = invoke.getArgs()
            val texts =
                if (batch) {
                    val array = args.getJSONArray("texts")
                    (0 until array.length()).map { array.getString(it) }
                } else {
                    listOf(args.getString("text"))
                }
            owner.legacy(texts, args.optDouble("rate", 1.0), args.optString("voice", "")) { code, index ->
                if (code == "done") resolve(JSObject().put("status", "done").put("index", index)) else reject(code)
            }
        }
    }

    @Command
    fun stop(invoke: Invoke) = run(invoke) { owner, resolve, _ -> owner.stopLegacy(resolve) }

    @Command
    fun status(invoke: Invoke) = run(invoke) { owner, resolve, _ -> resolve(owner.legacyStatus()) }

    override fun onDestroy(activity: AppCompatActivity) {
        destroyed = true
        val callbacks = waiting.toList()
        waiting.clear()
        callbacks.forEach { it(null) }
        if (bound) activity.unbindService(connection)
        bound = false
        service = null
        // Do not stop/shutdown the started service or discard its checkpoint.
        super.onDestroy(activity)
    }
}
