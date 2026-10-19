package io.pagewise.reader

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Binder
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.PowerManager
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.speech.tts.Voice
import android.util.AtomicFile
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

private const val SPEECH_CHANNEL = "pagewise-tts"
private const val SPEECH_NOTIFICATION = 4102
private const val MAX_QUEUE_BYTES = 64L * 1024 * 1024
private const val MAX_QUEUE_RECORDS = 200_000

private class SpeechFailure(
    val code: String,
) : Exception(code)

/** App-private, length-prefixed UTF-8 records; only offsets are held in memory. */
private class SpeechQueue(
    val id: String,
    val owner: String,
    val file: File,
    val sourceVersion: String = "legacy",
    val expectedUnits: Int = 0,
) {
    val covered = HashSet<Int>()
    val offsets = ArrayList<Long>()
    var bytes = 0L
    var digest = ""
    var resumeKey = ""

    private fun compareKeys(
        a: String,
        b: String,
    ): Int {
        val left = a.split(':').map { it.toInt() }
        val right = b.split(':').map { it.toInt() }
        for (index in 0 until maxOf(left.size, right.size)) {
            val difference = (left.getOrNull(index) ?: -1).compareTo(right.getOrNull(index) ?: -1)
            if (difference != 0) return difference
        }
        return 0
    }

    fun findKey(key: String): Int {
        var low = 0
        var high = offsets.size - 1
        while (low <= high) {
            val middle = (low + high).ushr(1)
            val compared = compareKeys(read(middle).getString("key"), key)
            if (compared == 0) return middle
            if (compared < 0) low = middle + 1 else high = middle - 1
        }
        throw SpeechFailure("source_changed")
    }

    private fun group(index: Int) =
        read(index)
            .getString("key")
            .split(':')
            .take(2)
            .joinToString(":")

    private fun groupBound(
        key: String,
        after: Boolean,
    ): Int {
        var low = 0
        var high = offsets.size
        while (low < high) {
            val middle = (low + high).ushr(1)
            val compared = compareKeys(group(middle), key)
            if (compared < 0 || (after && compared == 0)) low = middle + 1 else high = middle
        }
        return low
    }

    fun paragraphTarget(
        index: Int,
        delta: Int,
    ): Int {
        if (delta == 0) return index
        if (index >= offsets.size) return if (delta > 0) index else groupBound(group(offsets.lastIndex), false)
        val key = group(index)
        if (delta > 0) {
            val next = groupBound(key, true)
            return if (next < offsets.size) next else index
        }
        val start = groupBound(key, false)
        return if (start > 0) groupBound(group(start - 1), false) else index
    }

    fun hash(): String {
        val hash = java.security.MessageDigest.getInstance("SHA-256")
        file.inputStream().buffered().use { input ->
            val buffer = ByteArray(65536)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                hash.update(buffer, 0, count)
            }
        }
        return hash.digest().joinToString("") { "%02x".format(it) }
    }

    fun append(items: org.json.JSONArray) {
        if (items.length() !in 1..200 || offsets.size + items.length() > MAX_QUEUE_RECORDS) throw SpeechFailure("resource_limit")
        var previous = if (offsets.isEmpty()) null else read(offsets.lastIndex).getString("key")
        val records =
            (0 until items.length()).map { index ->
                val item = items.getJSONObject(index)
                val text = item.getString("text")
                val key = item.getString("key")
                if (text.isBlank() || text.length > TextToSpeech.getMaxSpeechInputLength() ||
                    key.length !in 1..240
                ) {
                    throw SpeechFailure("invalid_sentence")
                }
                if (!key.matches(Regex("[0-9]{1,8}(:[0-9]{1,8}){0,3}")) ||
                    (previous != null && compareKeys(previous!!, key) >= 0)
                ) {
                    throw SpeechFailure("invalid_sentence")
                }
                previous = key
                JSONObject()
                    .put(
                        "key",
                        key,
                    ).put("text", text)
                    .put("sectionEnd", item.optBoolean("sectionEnd"))
                    .toString()
                    .toByteArray(Charsets.UTF_8)
            }
        val size = records.sumOf { it.size.toLong() + 4 }
        if (bytes + size > MAX_QUEUE_BYTES || size > 2 * 1024 * 1024) throw SpeechFailure("resource_limit")
        if (file.usableSpace < size + 4 * 1024 * 1024) throw SpeechFailure("disk_full")
        RandomAccessFile(file, "rw").use { out ->
            val start = bytes
            try {
                out.seek(start)
                val next = ArrayList<Long>()
                for (record in records) {
                    next.add(out.filePointer)
                    out.writeInt(record.size)
                    out.write(record)
                }
                offsets.addAll(next)
                bytes = out.filePointer
            } catch (error: Exception) {
                out.setLength(start)
                throw error
            }
        }
    }

    fun read(index: Int): JSONObject =
        RandomAccessFile(file, "r").use { input ->
            input.seek(offsets[index])
            val size = input.readInt()
            if (size !in 1..65536) throw SpeechFailure("queue_corrupt")
            val bytes = ByteArray(size)
            input.readFully(bytes)
            JSONObject(String(bytes, Charsets.UTF_8))
        }

    fun sync() {
        RandomAccessFile(file, "rw").use { it.fd.sync() }
        digest = hash()
    }

    fun rebuild() {
        if (!file.isFile || file.length() > MAX_QUEUE_BYTES) throw SpeechFailure("queue_corrupt")
        RandomAccessFile(file, "r").use { input ->
            while (input.filePointer < input.length()) {
                val at = input.filePointer
                val size = input.readInt()
                if (size !in 1..65536 || input.filePointer + size > input.length() ||
                    offsets.size >= MAX_QUEUE_RECORDS
                ) {
                    throw SpeechFailure("queue_corrupt")
                }
                offsets.add(at)
                input.seek(input.filePointer + size)
            }
            bytes = input.length()
        }
    }
}

/** Single owner of TTS, focus, the complete prepared queue and its listening checkpoint. */
class SystemTtsService :
    Service(),
    TextToSpeech.OnInitListener {
    inner class LocalBinder : Binder() {
        val service: SystemTtsService get() = this@SystemTtsService
    }

    // TTS and MediaSession accept an explicit Looper. Keeping their callbacks,
    // timers and durable state on this owner avoids synchronous main/worker waits.
    private val worker = HandlerThread("PagewiseSpeech").apply { start() }
    private val owner = Handler(worker.looper)
    private val closing = AtomicBoolean(false)
    private val pending = AtomicInteger(0)
    private val readyCallbacks = ArrayList<(Boolean) -> Unit>()
    private val root by lazy { File(noBackupFilesDir, "pagewise-speech").apply { mkdirs() } }
    private val checkpoint by lazy { AtomicFile(File(root, "checkpoint.json")) }
    private val audio by lazy { getSystemService(Context.AUDIO_SERVICE) as AudioManager }
    private var engine: TextToSpeech? = null
    private var engineReady = false
    private var restored = false
    private var destroyed = false
    private var checkpointUncertain = false
    private var active: SpeechQueue? = null
    private var staging: SpeechQueue? = null
    private var currentRecord: JSONObject? = null
    private var index = 0

    private fun moveCursor(value: Int) {
        val queue = active
        val record =
            if (queue != null && queue.offsets.isNotEmpty()) {
                queue.read(value.coerceAtMost(queue.offsets.lastIndex))
            } else {
                null
            }
        index = value
        currentRecord = record
    }

    private var state = "idle"
    private var reason = ""
    private var errorCode = ""
    private var rate = 1f
    private var voice = ""
    private var deadline = 0L
    private var stopAtSection = false
    private var generation = 0L
    private var sequence = 0L
    private var focus: AudioFocusRequest? = null
    private var hasFocus = false
    private val instance = UUID.randomUUID().toString()
    private val requests = LinkedHashMap<String, String>()
    private var media: MediaSession? = null
    private var mediaOwner = ""
    private var mediaEpoch = 0L
    private val noisy =
        object : BroadcastReceiver() {
            override fun onReceive(
                context: Context?,
                intent: Intent?,
            ) {
                postEvent { if (state == "playing") safePause("headphones_disconnected") }
            }
        }
    private var foreground = false
    private var wake: PowerManager.WakeLock? = null
    private var legacyDone: ((String, Int) -> Unit)? = null
    private var timer = Runnable {}
    private var stageTimeout = Runnable {}
    private var utteranceTimeout = Runnable {}

    private fun postEvent(block: () -> Unit) {
        if (closing.get()) return
        owner.post { if (!destroyed && !closing.get()) block() }
    }

    /** Bounded transport admission; cancelled queued work never reaches dispatch. */
    fun submit(
        cancelled: () -> Boolean,
        reject: () -> Unit,
        block: () -> Unit,
    ) {
        if (closing.get()) {
            reject()
            return
        }
        if (pending.incrementAndGet() > 64) {
            pending.decrementAndGet()
            reject()
            return
        }
        if (!owner.post {
                try {
                    if (closing.get() || cancelled()) reject() else block()
                } finally {
                    pending.decrementAndGet()
                }
            }
        ) {
            pending.decrementAndGet()
            reject()
        }
    }

    private fun scheduleStageTimeout() {
        owner.removeCallbacks(stageTimeout)
        val id = staging?.id
        stageTimeout =
            Runnable {
                if (!destroyed && staging?.id == id) {
                    abortStaging()
                    if (state != "playing") releasePlayback(true)
                }
            }
        owner.postDelayed(stageTimeout, 120_000)
    }

    private fun scheduleTimer() {
        owner.removeCallbacks(timer)
        val id = active?.id
        val until = deadline
        timer =
            Runnable {
                if (!destroyed && active?.id == id && deadline == until && state == "playing") safePause("timer")
            }
        if (until > System.currentTimeMillis()) owner.postDelayed(timer, until - System.currentTimeMillis())
    }

    override fun onBind(intent: Intent?): IBinder = LocalBinder()

    override fun onCreate() {
        super.onCreate()
        registerReceiver(noisy, IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY))
        postEvent {
            engine = TextToSpeech(applicationContext, this)
            var queue: SpeechQueue? = null
            var record: JSONObject? = null
            var meta: JSONObject? = null
            var failure = ""
            try {
                if (checkpoint.baseFile.exists() || File(root, "checkpoint.json.bak").exists()) {
                    meta = JSONObject(String(checkpoint.openRead().use { it.readBytes() }, Charsets.UTF_8))
                    val id = meta.getString("id")
                    if (!validId(id)) throw SpeechFailure("queue_corrupt")
                    queue =
                        SpeechQueue(
                            id,
                            meta.getString("owner"),
                            File(root, "$id.bin"),
                            meta.getString("sourceVersion"),
                            meta.getInt("expectedUnits"),
                        )
                    queue.rebuild()
                    queue.digest = queue.hash()
                    if (queue.offsets.size != meta.getInt("count") || queue.digest != meta.getString("sha256") ||
                        meta.getInt("index") !in 0..queue.offsets.size
                    ) {
                        throw SpeechFailure("queue_corrupt")
                    }
                    if (queue.offsets.isNotEmpty()) record = queue.read(meta.getInt("index").coerceAtMost(queue.offsets.lastIndex))
                }
                val keep = queue?.file?.name
                root.listFiles()?.filter { it.name.endsWith(".bin") && it.name != keep }?.forEach { it.delete() }
            } catch (error: Exception) {
                android.util.Log.e("PagewiseSpeech", "Listening checkpoint could not be restored", error)
                failure = "queue_corrupt"
                queue = null
            }
            run {
                active = queue
                currentRecord = if (queue != null) record else null
                if (queue != null && meta != null) {
                    index = meta.optInt("index", 0)
                    voice = meta.optString("voice", "")
                    rate = meta.optDouble("rate", 1.0).toFloat().coerceIn(0.5f, 3f)
                    deadline = meta.optLong("deadline", 0)
                    stopAtSection = meta.optBoolean("stopAtSection")
                    state =
                        when (meta.optString("state")) {
                            "finished" -> "finished"
                            "stopped" -> "stopped"
                            else -> "paused"
                        }
                    reason = "process_restart"
                } else if (failure.isNotEmpty()) {
                    state = "error"
                    errorCode = failure
                }
                restored = true
                notifyReady()
            }
        }
    }

    override fun onInit(status: Int) {
        postEvent {
            engineReady = status == TextToSpeech.SUCCESS
            if (engineReady) {
                engine?.setAudioAttributes(
                    AudioAttributes
                        .Builder()
                        .setUsage(
                            AudioAttributes.USAGE_MEDIA,
                        ).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build(),
                )
            }
            if (engineReady) {
                engine?.setOnUtteranceProgressListener(
                    object : UtteranceProgressListener() {
                        override fun onStart(id: String?) = Unit

                        override fun onDone(id: String?) {
                            postEvent { completed(id) }
                        }

                        @Deprecated("Deprecated in Java")
                        override fun onError(id: String?) {
                            postEvent { if (matches(id)) fail("tts_error") }
                        }

                        override fun onError(
                            id: String?,
                            code: Int,
                        ) {
                            postEvent { if (matches(id)) fail("tts_error") }
                        }
                    },
                )
            }
            if (!engineReady) errorCode = "tts_unavailable"
            notifyReady()
        }
    }

    fun ready(callback: (Boolean) -> Unit) {
        if (destroyed) {
            callback(false)
            return
        }
        if (restored && engineReady) {
            callback(true)
            return
        }
        if (errorCode == "tts_unavailable") {
            callback(false)
            return
        }
        if (readyCallbacks.size >= 64) {
            callback(false)
            return
        }
        readyCallbacks.add(callback)
        owner.postDelayed({ if (readyCallbacks.remove(callback)) callback(false) }, 15_000)
    }

    private fun notifyReady() {
        if (!restored || !engineReady) return
        val callbacks = readyCallbacks.toList()
        readyCallbacks.clear()
        callbacks.forEach { it(true) }
    }

    private fun validId(id: String) = id.matches(Regex("[0-9a-f-]{36}"))

    private fun checkId(id: String) {
        if (id != (staging ?: active)?.id) throw SpeechFailure("session_replaced")
    }

    private fun persist() {
        val queue = active ?: return
        val data =
            JSONObject()
                .put("version", 1)
                .put("id", queue.id)
                .put("owner", queue.owner)
                .put("sourceVersion", queue.sourceVersion)
                .put("expectedUnits", queue.expectedUnits)
                .put("count", queue.offsets.size)
                .put("sha256", queue.digest)
                .put("index", index)
                .put("state", state)
                .put("rate", rate)
                .put("voice", voice)
                .put("deadline", deadline)
                .put("stopAtSection", stopAtSection)
                .put("updatedAt", System.currentTimeMillis())
        val bytes = data.toString().toByteArray(Charsets.UTF_8)
        val out = checkpoint.startWrite()
        var finished = false
        try {
            out.write(bytes)
            out.fd.sync()
            checkpoint.finishWrite(out)
            finished = true
            // Android AtomicFile may log a failed rename instead of throwing.
            // Confirm the exact published record before retiring any old queue.
            if (!checkpoint.baseFile.isFile || checkpoint.baseFile.length() > 65536 ||
                !checkpoint.baseFile.readBytes().contentEquals(bytes)
            ) {
                throw java.io.IOException("Checkpoint publication not confirmed")
            }
            val directory = android.system.Os.open(root.absolutePath, android.system.OsConstants.O_RDONLY, 0)
            try {
                android.system.Os.fsync(directory)
            } finally {
                android.system.Os.close(directory)
            }
            checkpointUncertain = false
        } catch (error: Exception) {
            checkpointUncertain = true
            if (!finished) checkpoint.failWrite(out)
            throw error
        }
    }

    private fun snapshot(): JSObject {
        val queue = staging ?: active
        return JSObject()
            .put("id", queue?.id ?: "")
            .put("instance", instance)
            .put("generation", generation)
            .put("owner", queue?.owner ?: "")
            .put("sourceVersion", queue?.sourceVersion ?: "")
            .put("state", state)
            .put("reason", reason)
            .put("code", errorCode)
            .put("sequence", sequence)
            .put("index", index)
            .put("count", queue?.offsets?.size ?: 0)
            .put("committed", staging == null && active != null)
            .put("key", if (staging == null) currentRecord?.optString("key") ?: "" else "")
            .put("text", if (staging == null) currentRecord?.optString("text") ?: "" else "")
            .put("voice", voice)
            .put("rate", rate)
            .put("deadline", deadline)
            .put("stopAtSection", stopAtSection)
    }

    fun voices(): JSObject {
        val list = JSArray()
        var chinese = false
        var chineseOnline = false
        for (item in engine?.voices.orEmpty().filter { !it.features.orEmpty().contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED) }) {
            if (item.locale.language == "zh") {
                if (item.isNetworkConnectionRequired) chineseOnline = true else chinese = true
            }
            list.put(
                JSObject()
                    .put(
                        "name",
                        item.name,
                    ).put("locale", item.locale.toLanguageTag())
                    .put("network", item.isNetworkConnectionRequired)
                    .put("quality", item.quality),
            )
        }
        return JSObject()
            .put(
                "available",
                engineReady,
            ).put("chinese", chinese)
            .put("onlineOnly", chineseOnline && !chinese)
            .put("voices", list)
    }

    fun dispatch(
        action: String,
        args: JSONObject,
        resolve: (JSObject) -> Unit,
        reject: (String) -> Unit,
    ) {
        try {
            if (destroyed) throw SpeechFailure("tts_unavailable")
            if (args.has("instance") && args.getString("instance") != instance) throw SpeechFailure("instance_replaced")
            val requestId = args.optString("requestId")
            val fingerprint = "$action:$args"
            if (requestId.isNotEmpty() && requests.containsKey(requestId)) {
                if (requests[requestId] != fingerprint) throw SpeechFailure("request_conflict")
                resolve(snapshot())
                return
            }
            if (args.has("generation") && args.getLong("generation") != generation) throw SpeechFailure("stale_generation")
            when (action) {
                "status" -> {
                    resolve(snapshot())
                    return
                }

                "begin" -> {
                    if (args.has("expectedId") &&
                        args.getString("expectedId") != ((staging ?: active)?.id ?: "")
                    ) {
                        throw SpeechFailure("session_replaced")
                    }
                    if (checkpointUncertain) persist() // reconcile the old checkpoint before another prepare
                    val owner = args.getString("owner")
                    if (!owner.matches(Regex("[A-Za-z0-9_:-]{1,120}"))) throw SpeechFailure("invalid_owner")
                    val version = args.optString("sourceVersion", "legacy")
                    val expected = args.optInt("expectedUnits", 0)
                    if (version.length !in 1..160 || expected !in 0..100_000) throw SpeechFailure("invalid_source")
                    val resumeRequested = args.optBoolean("resumeFromCheckpoint") && active?.owner == owner
                    if (resumeRequested && active?.sourceVersion != version) throw SpeechFailure("source_changed")
                    if (resumeRequested && active!!.offsets.isNotEmpty() &&
                        index >= active!!.offsets.size
                    ) {
                        abortStaging()
                        releasePlayback(true)
                        resolve(snapshot())
                        return
                    }
                    if (state == "playing") pause("replacement")
                    val savedStartKey = if (resumeRequested && active!!.offsets.isNotEmpty()) active!!.read(index).getString("key") else ""
                    legacyDone?.invoke("tts_stopped", index)
                    legacyDone = null
                    abortStaging()
                    val id = UUID.randomUUID().toString()
                    staging =
                        SpeechQueue(id, owner, File(root, "$id.bin").apply { createNewFile() }, version, expected).apply {
                            resumeKey =
                                savedStartKey
                        }
                    state = "preparing"
                    reason = ""
                    errorCode = ""
                    sequence++
                    scheduleStageTimeout()
                    startPlaybackHost()
                }

                "append" -> {
                    checkId(args.getString("id"))
                    val queue = staging ?: throw SpeechFailure("not_preparing")
                    if (args.optInt("offset", queue.offsets.size) != queue.offsets.size) throw SpeechFailure("append_conflict")
                    val coverage = args.optJSONArray("coverage") ?: org.json.JSONArray()
                    val units = (0 until coverage.length()).map { coverage.getInt(it) }
                    if (units.any { it !in 0 until queue.expectedUnits }) throw SpeechFailure("coverage_incomplete")
                    val items = args.getJSONArray("items")
                    if (items.length() > 0) queue.append(items)
                    queue.covered.addAll(units)
                    sequence++
                    scheduleStageTimeout()
                }

                "commit" -> {
                    checkId(args.getString("id"))
                    val next = staging ?: throw SpeechFailure("not_preparing")
                    if (next.offsets.isEmpty()) throw SpeechFailure("tts_empty")
                    if (next.covered.size != next.expectedUnits ||
                        args.optInt("count", next.offsets.size) != next.offsets.size
                    ) {
                        throw SpeechFailure("coverage_incomplete")
                    }
                    val startKey = next.resumeKey.ifEmpty { args.optString("startKey") }
                    val start = if (startKey.isEmpty()) 0 else next.findKey(startKey)
                    next.sync()
                    val old = active
                    val oldIndex = index
                    val oldRecord = currentRecord
                    val oldRate = rate
                    val oldVoice = voice
                    val oldDeadline = deadline
                    val oldStop = stopAtSection
                    try {
                        active = next
                        moveCursor(start)
                        state = "paused"
                        reason = "prepared"
                        errorCode = ""
                        configure(args)
                        persist()
                    } catch (error: Exception) {
                        active = old
                        index = oldIndex
                        currentRecord = oldRecord
                        state = "preparing"
                        rate = oldRate
                        voice = oldVoice
                        deadline = oldDeadline
                        stopAtSection = oldStop
                        scheduleTimer()
                        throw error
                    }
                    staging = null
                    this@SystemTtsService.owner.removeCallbacks(stageTimeout)
                    old?.file?.delete()
                    if (args.optBoolean("autoplay", true)) resume() else showNotification()
                }

                "discard" -> {
                    checkId(args.getString("id"))
                    if (staging == null) throw SpeechFailure("not_preparing")
                    abortStaging()
                    releasePlayback(true)
                }

                "adopt" -> {
                    checkId(args.getString("id"))
                    if (active?.sourceVersion != args.getString("sourceVersion")) throw SpeechFailure("source_changed")
                    if (state == "stopped" && index < (active?.offsets?.size ?: 0)) {
                        state = "paused"
                        reason = "user_stop"
                        generation++
                        sequence++
                        persist()
                    }
                }

                "pause" -> {
                    checkId(args.getString("id"))
                    if (staging != null) throw SpeechFailure("not_committed")
                    if (state == "playing") pause("user")
                }

                "resume" -> {
                    checkId(args.getString("id"))
                    resumeExplicit()
                }

                "seek" -> {
                    checkId(args.getString("id"))
                    if (staging != null) throw SpeechFailure("not_committed")
                    val queue = active ?: throw SpeechFailure("no_session")
                    val delta = args.optInt("delta", 0).coerceIn(-1, 1)
                    val target =
                        if (args.has("key")) {
                            queue.findKey(args.getString("key"))
                        } else if (args.optString("kind") ==
                            "paragraph"
                        ) {
                            queue.paragraphTarget(index, delta)
                        } else {
                            (index + delta).coerceIn(0, queue.offsets.size - 1)
                        }
                    if (target != index) {
                        val playing = state == "playing"
                        pause("seek")
                        moveCursor(target)
                        persist()
                        if (playing) resume()
                    }
                }

                "configure" -> {
                    checkId(args.getString("id"))
                    val changed =
                        args.optDouble("rate", rate.toDouble()).toFloat().coerceIn(0.5f, 3f) != rate ||
                            args.optString("voice", voice) != voice ||
                            args.optLong("deadline", deadline) != deadline ||
                            args.optBoolean("stopAtSection", stopAtSection) != stopAtSection
                    if (changed) {
                        val playing = state == "playing"
                        if (playing) pause("configuration")
                        configure(args)
                        sequence++
                        persist()
                        if (playing) resume()
                    }
                }

                "stop" -> {
                    checkId(args.getString("id"))
                    if (staging != null) abortStaging()
                    deadline = 0
                    stopAtSection = false
                    this@SystemTtsService.owner.removeCallbacks(timer)
                    pause("user_stop")
                    state = "stopped"
                    persist()
                    releasePlayback(true)
                    sequence++
                    legacyDone?.invoke("tts_stopped", index)
                    legacyDone = null
                }

                else -> {
                    throw SpeechFailure("invalid_action")
                }
            }
            if (requestId.isNotEmpty()) {
                requests[requestId] = fingerprint
                if (requests.size > 64) requests.remove(requests.keys.first())
            }
            resolve(snapshot())
        } catch (error: Exception) {
            val code = (error as? SpeechFailure)?.code ?: "io_error"
            if (code == "io_error") {
                android.util.Log.e("PagewiseSpeech", "Speech command failed", error)
                fail(code)
            }
            reject(code)
        }
    }

    private fun abortStaging() {
        this@SystemTtsService.owner.removeCallbacks(stageTimeout)
        if (!checkpointUncertain) staging?.file?.delete()
        staging = null
        if (state == "preparing") {
            state = if (active != null) "paused" else "idle"
            reason = "preparation_cancelled"
            sequence++
        }
    }

    private fun configure(args: JSONObject) {
        val nextRate = args.optDouble("rate", rate.toDouble()).toFloat().coerceIn(0.5f, 3f)
        val nextVoice = args.optString("voice", voice)
        val nextDeadline = args.optLong("deadline", deadline)
        val nextStop = args.optBoolean("stopAtSection", stopAtSection)
        if (nextVoice.length > 240 || !nextRate.isFinite() || nextDeadline < 0) throw SpeechFailure("invalid_settings")
        rate = nextRate
        voice = nextVoice
        deadline = nextDeadline
        stopAtSection = nextStop
        if ((args.has("deadline") || args.has("stopAtSection")) && reason in listOf("timer", "chapter") &&
            (deadline > System.currentTimeMillis() || stopAtSection)
        ) {
            reason = "user"
        }
        scheduleTimer()
    }

    private var focusListener: AudioManager.OnAudioFocusChangeListener? = null
    private var focusEpoch = 0L

    private fun focusListener(epoch: Long) =
        AudioManager.OnAudioFocusChangeListener { change ->
            postEvent {
                if (focusEpoch != epoch || !hasFocus) return@postEvent
                when (change) {
                    AudioManager.AUDIOFOCUS_LOSS -> {
                        if (state == "playing") safePause("focus_lost")
                    }

                    AudioManager.AUDIOFOCUS_LOSS_TRANSIENT, AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> {
                        if (state ==
                            "playing"
                        ) {
                            safePause("focus_transient")
                        }
                    }

                    AudioManager.AUDIOFOCUS_GAIN -> {
                        Unit
                    } // No automatic resume or stale re-acquisition.
                }
            }
        }

    private fun acquireFocus(): Boolean {
        if (hasFocus) return true
        val listener = focusListener(++focusEpoch)
        focusListener = listener
        hasFocus =
            if (Build.VERSION.SDK_INT >= 26) {
                val request =
                    AudioFocusRequest
                        .Builder(AudioManager.AUDIOFOCUS_GAIN)
                        .setAudioAttributes(
                            AudioAttributes
                                .Builder()
                                .setUsage(
                                    AudioAttributes.USAGE_MEDIA,
                                ).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                                .build(),
                        ).setOnAudioFocusChangeListener(listener, owner)
                        .setAcceptsDelayedFocusGain(false)
                        .build()
                focus = request
                audio.requestAudioFocus(request) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
            } else {
                @Suppress("DEPRECATION")
                audio.requestAudioFocus(listener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN) ==
                    AudioManager.AUDIOFOCUS_REQUEST_GRANTED
            }
        return hasFocus
    }

    private fun abandonFocus() {
        focusEpoch++
        hasFocus = false
        if (Build.VERSION.SDK_INT >= 26) {
            focus?.let { audio.abandonAudioFocusRequest(it) }
            focus = null
        } else {
            @Suppress("DEPRECATION")
            focusListener?.let { audio.abandonAudioFocus(it) }
        }
        focusListener = null
    }

    private fun holdCpu(timeout: Long = 30 * 60 * 1000L) {
        if (wake ==
            null
        ) {
            wake =
                (
                    getSystemService(
                        Context.POWER_SERVICE,
                    ) as PowerManager
                ).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "pagewise:native-speech").apply {
                    setReferenceCounted(false)
                }
        }
        wake?.acquire(timeout)
    }

    private fun releasePlayback(stopForeground: Boolean) {
        updateMedia()
        wake?.let { if (it.isHeld) it.release() }
        abandonFocus()
        if (stopForeground) {
            if (foreground) {
                stopForeground(STOP_FOREGROUND_REMOVE)
                foreground = false
            }
            stopSelf()
            releaseMedia()
        } else if (destroyed) {
            releaseMedia()
        }
    }

    private fun pause(
        why: String,
        releaseFocus: Boolean = true,
    ) {
        generation++
        this@SystemTtsService.owner.removeCallbacks(utteranceTimeout)
        engine?.stop()
        if (state != "preparing") state = "paused"
        reason = why
        if (why == "timer") deadline = 0
        if (why == "chapter") stopAtSection = false
        sequence++
        wake?.let { if (it.isHeld) it.release() }
        if (releaseFocus) abandonFocus()
        persist()
        if (foreground) showNotification()
        if (active?.owner == "legacy" && why.startsWith("focus_")) {
            legacyDone?.invoke("audio_focus_lost", index)
            legacyDone = null
        }
    }

    private fun resumeExplicit() {
        if (state == "playing") return
        if (state != "paused") throw SpeechFailure("not_paused")
        if (reason in listOf("timer", "chapter") || (deadline > 0 && deadline <= System.currentTimeMillis())) {
            deadline = 0
            stopAtSection = false
            this@SystemTtsService.owner.removeCallbacks(timer)
            persist()
        }
        resume()
    }

    private fun startPlaybackHost() {
        try {
            val host =
                Intent(this, SystemTtsService::class.java)
                    .setAction("host")
                    .putExtra("id", (staging ?: active)?.id ?: "")
                    .putExtra("instance", instance)
                    .putExtra("generation", generation)
            ContextCompat.startForegroundService(applicationContext, host)
            showNotification()
        } catch (error: RuntimeException) {
            android.util.Log.e("PagewiseSpeech", "Foreground speech service unavailable", error)
            throw SpeechFailure("background_unavailable")
        }
    }

    private fun resume() {
        if (staging != null) throw SpeechFailure("not_committed")
        val queue = active ?: throw SpeechFailure("no_session")
        if (index >= queue.offsets.size) {
            state = "finished"
            persist()
            releasePlayback(true)
            return
        }
        if (deadline > 0 && deadline <= System.currentTimeMillis()) {
            state = "paused"
            reason = "timer"
            persist()
            return
        }
        if (!acquireFocus()) throw SpeechFailure("audio_focus_denied")
        generation++
        state = "playing"
        reason = ""
        errorCode = ""
        sequence++
        try {
            startPlaybackHost()
            holdCpu()
            speakCurrent()
        } catch (
            error: Exception,
        ) {
            fail((error as? SpeechFailure)?.code ?: "tts_error")
            throw error
        }
    }

    private fun chooseVoice(text: String): Voice {
        val voices = engine?.voices.orEmpty().filter { !it.features.orEmpty().contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED) }
        if (voice.isNotEmpty()) return voices.firstOrNull { it.name == voice } ?: throw SpeechFailure("voice_missing")
        val language = if (text.any { it.code in 0x3400..0x9fff }) "zh" else "en"
        return voices
            .filter { !it.isNetworkConnectionRequired && it.locale.language == language }
            .sortedWith(compareBy<Voice>({ if (language == "zh" && it.locale.country == "CN") 0 else 1 }, { -it.quality }, { it.name }))
            .firstOrNull() ?: throw SpeechFailure("no_offline_voice")
    }

    private fun utteranceId() = "${active?.id}:$generation:$index"

    private fun matches(id: String?) = !destroyed && state == "playing" && id == utteranceId()

    private fun speakCurrent() {
        if (active == null) throw SpeechFailure("no_session")
        val record = currentRecord ?: throw SpeechFailure("queue_corrupt")
        val text = record.getString("text")
        val tts = engine ?: throw SpeechFailure("tts_unavailable")
        if (tts.setVoice(chooseVoice(text)) != TextToSpeech.SUCCESS ||
            tts.setSpeechRate(rate) != TextToSpeech.SUCCESS
        ) {
            throw SpeechFailure("tts_error")
        }
        persist()
        val timeout = (text.length * 1000L / rate + 60_000).toLong().coerceIn(60_000L, 4_800_000L)
        holdCpu(timeout + 10_000)
        owner.removeCallbacks(utteranceTimeout)
        val id = utteranceId()
        utteranceTimeout = Runnable { if (matches(id)) fail("tts_timeout") }
        owner.postDelayed(utteranceTimeout, timeout)
        if (tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, utteranceId()) != TextToSpeech.SUCCESS) throw SpeechFailure("tts_error")
    }

    private fun completed(id: String?) {
        if (!matches(id)) return
        this@SystemTtsService.owner.removeCallbacks(utteranceTimeout)
        try {
            val queue = active ?: return
            val sectionEnd = currentRecord?.optBoolean("sectionEnd") == true
            moveCursor(index + 1)
            sequence++
            if (index >= queue.offsets.size) {
                state = "finished"
                persist()
                releasePlayback(true)
                legacyDone?.invoke("done", index)
                legacyDone = null
            } else if (stopAtSection && sectionEnd) {
                pause("chapter")
            } else if (deadline > 0 && deadline <= System.currentTimeMillis()) {
                pause("timer")
            } else {
                speakCurrent()
            }
        } catch (error: Exception) {
            fail((error as? SpeechFailure)?.code ?: "io_error")
        }
    }

    private fun fail(code: String) {
        generation++
        this@SystemTtsService.owner.removeCallbacks(utteranceTimeout)
        engine?.stop()
        state = "error"
        errorCode = code
        reason = ""
        sequence++
        try {
            persist()
        } catch (error: Exception) {
            android.util.Log.e("PagewiseSpeech", "Checkpoint write failed", error)
        }
        releasePlayback(true)
        legacyDone?.invoke(code, index)
        legacyDone = null
    }

    /** Compatibility for old one-shot callers; never interrupt an owned book session. */
    fun legacy(
        texts: List<String>,
        requestedRate: Double,
        requestedVoice: String,
        callback: (String, Int) -> Unit,
    ) {
        val savedBook = active?.let { it.owner != "legacy" && index < it.offsets.size } == true
        if (savedBook || (active?.owner != "legacy" && state in listOf("playing", "paused", "preparing")) || staging != null) {
            callback("tts_busy", 0)
            return
        }
        dispatch("begin", JSONObject().put("owner", "legacy"), { begin ->
            val id = begin.getString("id")
            val records = org.json.JSONArray()
            texts.forEachIndexed { i, text -> records.put(JSONObject().put("key", "$i").put("text", text)) }
            dispatch("append", JSONObject().put("id", id).put("items", records), {
                legacyDone = callback
                dispatch(
                    "commit",
                    JSONObject()
                        .put(
                            "id",
                            id,
                        ).put("rate", requestedRate)
                        .put("voice", requestedVoice)
                        .put("deadline", 0)
                        .put("stopAtSection", false),
                    {
                    },
                    { code ->
                        legacyDone =
                            null
                        ; callback(code, index)
                    },
                )
            }, { code -> callback(code, 0) })
        }, { code -> callback(code, 0) })
    }

    fun stopLegacy(resolve: (JSObject) -> Unit) {
        if ((staging ?: active)?.owner ==
            "legacy"
        ) {
            dispatch(
                "stop",
                JSONObject().put("id", (staging ?: active)!!.id),
                resolve,
                { resolve(JSObject().put("status", "stopped")) },
            )
        } else {
            resolve(JSObject().put("status", "stopped"))
        }
    }

    fun legacyStatus(): JSObject = JSObject().put("index", index).put("playing", active?.owner == "legacy" && state == "playing")

    private fun safePause(reason: String) {
        try {
            pause(reason)
        } catch (error: Exception) {
            fail("io_error")
        }
    }

    private fun nativeSeek(delta: Int) {
        active?.let { dispatch("seek", JSONObject().put("id", it.id).put("delta", delta), {}, { fail(it) }) }
    }

    private fun releaseMedia() {
        mediaEpoch++
        mediaOwner = ""
        val old = media
        media = null
        old?.release()
    }

    private fun ensureMedia() {
        val owner = (staging ?: active)?.id ?: ""
        if (media != null && mediaOwner == owner) return
        releaseMedia()
        mediaOwner = owner
        val epoch = mediaEpoch

        fun valid() = !destroyed && mediaEpoch == epoch && staging == null && active?.id == owner
        media =
            MediaSession(this, "PagewiseSpeech").apply {
                setCallback(
                    object : MediaSession.Callback() {
                        override fun onPlay() {
                            if (!valid() || state != "paused") return
                            try {
                                resumeExplicit()
                            } catch (error: Exception) {
                                fail((error as? SpeechFailure)?.code ?: "tts_error")
                            }
                        }

                        override fun onPause() {
                            if (valid() && state == "playing") safePause("user")
                        }

                        override fun onStop() {
                            if (valid() &&
                                state in listOf("playing", "paused")
                            ) {
                                dispatch("stop", JSONObject().put("id", owner), {}, { fail(it) })
                            }
                        }

                        override fun onSkipToNext() {
                            if (valid() && state in listOf("playing", "paused")) nativeSeek(1)
                        }

                        override fun onSkipToPrevious() {
                            if (valid() && state in listOf("playing", "paused")) nativeSeek(-1)
                        }
                    },
                    this@SystemTtsService.owner,
                )
            }
    }

    private fun updateMedia() {
        val playback = if (state == "playing") PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED
        media?.isActive = state in listOf("playing", "paused")
        media?.setPlaybackState(
            PlaybackState
                .Builder()
                .setActions(
                    PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or PlaybackState.ACTION_STOP or
                        PlaybackState.ACTION_SKIP_TO_NEXT or
                        PlaybackState.ACTION_SKIP_TO_PREVIOUS,
                ).setState(playback, 0, if (state == "playing") 1f else 0f)
                .build(),
        )
    }

    private fun commandIntent(action: String): PendingIntent {
        val id = (staging ?: active)?.id ?: ""
        // Intent identity includes the epoch: old PendingIntents are never updated
        // into new commands by FLAG_UPDATE_CURRENT.
        val intent =
            Intent(this, SystemTtsService::class.java)
                .setAction(action)
                .setData(android.net.Uri.parse("pagewise-speech://$instance/$id/$generation/$action"))
                .putExtra("id", id)
                .putExtra("instance", instance)
                .putExtra("generation", generation)
                .putExtra("requestId", UUID.randomUUID().toString())
        return PendingIntent.getService(this, action.hashCode(), intent, PendingIntent.FLAG_IMMUTABLE)
    }

    private fun showNotification() {
        ensureMedia()
        updateMedia()
        if (Build.VERSION.SDK_INT >= 26) {
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).createNotificationChannel(
                NotificationChannel(SPEECH_CHANNEL, "知页朗读", NotificationManager.IMPORTANCE_LOW).apply { setShowBadge(false) },
            )
        }
        val open =
            PendingIntent.getActivity(
                this,
                0,
                Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
        val builder =
            NotificationCompat
                .Builder(this, SPEECH_CHANNEL)
                .setSmallIcon(android.R.drawable.ic_media_play)
                .setContentTitle(
                    if (state == "playing") {
                        "知页正在朗读"
                    } else if (state == "preparing") {
                        "正在准备离线听书"
                    } else {
                        "知页朗读已暂停"
                    },
                ).setContentText("${index.coerceAtMost(active?.offsets?.size ?: 0)} / ${active?.offsets?.size ?: 0} 句")
                .setContentIntent(open)
                .addExtras(android.os.Bundle().apply { putParcelable(android.app.Notification.EXTRA_MEDIA_SESSION, media?.sessionToken) })
                .setOngoing(true)
                .setSilent(true)
        if (state in listOf("playing", "paused")) {
            builder.addAction(
                if (state ==
                    "playing"
                ) {
                    android.R.drawable.ic_media_pause
                } else {
                    android.R.drawable.ic_media_play
                },
                if (state ==
                    "playing"
                ) {
                    "暂停"
                } else {
                    "继续"
                },
                commandIntent(if (state == "playing") "pause" else "resume"),
            )
        }
        builder.addAction(android.R.drawable.ic_menu_close_clear_cancel, "停止", commandIntent("stop"))
        val notification = builder.build()
        if (Build.VERSION.SDK_INT >=
            29
        ) {
            startForeground(SPEECH_NOTIFICATION, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
        } else {
            startForeground(SPEECH_NOTIFICATION, notification)
        }
        foreground = true
    }

    override fun onStartCommand(
        intent: Intent?,
        flags: Int,
        startId: Int,
    ): Int {
        postEvent { handleStartCommand(intent, startId) }
        return START_NOT_STICKY
    }

    private fun handleStartCommand(
        intent: Intent?,
        startId: Int,
    ): Int {
        val action = intent?.action
        if (action != null) {
            val id = intent.getStringExtra("id") ?: ""
            if (action == "host") {
                if (id == (staging ?: active)?.id && intent.getStringExtra("instance") == instance &&
                    intent.getLongExtra("generation", -1) == generation &&
                    state in listOf("playing", "paused", "preparing")
                ) {
                    if (!foreground) {
                        try {
                            showNotification()
                        } catch (error: Exception) {
                            fail("background_unavailable")
                        }
                    }
                } else if (!foreground) {
                    stopSelf(startId)
                }
                return START_NOT_STICKY
            }
            val validState =
                when (action) {
                    "pause" -> {
                        state == "playing"
                    }

                    "resume" -> {
                        state == "paused"
                    }

                    "stop" -> {
                        state in
                            listOf("playing", "paused", "preparing")
                    }

                    else -> {
                        false
                    }
                }
            if (validState && id == (staging ?: active)?.id && intent.getStringExtra("instance") == instance &&
                intent.getLongExtra("generation", -1) == generation
            ) {
                dispatch(
                    action,
                    JSONObject()
                        .put(
                            "id",
                            id,
                        ).put("instance", instance)
                        .put("generation", generation)
                        .put("requestId", intent.getStringExtra("requestId")),
                    {
                    },
                    { code -> android.util.Log.w("PagewiseSpeech", "Notification command rejected: $code") },
                )
            } else if (!foreground) {
                stopSelf(startId)
            }
            return START_NOT_STICKY
        }
        if (!foreground) stopSelf(startId)
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        closing.set(true)
        unregisterReceiver(noisy)
        // Drain accepted work without blocking Android's lifecycle thread. Late
        // engine events are fenced by closing; no final fsync races dispatch.
        owner.post {
            destroyed = true
            generation++
            owner.removeCallbacksAndMessages(null)
            try {
                if (state == "playing") {
                    state = "paused"
                    reason = "service_destroyed"
                }
                persist()
            } catch (error: Exception) {
                android.util.Log.e("PagewiseSpeech", "Final checkpoint failed", error)
            } finally {
                readyCallbacks.toList().forEach { it(false) }
                readyCallbacks.clear()
                legacyDone?.invoke("tts_stopped", index)
                legacyDone = null
                engine?.stop()
                engine?.shutdown()
                engine = null
                releasePlayback(false)
                worker.quitSafely()
            }
        }
        super.onDestroy()
    }
}
