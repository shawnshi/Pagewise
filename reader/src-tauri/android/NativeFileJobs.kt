package io.pagewise.reader

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.CancellationSignal
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.util.AtomicFile
import android.util.Log
import androidx.core.app.NotificationCompat
import app.tauri.plugin.JSObject
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

private const val JOB_CHANNEL = "pagewise-file-jobs"
private const val JOB_NOTIFICATION = 7322
private const val JOB_TIMEOUT_MS = 120_000L
private const val JOB_TTL_MS = 3_600_000L
private val JOB_ID = Regex("[a-f0-9-]{36}")

/** Application-owned bounded IO/import queue. SQLite is authoritative for import commit outcomes. */
internal object NativeFileJobs {
    private data class Job(
        val data: JSONObject,
        val cancellation: CancellationSignal = CancellationSignal(),
        var committing: Boolean = false,
        var pendingTerminal: Pair<String, String>? = null,
    )

    private var root: File? = null
    private val jobs = linkedMapOf<String, Job>()
    private val executor = ThreadPoolExecutor(2, 2, 0L, TimeUnit.MILLISECONDS, ArrayBlockingQueue<Runnable>(2))
    private val activeStates = setOf("queued", "running")

    private fun directory(context: Context): File {
        val next = File(context.filesDir, "native-file-jobs")
        if (root == next) return next
        check(root == null) { "File job owner cannot switch application roots" }
        if (!next.isDirectory && !next.mkdirs()) throw MonitoredFolderIo.Failure("io_error")
        val names =
            (next.listFiles() ?: throw MonitoredFolderIo.Failure("io_error"))
                .map { it.name.removeSuffix(".bak") }
                .filter { it.matches(Regex("[a-f0-9-]{36}\\.json")) }
                .distinct()
        if (names.size > 16) throw MonitoredFolderIo.Failure("resource_limit")
        val restored =
            names.map { name ->
                val file = AtomicFile(File(next, name))
                // Include backup-only entries: a process can die between AtomicFile's renames.
                val bytes =
                    file.openRead().use { input ->
                        val output = ByteArrayOutputStream()
                        val buffer = ByteArray(65536)
                        while (true) {
                            val count = input.read(buffer)
                            if (count < 0) break
                            if (output.size() + count > 8 * 1024 * 1024) throw MonitoredFolderIo.Failure("resource_limit")
                            output.write(buffer, 0, count)
                        }
                        output.toByteArray()
                    }
                val data = JSONObject(bytes.toString(Charsets.UTF_8))
                val id = data.getString("id")
                if (!JOB_ID.matches(id) || name != "$id.json") throw MonitoredFolderIo.Failure("io_error")
                Job(data)
            }
        root = next
        try {
            for (job in restored) {
                if (!restoreCommitted(context, job) && job.data.getString("state") in activeStates) {
                    job.data.put("state", "interrupted").put("code", "interrupted")
                    save(job.data)
                }
                jobs[job.data.getString("id")] = job
            }
        } catch (error: Exception) {
            jobs.clear()
            root = null
            throw error
        }
        return next
    }

    private fun save(data: JSONObject) {
        val file = AtomicFile(File(root ?: throw MonitoredFolderIo.Failure("io_error"), "${data.getString("id")}.json"))
        val bytes = data.toString().toByteArray(Charsets.UTF_8)
        if (bytes.size > 8 * 1024 * 1024) throw MonitoredFolderIo.Failure("resource_limit")
        val stream = file.startWrite()
        try {
            stream.write(bytes)
            file.finishWrite(stream)
        } catch (error: Exception) {
            file.failWrite(stream)
            throw error
        }
    }

    private fun batchKey(data: JSONObject) = if (data.getString("kind") == "import") data.getString("documentId") else data.getString("id")

    private fun durable(
        context: Context,
        data: JSONObject,
    ): JSONObject? =
        NativeImportDatabase.progress(
            context,
            batchKey(data),
            NativeBookImporter.requestFingerprint(
                data.getString("kind"),
                data.getString("folderId"),
                data.optJSONObject("request") ?: JSONObject(),
            ),
        )

    private fun restoreCommitted(
        context: Context,
        job: Job,
    ): Boolean {
        if (job.data.getString("kind") !in setOf("index", "import")) return false
        try {
            val progress = durable(context, job.data) ?: return false
            if (!progress.optBoolean("finished")) return false
            job.data
                .put("state", "succeeded")
                .put("code", "")
                .put("result", progress)
                .put("progress", progress)
            job.data.remove("phase")
            job.data.remove("stopPending")
            job.data.remove("progressError")
            save(job.data)
            return true
        } catch (error: Exception) {
            job.data.put("progressError", NativeBookImporter.code(error))
            return false
        }
    }

    private fun recoverable(data: JSONObject) =
        data.getString("kind") == "import" &&
            (
                data.getString("state") == "interrupted" ||
                    data.optString("code") in setOf("database_error", "commit_outcome_unknown", "receipt_error")
            )

    private fun writingActive() =
        physicalWorkers.containsKey("library-write") ||
            jobs.values.any { lane(it.data.getString("kind")) == "library-write" && it.data.getString("state") in activeStates }

    private fun cleanupPaths(
        context: Context,
        paths: List<String>,
    ) {
        if (paths.size > 128 ||
            paths.any { !Regex("cache/import-[a-f0-9-]{36}\\.bin").matches(it) }
        ) {
            throw MonitoredFolderIo.Failure("invalid_reference")
        }
        if (!NativeImportUploads.seal(paths)) throw MonitoredFolderIo.Failure("busy")
        for (path in paths) {
            val file = File(context.cacheDir, path.removePrefix("cache/"))
            if (file.exists() && !file.delete()) throw MonitoredFolderIo.Failure("io_error")
        }
    }

    private fun sealInputs(request: JSONObject) {
        val items = request.getJSONArray("items")
        if (!NativeImportUploads.seal(
                (0 until items.length()).map {
                    items.getJSONObject(it).getString("path")
                },
            )
        ) {
            throw MonitoredFolderIo.Failure("busy")
        }
    }

    private fun discard(
        context: Context,
        data: JSONObject,
        force: Boolean = false,
    ) {
        data.optJSONObject("result")?.let { MonitoredFolderIo(context).discard(JSObject(it.toString())) }
        if (data.getString("kind") == "import" && (force || !recoverable(data))) {
            val items = data.getJSONObject("request").getJSONArray("items")
            cleanupPaths(context, (0 until items.length()).map { items.getJSONObject(it).getString("path") })
        }
    }

    private fun launch(
        context: Context,
        job: Job,
    ) {
        try {
            val intent = Intent(context, NativeFileJobService::class.java).putExtra("jobId", job.data.getString("id"))
            val started = if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent) else context.startService(intent)
            if (started == null) throw MonitoredFolderIo.Failure("unavailable")
        } catch (error: Exception) {
            job.data.put("state", "failed").put("code", "background_start_denied")
            save(job.data)
        }
    }

    private fun expire(context: Context) {
        val cutoff = System.currentTimeMillis() - JOB_TTL_MS
        val old = jobs.filterValues { it.data.getString("state") !in activeStates && it.data.getLong("createdAt") < cutoff }.keys.toList()
        for (id in old) {
            val data = jobs.getValue(id).data
            // An observation receipt is not permission to abandon unfinished library work.
            if (recoverable(data)) continue
            if (physicalWorkers.values.contains(id) || (data.getString("kind") == "import" && writingActive())) continue
            discard(context, data, true)
            AtomicFile(File(root, "$id.json")).delete()
            jobs.remove(id)
        }
    }

    @Synchronized
    fun command(
        context: Context,
        args: JSONObject,
    ): JSObject {
        val app = context.applicationContext
        directory(app)
        expire(app)
        val action = args.getString("action")
        val payload = args.getJSONObject("payload")
        val id = payload.getString("id")
        if (!JOB_ID.matches(id)) throw MonitoredFolderIo.Failure("invalid_reference")
        if (action == "cancelImport") {
            for (entry in jobs.values) {
                if (entry.data.getString("kind") == "import" && entry.data.getString("documentId") == id) {
                    if (finish(entry, "cancelled", "cancelled")) requestCancellation(entry)
                }
            }
            return JSObject().put("id", id).put("state", "cancel_requested")
        }
        if (action == "cleanupImport") {
            if (writingActive()) throw MonitoredFolderIo.Failure("busy")
            val paths = payload.getJSONArray("paths")
            cleanupPaths(app, (0 until paths.length()).map { paths.getString(it) })
            val released =
                jobs
                    .filterValues {
                        it.data.getString("kind") == "import" && it.data.getString("documentId") == id &&
                            it.data.getString("state") !in activeStates
                    }.keys
                    .toList()
            for (key in released) {
                AtomicFile(File(root, "$key.json")).delete()
                jobs.remove(key)
            }
            return JSObject().put("id", id).put("state", "released")
        }
        if (action == "start") {
            val kind = payload.getString("kind")
            val folderId = payload.getString("folderId")
            val documentId = payload.optString("documentId", "")
            if (kind !in setOf("list", "read", "inspect", "index", "import") ||
                (kind in setOf("read", "inspect") && !MonitoredFolderIo(app).validId(documentId)) ||
                (kind in setOf("list", "index") && documentId.isNotEmpty())
            ) {
                throw MonitoredFolderIo.Failure("invalid_reference")
            }
            val request = payload.optJSONObject("request") ?: JSONObject()
            if (request.optString("libraryRoot").isNotEmpty()) throw NativeImportFailure("unsupported_library_root")
            if (kind == "index") {
                if (MonitoredFolderIo(app).stored()?.id != folderId) throw MonitoredFolderIo.Failure("invalid_reference")
            } else if (kind == "import") {
                if (folderId != "app-import" || !JOB_ID.matches(documentId)) throw MonitoredFolderIo.Failure("invalid_reference")
                val items = request.getJSONArray("items")
                if (items.length() !in 1..NativeBookImporter.MAX_ITEMS) throw MonitoredFolderIo.Failure("resource_limit")
                for (i in 0 until items.length()) {
                    val path = items.getJSONObject(i).getString("path")
                    if (!Regex("cache/import-[a-f0-9-]{36}\\.bin").matches(path)) throw MonitoredFolderIo.Failure("invalid_reference")
                }
            } else {
                MonitoredFolderIo(app).authorized(folderId)
            }
            jobs[id]?.let { existing ->
                if (existing.data.getString("kind") != kind || existing.data.getString("folderId") != folderId ||
                    existing.data.getString("documentId") != documentId ||
                    NativeBookImporter.requestFingerprint(kind, folderId, existing.data.optJSONObject("request") ?: JSONObject()) !=
                    NativeBookImporter.requestFingerprint(kind, folderId, request)
                ) {
                    throw MonitoredFolderIo.Failure("invalid_reference")
                }
                if (!writingActive()) restoreCommitted(app, existing)
                if (kind == "import" && recoverable(existing.data)) {
                    if (writingActive() ||
                        jobs.values.count { it.data.getString("state") in activeStates } >= 2
                    ) {
                        throw MonitoredFolderIo.Failure("busy")
                    }
                    durable(app, existing.data)
                    sealInputs(request)
                    existing.data
                        .put("state", "queued")
                        .put("code", "")
                        .put("acknowledged", false)
                    existing.data.remove("phase")
                    existing.data.remove("stopPending")
                    val resumed = Job(existing.data)
                    save(resumed.data)
                    jobs[id] = resumed
                    launch(app, resumed)
                    return snapshot(app, resumed)
                }
                return snapshot(app, existing)
            }
            val replaced =
                if (kind == "import") {
                    jobs
                        .filterValues {
                            it.data.getString("kind") == "import" && it.data.getString("documentId") == documentId &&
                                it.data.optBoolean("acknowledged") && it.data.getString("state") !in activeStates
                        }.keys
                        .toList()
                } else {
                    emptyList()
                }
            if (jobs.size - replaced.size >= 16 || physicalWorkers.containsKey(lane(kind)) ||
                jobs.values.count { it.data.getString("state") in activeStates } >= 2 ||
                jobs.values.any { it.data.getString("state") in activeStates && lane(it.data.getString("kind")) == lane(kind) }
            ) {
                throw MonitoredFolderIo.Failure("busy")
            }
            if (kind ==
                "import"
            ) {
                NativeImportDatabase.progress(app, documentId, NativeBookImporter.requestFingerprint(kind, folderId, request))
                sealInputs(request)
            }
            val data =
                JSONObject()
                    .put("id", id)
                    .put("kind", kind)
                    .put("folderId", folderId)
                    .put("documentId", documentId)
                    .put("request", request)
                    .put("state", "queued")
                    .put("code", "")
                    .put("createdAt", System.currentTimeMillis())
            save(data)
            jobs[id] = Job(data)
            for (key in replaced) {
                AtomicFile(File(root, "$key.json")).delete()
                jobs.remove(key)
            }
            launch(app, jobs.getValue(id))
            return snapshot(app, jobs.getValue(id))
        }
        if (action == "ack" && !jobs.containsKey(id)) return JSObject().put("id", id).put("state", "released")
        val job = jobs[id] ?: throw MonitoredFolderIo.Failure("not_found")
        when (action) {
            "status" -> {
                if (job.data.getString("kind") in
                    setOf("list", "read", "inspect")
                ) {
                    MonitoredFolderIo(app).authorized(job.data.getString("folderId"))
                }
            }

            "cancel" -> {
                if (finish(job, "cancelled", "cancelled")) requestCancellation(job)
                // Cleanup remains possible after permission loss; cancellation never discloses a result.
                return JSObject().put("id", id).put("state", job.data.getString("state")).put("code", job.data.getString("code"))
            }

            "ack" -> {
                if (job.data.getString("state") in activeStates) throw MonitoredFolderIo.Failure("busy")
                if (physicalWorkers.values.contains(id) ||
                    (job.data.getString("kind") == "import" && writingActive())
                ) {
                    throw MonitoredFolderIo.Failure("busy")
                }
                restoreCommitted(app, job)
                discard(app, job.data)
                if (recoverable(job.data)) {
                    job.data.put("acknowledged", true)
                    save(job.data)
                    return JSObject().put("id", id).put("state", "released")
                }
                AtomicFile(File(root, "$id.json")).delete()
                jobs.remove(id)
                return JSObject().put("id", id).put("state", "released")
            }

            else -> {
                throw MonitoredFolderIo.Failure("invalid_reference")
            }
        }
        return snapshot(app, job)
    }

    private fun lane(kind: String) =
        when (kind) {
            "index", "import" -> "library-write"
            "inspect" -> "read"
            else -> kind
        }

    private fun snapshot(
        context: Context,
        job: Job,
    ): JSObject {
        val result = JSObject(job.data.toString())
        if (job.data.getString("kind") in setOf("index", "import")) {
            result.remove("progress")
            result.remove("progressError")
            try {
                durable(context, job.data)?.let { result.put("progress", it) }
            } catch (
                error: Exception,
            ) {
                result.put("progressError", NativeBookImporter.code(error))
            }
        }
        return result
    }

    @Synchronized
    fun hasActive() = jobs.values.any { it.data.getString("state") in activeStates }

    private val physicalWorkers = mutableMapOf<String, String>()
    private val completions = mutableMapOf<String, () -> Unit>()
    private val cancellationExecutor = ThreadPoolExecutor(2, 2, 0L, TimeUnit.MILLISECONDS, ArrayBlockingQueue<Runnable>(2))

    // Cancellation listeners can call a provider's Binder. Never run them under the owner lock or UI thread.
    private fun requestCancellation(job: Job) {
        try {
            cancellationExecutor.execute { job.cancellation.cancel() }
        } catch (_: java.util.concurrent.RejectedExecutionException) {
            Log.e(
                "PagewiseFileJobs",
                "Cancellation lane saturated; logical terminal state remains authoritative",
                IllegalStateException("busy"),
            )
        }
    }

    private fun finish(
        job: Job,
        state: String,
        code: String,
        result: JSObject? = null,
    ): Boolean {
        if (job.data.getString("state") !in activeStates) return false
        if (job.committing) {
            if (job.pendingTerminal == null) job.pendingTerminal = state to code
            job.data.put("stopPending", job.pendingTerminal!!.second)
            return false
        }
        job.data.put("state", state).put("code", code)
        if (result != null) job.data.put("result", result)
        try {
            save(job.data)
        } catch (error: Exception) {
            job.data.remove("result")
            job.data.put("state", "failed").put(
                "code",
                if (error is MonitoredFolderIo.Failure &&
                    error.code == "resource_limit"
                ) {
                    "resource_limit"
                } else {
                    "receipt_error"
                },
            )
            try {
                save(job.data)
            } catch (
                saveError: Exception,
            ) {
                Log.e("PagewiseFileJobs", "Unable to publish terminal file job receipt", saveError)
            }
        }
        completions.remove(job.data.getString("id"))?.let { callback -> Handler(Looper.getMainLooper()).post { callback() } }
        return true
    }

    @Synchronized
    fun execute(
        context: Context,
        id: String,
        settled: () -> Unit,
    ) {
        directory(context)
        val job = jobs[id] ?: return settled()
        if (job.data.getString("state") != "queued") return settled()
        val kind = job.data.getString("kind")
        job.data.put("state", "running")
        save(job.data)
        physicalWorkers[lane(kind)] = id
        completions[id] = settled
        val io = MonitoredFolderIo(context.applicationContext)
        val handler = Handler(Looper.getMainLooper())
        val timeout =
            Runnable {
                synchronized(this) {
                    if (finish(job, "failed", "timeout")) requestCancellation(job)
                }
            }
        try {
            executor.execute {
                val budget = if (kind in setOf("index", "import")) 900_000L else JOB_TIMEOUT_MS
                val deadline = SystemClock.elapsedRealtime() + budget
                handler.postDelayed(timeout, budget)
                var result: JSObject? = null
                var code = ""
                try {
                    if (synchronized(this) { job.data.getString("state") != "running" }) throw MonitoredFolderIo.Failure("cancelled")
                    job.cancellation.throwIfCanceled()
                    result =
                        if (kind == "list") {
                            io.list(job.data.getString("folderId"), job.cancellation, deadline)
                        } else if (kind == "read") {
                            io.read(job.data.getString("folderId"), job.data.getString("documentId"), job.cancellation, deadline)
                        } else {
                            val control = importControl(job, deadline)
                            val importer = NativeBookImporter(context.applicationContext)
                            if (kind ==
                                "index"
                            ) {
                                importer.index(
                                    id,
                                    job.data.getString("folderId"),
                                    job.data.getJSONObject("request"),
                                    job.cancellation,
                                    deadline,
                                    control,
                                )
                            } else if (kind ==
                                "inspect"
                            ) {
                                importer.inspect(
                                    job.data.getString("folderId"),
                                    job.data.getString("documentId"),
                                    job.data.getJSONObject("request").getString("fileName"),
                                    job.cancellation,
                                    deadline,
                                    control,
                                )
                            } else {
                                importer.import(job.data.getString("documentId"), job.data.getJSONObject("request"), control)
                            }
                        }
                    job.cancellation.throwIfCanceled()
                } catch (error: Exception) {
                    code = if (kind in setOf("index", "import", "inspect")) NativeBookImporter.code(error) else io.code(error)
                } finally {
                    handler.removeCallbacks(timeout)
                }
                synchronized(this) {
                    val accepted = finish(job, if (code.isEmpty()) "succeeded" else "failed", code, if (code.isEmpty()) result else null)
                    if (!accepted || job.data.getString("state") != "succeeded") io.discard(result)
                    if (physicalWorkers[lane(kind)] == id) physicalWorkers.remove(lane(kind))
                    if (kind == "import" && !recoverable(job.data)) {
                        try {
                            discard(context, job.data)
                        } catch (error: Exception) {
                            job.data.put("cleanupPending", true)
                            Log.e("PagewiseFileJobs", "Import input cleanup pending", error)
                        }
                    }
                }
            }
        } catch (error: java.util.concurrent.RejectedExecutionException) {
            physicalWorkers.remove(lane(kind))
            finish(job, "failed", "busy")
        }
    }

    private fun importControl(
        job: Job,
        deadline: Long,
    ) = object : NativeImportControl {
        override fun checkpoint() {
            synchronized(this@NativeFileJobs) {
                if (job.data.getString("state") != "running") {
                    throw NativeImportFailure(job.data.optString("code").ifEmpty { "cancelled" })
                }
                job.pendingTerminal?.let { throw NativeImportFailure(it.second) }
                if (SystemClock.elapsedRealtime() >= deadline) throw NativeImportFailure("timeout")
                job.cancellation.throwIfCanceled()
            }
        }

        override fun commit(action: () -> Unit) {
            synchronized(this@NativeFileJobs) {
                checkpoint()
                job.committing = true
                job.data.put("phase", "committing")
            }
            var outcomeUnknown = false
            try {
                action()
            } catch (error: Exception) {
                outcomeUnknown = NativeBookImporter.code(error) == "commit_outcome_unknown"
                throw error
            } finally {
                synchronized(this@NativeFileJobs) {
                    // Release the guard and publish the uncertain terminal outcome atomically.
                    // A cancel in catch/finally may defer, but cannot replace this outcome.
                    job.committing = false
                    job.data.remove("phase")
                    if (outcomeUnknown) {
                        job.pendingTerminal = null
                        job.data.remove("stopPending")
                        finish(job, "failed", "commit_outcome_unknown")
                    } else {
                        job.pendingTerminal?.let { terminal ->
                            if (finish(job, terminal.first, terminal.second)) requestCancellation(job)
                        }
                    }
                }
            }
        }

        override fun progress(result: JSONObject) {
            synchronized(this@NativeFileJobs) { job.data.put("progress", JSONObject(result.toString())) }
        }
    }

    @Synchronized
    fun interrupt(ids: Set<String>) {
        for (job in jobs.values) {
            if (job.data.getString("id") in ids && finish(job, "interrupted", "interrupted")) requestCancellation(job)
        }
    }
}

/** User-visible, bounded native work; no WebView callbacks drive progress or completion. */
class NativeFileJobService : Service() {
    private var latestStartId = 0
    private val ownedJobIds = mutableSetOf<String>()

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(
        intent: Intent?,
        flags: Int,
        startId: Int,
    ): Int {
        latestStartId = startId
        intent?.getStringExtra("jobId")?.takeIf { JOB_ID.matches(it) }?.let { ownedJobIds.add(it) }
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >=
            26
        ) {
            manager.createNotificationChannel(NotificationChannel(JOB_CHANNEL, "书籍文件处理", NotificationManager.IMPORTANCE_LOW))
        }
        val notification =
            NotificationCompat
                .Builder(this, JOB_CHANNEL)
                .setSmallIcon(android.R.drawable.stat_sys_download)
                .setContentTitle("知页：正在处理书籍文件")
                .setContentText("目录扫描或文件暂存中；可返回应用查看结果")
                .setOngoing(true)
                .setSilent(true)
                .build()
        try {
            startForeground(JOB_NOTIFICATION, notification)
            val id = intent?.getStringExtra("jobId")
            if (id == null || !JOB_ID.matches(id)) {
                stopSelfResult(startId)
                return START_NOT_STICKY
            }
            NativeFileJobs.execute(applicationContext, id) {
                ownedJobIds.remove(id)
                if (!NativeFileJobs.hasActive()) stopSelfResult(latestStartId)
            }
        } catch (error: Exception) {
            Log.e("PagewiseFileJobs", "Native file service could not start", error)
            NativeFileJobs.interrupt(ownedJobIds.toSet())
            stopSelfResult(startId)
        }
        return START_NOT_STICKY
    }

    override fun onTimeout(
        startId: Int,
        fgsType: Int,
    ) {
        NativeFileJobs.interrupt(ownedJobIds.toSet())
        stopSelf()
    }

    override fun onDestroy() {
        NativeFileJobs.interrupt(ownedJobIds.toSet())
        stopForeground(STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }
}
