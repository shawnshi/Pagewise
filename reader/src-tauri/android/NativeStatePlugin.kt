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

/** App-scoped short SQLite requests. Activity destruction never reports an in-flight commit as cancelled. */
@TauriPlugin
class NativeStatePlugin(
    private val activity: Activity,
) : Plugin(activity) {
    companion object {
        private val executor = ThreadPoolExecutor(1, 1, 0L, TimeUnit.MILLISECONDS, ArrayBlockingQueue<Runnable>(32))
    }

    @Command
    fun state(invoke: Invoke) {
        val args = invoke.getArgs()
        val action = args.optString("action")
        val payload = args.optJSONObject("payload") ?: JSONObject()
        val requestedRoot = if (args.has("libraryRoot")) args.getString("libraryRoot") else null
        val context = activity.applicationContext
        try {
            executor.execute {
                try {
                    val root =
                        requestedRoot
                            ?: context
                                .getSharedPreferences(
                                    "pagewise-native-state-location",
                                    android.content.Context.MODE_PRIVATE,
                                ).getString("root", "")
                                .orEmpty()
                    val directory = if (root.isEmpty()) context.dataDir else java.io.File(root)
                    val result =
                        CanonicalDatabase.protect(java.io.File(directory, "lightread.db")) {
                            if (action.startsWith("sql.")) {
                                NativeSqlDatabase(context, requestedRoot, action == "sql.initialize").use { it.command(action, payload) }
                            } else {
                                NativeStateStore(context, requestedRoot).use { it.command(action, payload) }
                            }
                        }
                    invoke.resolve(JSObject(result.toString()))
                } catch (error: Exception) {
                    val code =
                        if (error is CanonicalDatabaseFailure) {
                            error.code
                        } else if (error is NativeStateFailure) {
                            error.code
                        } else if (error is org.json.JSONException) {
                            "invalid_payload"
                        } else {
                            "native_state_error"
                        }
                    // Never include settings, credentials, row contents or SQL bindings in logs/errors.
                    invoke.reject(code, code)
                }
            }
        } catch (_: java.util.concurrent.RejectedExecutionException) {
            invoke.reject("busy", "busy")
        }
    }
}
