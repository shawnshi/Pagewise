package io.pagewise.reader

import android.content.Context
import org.json.JSONObject
import java.io.Closeable
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** Native page IO stays off the main thread; canonical state and existing long-running job owners remain separate. */
internal class NativeManagementDispatcher(
    context: Context,
    private val webAction: (String, JSONObject, NativePageReply) -> Unit,
    private val stateChanged: () -> Unit,
) : Closeable {
    private val context = context.applicationContext
    private val closed = AtomicBoolean(false)
    private val executor = ThreadPoolExecutor(1, 1, 0L, TimeUnit.MILLISECONDS, ArrayBlockingQueue<Runnable>(32))

    fun request(
        action: String,
        payload: JSONObject,
        reply: NativePageReply,
    ) {
        if (closed.get()) {
            reply(null, "host_closed")
            return
        }
        if (payload.toString().toByteArray(Charsets.UTF_8).size > 2 * 1024 * 1024) {
            reply(null, "resource_limit")
            return
        }
        if (action == "state.settingsPatch") {
            routeWebAction("settingsPatch", payload, reply)
            return
        }
        if (action.startsWith("action.")) {
            if (action.removePrefix("action.") !in WEB_ACTIONS) {
                reply(null, "unsupported_action")
                return
            }
            routeWebAction(action.removePrefix("action."), payload, reply)
            return
        }
        try {
            executor.execute {
                try {
                    val result =
                        when {
                            action.startsWith(
                                "library.",
                            ) -> {
                                NativeLibraryRepository(context).use { it.command(action.removePrefix("library."), payload) }
                            }

                            action == "state.settingsGet" -> {
                                NativeStateStore(context).use { it.command("settingsGet", JSONObject()) }
                            }

                            action == "manual.get" -> {
                                manual(payload.getString("file"))
                            }

                            else -> {
                                throw NativeStateFailure("unsupported_action")
                            }
                        }
                    reply(result, null)
                } catch (error: Exception) {
                    reply(
                        null,
                        when (error) {
                            is NativeStateFailure -> error.code
                            is org.json.JSONException -> "invalid_payload"
                            else -> "native_management_error"
                        },
                    )
                }
            }
        } catch (_: java.util.concurrent.RejectedExecutionException) {
            reply(null, "busy")
        }
    }

    private fun routeWebAction(
        action: String,
        payload: JSONObject,
        reply: NativePageReply,
    ) {
        webAction(action, JSONObject(payload.toString())) { result, error ->
            if (error == null && result?.optBoolean("ok") == true && action in SETTINGS_MUTATIONS) stateChanged()
            reply(result, error)
        }
    }

    private fun manual(file: String): JSONObject {
        if (file !in MANUAL_FILES) throw NativeStateFailure("manual_not_found")
        val bytes =
            context.assets.open("manual/$file").use { input ->
                val output = java.io.ByteArrayOutputStream()
                val buffer = ByteArray(16384)
                while (true) {
                    val size = input.read(buffer)
                    if (size < 0) break
                    if (output.size() + size > 1024 * 1024) throw NativeStateFailure("resource_limit")
                    output.write(buffer, 0, size)
                }
                output.toByteArray()
            }
        val markdown =
            Charsets.UTF_8
                .newDecoder()
                .onMalformedInput(
                    CodingErrorAction.REPORT,
                ).onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(bytes))
                .toString()
        return JSONObject().put("file", file).put("markdown", markdown)
    }

    override fun close() {
        if (closed.compareAndSet(false, true)) executor.shutdown()
        // No shutdownNow/false cancellation of an SQLite commit or existing import/background service.
    }

    companion object {
        val WEB_ACTIONS =
            setOf(
                "importBooks",
                "selectFolder",
                "recheckFolder",
                "fileJobStatus",
                "backupExport",
                "backupImport",
                "aiClassify",
                "bookIntroductionGenerate",
                "bookIntroductionSave",
                "bookIntroductionCancel",
                "recommendationsGet",
                "recommendationsAi",
                "recommendationsCancel",
                "recommendationsFeedback",
                "recommendationsClearFeedback",
                "recommendationsWanted",
                "relinkBook",
                "relinkBookCommit",
                "classificationGet",
                "classificationSave",
                "noteDraftList",
                "noteDraftGet",
                "noteDraftSave",
                "noteDraftDiscard",
                "settingsPatch",
                "settingsSchema",
                "settingsRecoveryInspect",
                "settingsRecoveryDecide",
                "statisticsGet",
                "librarySessionGet",
                "librarySessionSave",
                "libraryPage",
                "libraryBookInfo",
                "bookToc",
                "librarySelectionPage",
                "libraryTagBatch",
                "settingsTestAi",
                "settingsTestProxy",
                "selectAiProvider",
                "settingsResetReader",
                "settingsCalibrationInfo",
                "settingsCalibrationCommit",
                "settingsCalibrationClear",
            )
        private val MANUAL_FILES = setOf("README.md", "01-读书方法.md", "02-阅读模式.md", "03-声音.md", "04-使用说明.md", "05-伴读.md")
        private val SETTINGS_MUTATIONS =
            setOf("settingsPatch", "selectAiProvider", "settingsResetReader", "settingsCalibrationCommit", "settingsCalibrationClear")
    }
}
