// Copyright 2019-2024 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT
// Pagewise: version-pinned Activity lifecycle compatibility. Public JNI/API signatures retained.

package app.tauri.plugin

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.content.res.Configuration
import android.os.Handler
import android.os.Looper
import android.webkit.WebView
import androidx.activity.result.ActivityResult
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.contract.ActivityResultContract
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import app.tauri.FsUtils
import app.tauri.JniMethod
import app.tauri.Logger
import app.tauri.annotation.InvokeArg
import com.fasterxml.jackson.annotation.JsonAutoDetect
import com.fasterxml.jackson.annotation.PropertyAccessor
import com.fasterxml.jackson.databind.DeserializationFeature
import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.module.SimpleModule
import java.lang.ref.WeakReference
import java.lang.reflect.InvocationTargetException

object PluginManager {
    fun interface RequestPermissionsCallback {
        fun onResult(permissions: Map<String, Boolean>)
    }

    fun interface ActivityResultCallback {
        fun onResult(result: ActivityResult)
    }

    lateinit var activity: AppCompatActivity
    private val plugins: HashMap<String, PluginHandle> = HashMap()
    private val main = Handler(Looper.getMainLooper())
    private val results = ActivityResultFence()

    @Volatile private var epoch: Any? = null
    private val webViews = java.util.WeakHashMap<Activity, WeakReference<WebView>>()

    private data class PendingResult(
        val unregister: () -> Unit,
        val reject: (String) -> Unit,
    )

    private val pendingResults = mutableMapOf<String, PendingResult>()
    private val jsonMapper: ObjectMapper =
        ObjectMapper()
            .disable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
            .enable(DeserializationFeature.FAIL_ON_NULL_FOR_PRIMITIVES)
            .setVisibility(PropertyAccessor.FIELD, JsonAutoDetect.Visibility.ANY)

    init {
        jsonMapper.registerModule(
            SimpleModule().addDeserializer(
                Channel::class.java,
                ChannelDeserializer({ channelId, payload -> sendChannelData(channelId, payload) }, jsonMapper),
            ),
        )
    }

    private fun handles(): List<PluginHandle> = synchronized(plugins) { plugins.values.toList() }

    internal fun isCurrentOwner(owner: Activity?): Boolean =
        epoch != null && results.isCurrent(owner) && owner != null && !owner.isDestroyed && !owner.isFinishing

    private fun retire(tickets: List<ActivityResultFence.Ticket>) {
        for (ticket in tickets) {
            val pending = pendingResults.remove(ticket.key) ?: continue
            pending.unregister()
            // Only UI-result waiters are ended. Accepted business jobs are not cancelled or replayed.
            pending.reject("activity_changed")
        }
    }

    fun onActivityCreate(activity: AppCompatActivity) {
        check(Looper.myLooper() == Looper.getMainLooper()) { "wrong_thread" }
        if (::activity.isInitialized && this.activity === activity && epoch != null) return
        val previous = if (::activity.isInitialized) this.activity else null
        val old = handles()
        // The SDK initially constructs every Android plugin with this public Activity constructor.
        // Construct replacements before changing the registered handles; unsupported plugins fail closed.
        val replacements =
            if (previous != null && previous !== activity) {
                old.map { handle ->
                    val constructor = handle.instance.javaClass.getConstructor(Activity::class.java)
                    Triple(handle.name, constructor.newInstance(activity), handle.config)
                }
            } else {
                emptyList()
            }
        if (previous != null && epoch != null) onDestroy(previous)
        this.activity = activity
        epoch = Any()
        retire(results.bind(activity))
        if (previous != null && previous !== activity) {
            synchronized(plugins) {
                plugins.clear()
                for ((name, instance, config) in replacements) {
                    val handle = PluginHandle(this, name, instance, config, jsonMapper)
                    handle.bindActivity(activity)
                    plugins[name] = handle
                }
            }
        } else {
            old.forEach { it.bindActivity(activity) }
        }
        synchronized(webViews) { webViews[activity]?.get() }?.takeIf { viewActivity(it) === activity }?.let { view ->
            handles().filter { !it.loaded }.forEach { it.load(view) }
        }
    }

    fun onNewIntent(intent: Intent) {
        if (epoch != null) handles().forEach { it.instance.onNewIntent(intent) }
    }

    fun onPause() {
        if (epoch != null) handles().forEach { it.instance.onPause() }
    }

    fun onResume() {
        if (epoch != null) handles().forEach { it.instance.onResume() }
    }

    fun onRestart(activity: AppCompatActivity) {
        if (isCurrentOwner(activity)) handles().forEach { it.instance.triggerOnRestart(activity) }
    }

    fun onStop() {
        if (epoch != null) handles().forEach { it.instance.onStop() }
    }

    fun onDestroy(activity: AppCompatActivity) {
        synchronized(webViews) { webViews.remove(activity) }
        if (!::activity.isInitialized || this.activity !== activity || epoch == null) return
        epoch = null
        retire(results.detach(activity))
        handles().forEach { it.instance.triggerOnDestroy(activity) }
    }

    fun onConfigurationChanged(newConfig: Configuration) {
        if (epoch != null) handles().forEach { it.instance.onConfigurationChanged(newConfig) }
    }

    private fun <I, O> launchResult(
        owner: Activity?,
        kind: String,
        input: I,
        contract: ActivityResultContract<I, O>,
        callback: (O) -> Unit,
        reject: (String) -> Unit,
    ) {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            main.post { launchResult(owner, kind, input, contract, callback, reject) }
            return
        }
        var ticket: ActivityResultFence.Ticket? = null
        try {
            check(isCurrentOwner(owner)) { "activity_changed" }
            val accepted = results.begin(owner, kind)
            ticket = accepted
            // The no-LifecycleOwner registry overload is legal after STARTED. We explicitly own
            // teardown, and a fresh request key prevents old/duplicate results from consuming a new slot.
            val launcher: ActivityResultLauncher<I> =
                activity.activityResultRegistry.register(accepted.key, contract) { result ->
                    if (results.take(accepted)) {
                        val pending = pendingResults.remove(accepted.key)
                        pending?.unregister?.invoke()
                        try {
                            callback(result)
                        } catch (_: Exception) {
                            reject("activity_callback_outcome_unknown")
                        }
                    }
                }
            pendingResults[accepted.key] = PendingResult({ launcher.unregister() }, reject)
            launcher.launch(input)
        } catch (error: Exception) {
            ticket?.let {
                if (results.take(it)) pendingResults.remove(it.key)?.unregister?.invoke()
            }
            val code =
                if (error is IllegalStateException &&
                    error.message in setOf("activity_changed", "activity_result_busy")
                ) {
                    error.message!!
                } else {
                    "activity_launch_outcome_unknown"
                }
            reject(code)
        }
    }

    fun startActivityForResult(
        intent: Intent,
        callback: ActivityResultCallback,
    ) {
        startActivityForResult(if (::activity.isInitialized) activity else null, intent, callback) { code ->
            Logger.warn(Logger.tags("Plugin"), code)
        }
    }

    internal fun startActivityForResult(
        owner: Activity?,
        intent: Intent,
        callback: ActivityResultCallback,
        reject: (String) -> Unit,
    ) {
        launchResult(owner, "activity", intent, ActivityResultContracts.StartActivityForResult(), callback::onResult, reject)
    }

    fun startIntentSenderForResult(
        intent: IntentSenderRequest,
        callback: ActivityResultCallback,
    ) {
        startIntentSenderForResult(if (::activity.isInitialized) activity else null, intent, callback) { code ->
            Logger.warn(Logger.tags("Plugin"), code)
        }
    }

    internal fun startIntentSenderForResult(
        owner: Activity?,
        intent: IntentSenderRequest,
        callback: ActivityResultCallback,
        reject: (String) -> Unit,
    ) {
        launchResult(owner, "intent_sender", intent, ActivityResultContracts.StartIntentSenderForResult(), callback::onResult, reject)
    }

    fun requestPermissions(
        permissionStrings: Array<String>,
        callback: RequestPermissionsCallback,
    ) {
        requestPermissions(if (::activity.isInitialized) activity else null, permissionStrings, callback) { code ->
            Logger.warn(Logger.tags("Plugin"), code)
        }
    }

    internal fun requestPermissions(
        owner: Activity?,
        permissionStrings: Array<String>,
        callback: RequestPermissionsCallback,
        reject: (String) -> Unit,
    ) {
        launchResult(
            owner,
            "permissions",
            permissionStrings,
            ActivityResultContracts.RequestMultiplePermissions(),
            callback::onResult,
            reject,
        )
    }

    private fun viewActivity(webView: WebView): Activity? {
        var context: Context = webView.context
        while (context is ContextWrapper && context !is Activity) {
            val next = context.baseContext
            if (next === context) return null
            context = next
        }
        return context as? Activity
    }

    @JniMethod
    fun onWebViewCreated(webView: WebView) {
        val owner = viewActivity(webView) ?: return
        // Stage by owner even if Wry creates this view before Tauri's onCreate hook.
        // An obsolete callback can never replace the candidate for another Activity.
        synchronized(webViews) { webViews[owner] = WeakReference(webView) }
        if (isCurrentOwner(owner)) handles().filter { !it.loaded }.forEach { it.load(webView) }
    }

    @JniMethod
    fun load(
        webView: WebView?,
        name: String,
        plugin: Plugin,
        config: String,
    ) {
        val instance =
            if (::activity.isInitialized && plugin.ownerActivity() !== activity) {
                plugin.javaClass.getConstructor(Activity::class.java).newInstance(activity)
            } else {
                plugin
            }
        val handle = PluginHandle(this, name, instance, config, jsonMapper)
        if (::activity.isInitialized) handle.bindActivity(activity)
        synchronized(plugins) { plugins[name] = handle }
        if (webView != null && isCurrentOwner(viewActivity(webView))) handle.load(webView)
    }

    @JniMethod
    fun runCommand(
        id: Int,
        pluginId: String,
        command: String,
        data: String,
    ) {
        val ownerEpoch = epoch
        val response = ActivityInvocationFence(ownerEpoch, { epoch === it }) { success, error -> handlePluginResponse(id, success, error) }
        val scopedMapper = jsonMapper.copy()
        scopedMapper.registerModule(
            SimpleModule("pagewise-activity-channel").addDeserializer(
                Channel::class.java,
                ChannelDeserializer({ channelId, payload ->
                    if (response.isCurrent()) sendChannelData(channelId, payload)
                }, scopedMapper),
            ),
        )
        val invoke =
            Invoke(id.toLong(), command, 0L, 1L, { fn, result ->
                response.respond(fn == 0L, result)
            }, data, scopedMapper)
        dispatchPluginMessage(invoke, pluginId)
    }

    private fun dispatchPluginMessage(
        invoke: Invoke,
        pluginId: String,
    ) {
        Logger.verbose(Logger.tags("Plugin"), "Tauri plugin: pluginId: $pluginId, command: ${invoke.command}")
        try {
            val plugin = synchronized(plugins) { plugins[pluginId] }
            if (plugin == null) {
                invoke.reject("Plugin $pluginId not initialized")
            } else {
                plugin.invoke(invoke)
            }
        } catch (e: Exception) {
            var exception: Throwable = e
            if (exception.message?.isEmpty() != false && e is InvocationTargetException) exception = e.targetException
            invoke.reject(if (exception.message?.isEmpty() != false) exception.toString() else exception.message)
        }
    }

    fun <T> loadConfig(
        context: Context,
        plugin: String,
        cls: Class<T>,
    ): T {
        val tauriConfigJson = FsUtils.readAsset(context.assets, "tauri.conf.json")
        val mapper = ObjectMapper().configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false)
        val config = mapper.readValue(tauriConfigJson, Config::class.java)
        return mapper.readValue(config.plugins[plugin].toString(), cls)
    }

    private external fun handlePluginResponse(
        id: Int,
        success: String?,
        error: String?,
    )

    private external fun sendChannelData(
        id: Long,
        data: String,
    )
}

@InvokeArg
internal class Config {
    lateinit var plugins: Map<String, JsonNode>
}
