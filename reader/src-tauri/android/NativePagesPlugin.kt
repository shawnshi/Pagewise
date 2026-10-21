package io.pagewise.reader

import android.app.Activity
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONObject
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

/** Protected Tauri channel only; capability-only frame bridges never navigate, read data or submit replies. */
@TauriPlugin
class NativePagesPlugin(
    private val activity: Activity,
) : Plugin(activity) {
    private var host: NativeManagementHost? = null

    companion object {
        private val executor = ThreadPoolExecutor(1, 1, 0L, TimeUnit.MILLISECONDS, ArrayBlockingQueue<Runnable>(16))
    }

    @Command
    fun page(invoke: Invoke) {
        val args = invoke.getArgs()
        val action = args.optString("action")
        val payload = args.optJSONObject("payload") ?: JSONObject()
        if (payload.toString().toByteArray(Charsets.UTF_8).size >
            2 * 1024 * 1024
        ) {
            invoke.reject("resource_limit", "resource_limit")
            return
        }
        val mainActivity =
            activity as? MainActivity ?: run {
                invoke.reject("unavailable", "unavailable")
                return
            }

        fun runUi() {
            mainActivity.runOnUiThread {
                try {
                    if (mainActivity.isDestroyed || mainActivity.isFinishing) throw NativeStateFailure("host_closed")
                    if (action == "show" || action == "hide") {
                        (host ?: throw NativeStateFailure("native_pages_not_ready")).transition(action, payload) { result, error ->
                            if (error != null) {
                                invoke.reject(error, error)
                            } else if (result != null) {
                                invoke.resolve(JSObject(result.toString()))
                            } else {
                                invoke.reject("invalid_response", "invalid_response")
                            }
                        }
                        return@runOnUiThread
                    }
                    val result =
                        when (action) {
                            "ready" -> {
                                val current =
                                    host
                                        ?: NativeManagementHost(
                                            mainActivity,
                                            mainActivity::managementWebView,
                                            mainActivity::repaintManagementSurface,
                                        ).also {
                                            mainActivity.attachManagementSurface(it)
                                            host =
                                                it
                                        }
                                current.ready(payload.getJSONArray("handlers"))
                            }

                            "visibilityTicket" -> {
                                (host ?: throw NativeStateFailure("native_pages_not_ready")).visibilityTicket(payload)
                            }

                            "reply" -> {
                                host?.reply(payload) ?: JSONObject().put("accepted", false)
                            }

                            else -> {
                                throw NativeStateFailure("unsupported_action")
                            }
                        }
                    invoke.resolve(JSObject(result.toString()))
                } catch (error: Exception) {
                    val code =
                        if (error is NativeStateFailure) {
                            error.code
                        } else if (error is org.json.JSONException) {
                            "invalid_payload"
                        } else {
                            "native_pages_error"
                        }
                    invoke.reject(code, code)
                }
            }
        }
        if (action != "ready") {
            runUi()
            return
        }
        // Prove both canonical owners are available before permitting any native management page.
        try {
            executor.execute {
                try {
                    val status = NativeStateStore(activity.applicationContext).use { it.command("status", JSONObject()) }
                    if (status.getString("state") != "complete") throw NativeStateFailure("native_state_not_ready")
                    NativeLibraryRepository(activity.applicationContext).use { }
                    runUi()
                } catch (error: Exception) {
                    val code = if (error is NativeStateFailure) error.code else "native_pages_initialization_failed"
                    invoke.reject(code, code)
                }
            }
        } catch (_: java.util.concurrent.RejectedExecutionException) {
            invoke.reject("busy", "busy")
        }
    }
}
