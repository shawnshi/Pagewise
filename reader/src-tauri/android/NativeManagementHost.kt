package io.pagewise.reader

import android.app.Activity
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.KeyEvent
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** One Activity view host. Business requests keep their original owners when a page disappears. */
internal class NativeManagementHost(
    private val activity: Activity,
    private val webView: () -> WebView?,
    private val repaint: () -> Unit,
) : NativeManagementSurface {
    private data class Pending(
        val action: String,
        val key: String,
        var reply: NativePageReply?,
        val timeout: Runnable,
    )

    private val main = Handler(Looper.getMainLooper())
    private val pending = mutableMapOf<String, Pending>()
    private val inFlight = mutableSetOf<String>()
    private var registered = emptySet<String>()
    private var ready = false
    private var closed = false
    private val visibility = NativePageVisibilityFence()
    private val dispatcher = NativeManagementDispatcher(activity, ::dispatchWebAction, ::stateChanged)
    private val pages = NativePagesController(activity, dispatcher::request, ::navigate, repaint)

    fun ready(handlers: JSONArray): JSONObject {
        requireMain()
        val names = (0 until handlers.length()).map { handlers.getString(it) }.toSet()
        if (names.size != handlers.length() || !names.containsAll(REQUIRED_ACTIONS) ||
            names.any { it !in NativeManagementDispatcher.WEB_ACTIONS }
        ) {
            throw NativeStateFailure("native_actions_incomplete")
        }
        registered = names
        ready = true
        val session = UUID.randomUUID().toString()
        visibility.beginSession(session)
        return JSONObject()
            .put(
                "ready",
                true,
            ).put("version", 1)
            .put("session", session)
            .put("visibilityLeaseMs", NativePageVisibilityFence.LEASE_MS)
    }

    private fun whole(value: Any): Long {
        if (value !is Number || !value.toDouble().isFinite() ||
            value.toDouble() != value.toLong().toDouble()
        ) {
            throw NativeStateFailure("invalid_payload")
        }
        return value.toLong()
    }

    fun visibilityTicket(payload: JSONObject): JSONObject {
        requireMain()
        if (!ready) throw NativeStateFailure("native_pages_not_ready")
        val session = payload.getString("session")
        val ticket =
            visibility.ticket(session, whole(payload.get("intent")), SystemClock.elapsedRealtime())
                ?: return JSONObject().put("stale", true)
        return JSONObject().put("session", session).put("generation", ticket)
    }

    fun transition(
        action: String,
        payload: JSONObject,
        reply: NativePageReply,
    ) {
        requireMain()
        if (!ready) throw NativeStateFailure("native_pages_not_ready")
        val session = payload.getString("session")
        val ticket = whole(payload.get("generation"))
        val page = if (action == "show") payload.getString("page") else ""
        if (action == "show" &&
            page !in setOf("library", "reading", "book", "annotations", "stats", "settings", "manual")
        ) {
            throw NativeStateFailure("unsupported_page")
        }

        fun stale() = reply(JSONObject().put("applied", false).put("stale", true), null)
        if (!visibility.admit(session, ticket, SystemClock.elapsedRealtime())) {
            stale()
            return
        }
        pages.prepareLeave { error ->
            when {
                closed -> {
                    reply(null, "host_closed")
                }

                !visibility.isCurrent(session, ticket, SystemClock.elapsedRealtime()) -> {
                    stale()
                }

                error != null -> {
                    reply(null, error)
                }

                else -> {
                    try {
                        if (action == "show") pages.show(page, payload.optJSONObject("params") ?: JSONObject()) else pages.hide()
                        reply(JSONObject().put("applied", true).put("visible", action == "show"), null)
                        main.post { if (!closed) repaint() }
                    } catch (failure: Exception) {
                        reply(null, if (failure is NativeStateFailure) failure.code else "native_pages_error")
                    }
                }
            }
        }
    }

    override fun handleBack(): Boolean = !closed && pages.handleBack()

    override fun handleKey(event: KeyEvent): Boolean = !closed && pages.handleKey(event)

    private fun navigate(path: String) {
        requireMain()
        if (path != "@back" && !path.startsWith('/')) throw NativeStateFailure("invalid_route")
        emit("pagewise-native-navigate", JSONObject().put("path", path))
    }

    private fun stateChanged() {
        activity.runOnUiThread {
            if (!closed) {
                emit("pagewise-native-state-changed", JSONObject())
                repaint()
            }
        }
    }

    private fun emit(
        name: String,
        payload: JSONObject,
    ) {
        requireMain()
        val view = webView() ?: throw NativeStateFailure("unavailable")
        val detail = JSONObject.quote(payload.toString())
        view.evaluateJavascript("window.dispatchEvent(new CustomEvent(${JSONObject.quote(name)},{detail:JSON.parse($detail)}));", null)
    }

    private fun dispatchWebAction(
        action: String,
        payload: JSONObject,
        reply: NativePageReply,
    ) {
        activity.runOnUiThread {
            if (closed || !ready || action !in registered ||
                webView() == null
            ) {
                reply(null, "native_actions_unavailable")
                return@runOnUiThread
            }
            val key =
                if (action.startsWith("recommendations")) {
                    JSONArray()
                        .put(
                            action,
                        ).put(payload.optString("token"))
                        .put(payload.optString("requestId"))
                        .put(payload.optString("candidateId"))
                        .toString()
                } else if (action in setOf("bookIntroductionGenerate", "bookIntroductionSave", "bookIntroductionCancel")) {
                    val nonce = payload.optString(if (action == "bookIntroductionSave") "token" else "requestId")
                    JSONArray()
                        .put(action)
                        .put(payload.optString("bookId"))
                        .put(nonce)
                        .toString()
                } else {
                    action + ":" + payload.optString("id") + ":" + payload.optString("token")
                }
            if (pending.size >= 32) {
                reply(null, "resource_limit")
                return@runOnUiThread
            }
            if (!inFlight.add(key)) {
                reply(null, "busy")
                return@runOnUiThread
            }
            val id = UUID.randomUUID().toString()
            val timeout =
                Runnable {
                    // UI deadline is NOT cancellation/admission fencing. Keep the key until physical completion or host destruction.
                    pending[id]?.let { item ->
                        item.reply?.invoke(null, "commit_outcome_unknown")
                        item.reply = null
                    }
                }
            pending[id] = Pending(action, key, reply, timeout)
            main.postDelayed(timeout, 5 * 60 * 1000L)
            try {
                emit("pagewise-native-action", JSONObject().put("requestId", id).put("action", action).put("payload", payload))
            } catch (
                _: Exception,
            ) {
                // Delivery may have occurred; no replacement request/new-ID replay is authorized here.
                pending[id]?.let { item ->
                    item.reply?.invoke(null, "commit_outcome_unknown")
                    item.reply = null
                }
            }
        }
    }

    fun reply(payload: JSONObject): JSONObject {
        requireMain()
        val id = payload.getString("requestId")
        if (!UUID_PATTERN.matches(id) ||
            payload.toString().toByteArray(Charsets.UTF_8).size > 2 * 1024 * 1024
        ) {
            throw NativeStateFailure("invalid_payload")
        }
        val item = pending[id] ?: return JSONObject().put("accepted", false)
        val error = if (payload.isNull("error")) null else payload.getString("error")
        if (error != null && !ERROR_PATTERN.matches(error)) throw NativeStateFailure("invalid_payload")
        val result = if (payload.isNull("result")) null else payload.getJSONObject("result")
        if (error == null && result == null) throw NativeStateFailure("invalid_payload")
        pending.remove(id)
        inFlight.remove(item.key)
        main.removeCallbacks(item.timeout)
        item.reply?.invoke(result, error)
        // Late completion can refresh canonical views, but never retroactively claims an expired callback succeeded.
        repaint()
        return JSONObject().put("accepted", true)
    }

    override fun close() {
        if (Looper.myLooper() != Looper.getMainLooper()) throw NativeStateFailure("wrong_thread")
        if (closed) return
        closed = true
        ready = false
        pages.dispose()
        dispatcher.close()
        pending.values.forEach {
            main.removeCallbacks(it.timeout)
            it.reply?.invoke(null, "commit_outcome_unknown")
        }
        pending.clear()
        inFlight.clear()
    }

    private fun requireMain() {
        if (Looper.myLooper() != Looper.getMainLooper()) throw NativeStateFailure("wrong_thread")
        if (closed) throw NativeStateFailure("host_closed")
    }

    companion object {
        private val UUID_PATTERN = Regex("[a-f0-9-]{36}")
        private val ERROR_PATTERN = Regex("[a-zA-Z0-9_-]{1,80}")
        private val REQUIRED_ACTIONS =
            setOf(
                "importBooks",
                "selectFolder",
                "recheckFolder",
                "fileJobStatus",
                "backupExport",
                "backupImport",
                "relinkBook",
                "relinkBookCommit",
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
                "classificationGet",
                "classificationSave",
                "noteDraftList",
                "noteDraftGet",
                "noteDraftSave",
                "noteDraftDiscard",
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
                "settingsPatch",
                "selectAiProvider",
                "settingsResetReader",
                "settingsCalibrationInfo",
                "settingsCalibrationCommit",
                "settingsCalibrationClear",
                "settingsTestAi",
                "settingsTestProxy",
            )
    }
}
