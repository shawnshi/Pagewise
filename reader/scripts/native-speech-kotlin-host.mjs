import { join } from 'node:path'
import { writeFileSync } from 'node:fs'

// Execute the production queue/command/checkpoint methods verbatim on a JVM.
// Android AtomicFile/Os/Handler are controlled fault-injection adapters, NOT an
// Android lifecycle, Binder, audio-focus or foreground-service acceptance test.
export function generateHost(source, out, baselineSource) {
  const paths = []
  function emit(name, text) { const path = join(out, name); writeFileSync(path, text); paths.push(path) }
  function method(name, text = source) {
    const start = text.search(new RegExp(`^    (?:private )?fun ${name}\\(`, 'm'))
    if (start < 0) throw Error(`Missing production method ${name}`)
    const open = text.indexOf('{', start)
    let depth = 1, end = open + 1
    for (; depth; end++) {
      if (text[end] === '{') depth++
      if (text[end] === '}') depth--
      if (end >= text.length) throw Error(`Unclosed production method ${name}`)
    }
    return text.slice(start, end)
  }
  const queue = source.slice(source.indexOf('private const val MAX_QUEUE_BYTES'), source.indexOf('/** Single owner of TTS'))
  emit('Json.kt', `package org.json
import groovy.json.JsonSlurper
import groovy.json.JsonOutput
open class JSONObject {
    val data: MutableMap<String, Any?>
    constructor() { data = linkedMapOf() }
    constructor(text: String) { @Suppress("UNCHECKED_CAST") val parsed = JsonSlurper().parseText(text) as Map<String, Any?>; data = parsed.toMutableMap() }
    open fun put(key: String, value: Any?): JSONObject { data[key] = when(value) { is JSONObject -> value.data; is JSONArray -> value.data; else -> value }; return this }
    fun has(key: String) = data.containsKey(key)
    fun getString(key: String) = data.getValue(key) as String
    fun getInt(key: String) = (data.getValue(key) as Number).toInt()
    fun getLong(key: String) = (data.getValue(key) as Number).toLong()
    fun optString(key: String, default: String = "") = data[key] as? String ?: default
    fun optInt(key: String, default: Int = 0) = (data[key] as? Number)?.toInt() ?: default
    fun optLong(key: String, default: Long = 0) = (data[key] as? Number)?.toLong() ?: default
    fun optDouble(key: String, default: Double = 0.0) = (data[key] as? Number)?.toDouble() ?: default
    fun optBoolean(key: String, default: Boolean = false) = data[key] as? Boolean ?: default
    fun getJSONArray(key: String) = JSONArray(data.getValue(key) as List<*>)
    fun optJSONArray(key: String) = (data[key] as? List<*>)?.let { JSONArray(it) }
    override fun toString(): String = JsonOutput.toJson(data)
}
class JSONArray {
    val data: MutableList<Any?>
    constructor() { data = arrayListOf() }
    constructor(values: List<*>) { data = values.toMutableList() }
    fun put(value: Any?): JSONArray { data.add(if (value is JSONObject) value.data else value); return this }
    fun length() = data.size
    fun getInt(index: Int) = (data[index] as Number).toInt()
    fun getJSONObject(index: Int): JSONObject { @Suppress("UNCHECKED_CAST") val map = data[index] as Map<String, Any?>; return JSONObject(JsonOutput.toJson(map)) }
}
`)
  emit('Js.kt', `package app.tauri.plugin
import org.json.JSONObject
class JSObject: JSONObject() { override fun put(key: String, value: Any?): JSObject { super.put(key,value); return this } }
`)
  emit('Tts.kt', `package android.speech.tts
object TextToSpeech { fun getMaxSpeechInputLength() = 4000 }
`)
  emit('Log.kt', `package android.util
object Log { fun e(tag: String, message: String, error: Throwable): Int { System.err.println("$tag: $message: $error"); return 0 } }
class AtomicFile(val baseFile: java.io.File) {
    companion object { var failWrite = false; var stalePublish = false; var writeGate: (() -> Unit)? = null }
    fun startWrite(): java.io.FileOutputStream { writeGate?.invoke(); if(failWrite) throw java.io.IOException("injected write failure"); return java.io.FileOutputStream(java.io.File(baseFile.path+".new")) }
    fun finishWrite(out: java.io.FileOutputStream) { out.close(); if(!stalePublish) java.nio.file.Files.move(java.io.File(baseFile.path+".new").toPath(),baseFile.toPath(),java.nio.file.StandardCopyOption.REPLACE_EXISTING) }
    fun failWrite(out: java.io.FileOutputStream) { out.close(); java.io.File(baseFile.path+".new").delete() }
}
`)
  emit('Os.kt', `package android.system
object OsConstants { const val O_RDONLY = 0 }
object Os {
    var syncs = 0
    var failSync = false
    fun open(path: String, flags: Int, mode: Int) = java.io.FileDescriptor()
    fun fsync(fd: java.io.FileDescriptor) { syncs++; if(failSync) throw java.io.IOException("injected directory fsync failure") }
    fun close(fd: java.io.FileDescriptor) {}
}
`)
  const extracted = ['submit', 'moveCursor', 'persist', 'snapshot', 'dispatch', 'abortStaging', 'configure'].map(name => method(name)).join('\n')
  emit('NativeSpeechHost.kt', `package io.pagewise.reader
import java.io.File
import java.io.RandomAccessFile
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import org.json.JSONObject
import org.json.JSONArray
import app.tauri.plugin.JSObject
import android.util.AtomicFile
import android.speech.tts.TextToSpeech
${queue}
class HostHandler: AutoCloseable {
    val executor = Executors.newSingleThreadExecutor { task -> Thread(task, "PagewiseSpeechHost") }
    fun post(block: () -> Unit): Boolean { executor.execute(block); return true }
    fun postDelayed(task: Runnable, delay: Long) = Unit
    fun removeCallbacks(task: Runnable) = Unit
    override fun close() { executor.shutdown(); check(executor.awaitTermination(5, TimeUnit.SECONDS)) }
}
private class SystemTtsService(val root: File): AutoCloseable {
    val owner = HostHandler()
    val closing = AtomicBoolean(false)
    val pending = AtomicInteger(0)
    val checkpoint = AtomicFile(File(root,"checkpoint.json"))
    var checkpointUncertain = false
    var destroyed = false
    var active: SpeechQueue? = null
    var staging: SpeechQueue? = null
    private var currentRecord: JSONObject? = null
    var index = 0
    var state = "idle"
    var reason = ""
    var errorCode = ""
    var rate = 1f
    var voice = ""
    var deadline = 0L
    var stopAtSection = false
    var generation = 0L
    var sequence = 0L
    val instance = "host-instance"
    val requests = LinkedHashMap<String, String>()
    var legacyDone: ((String,Int)->Unit)? = null
    val stageTimeout = Runnable {}
    val timer = Runnable {}
    fun scheduleStageTimeout() {}
    fun scheduleTimer() {}
    fun startPlaybackHost() {}
    fun showNotification() {}
    fun releasePlayback(stop: Boolean) {}
    fun checkId(id: String) { if(id != (staging ?: active)?.id) throw SpeechFailure("session_replaced") }
    fun pause(why: String) { generation++; state = "paused"; reason = why; persist() }
    fun resume() { state = "playing"; generation++; persist() }
    fun resumeExplicit() { resume() }
    fun fail(code: String) { state = "error"; errorCode = code }
${extracted}
${method('snapshot', baselineSource).replace('fun snapshot(', 'fun baselineSnapshot(')}
    fun benchmarkSnapshots() {
        repeat(100) { baselineSnapshot(); snapshot() }
        fun sample(block: () -> Unit): List<Double> = (0 until 5).map {
            val start = System.nanoTime()
            repeat(1000) { block() }
            (System.nanoTime() - start) / 1e6
        }.sorted()
        val baseline = sample { check(baselineSnapshot().getString("text").isNotEmpty()) }
        val cached = sample { check(snapshot().getString("text").isNotEmpty()) }
        check(cached[2] < baseline[2]) { "cached status did not improve over frozen baseline" }
        println("BENCH desktop/JVM 1000 snapshots, warmup=100, samples=5, baselineMs=$baseline, cachedMs=$cached, medianSpeedup="+(baseline[2]/cached[2]))
    }
    fun command(action: String, args: JSONObject = JSONObject()): JSObject {
        val latch = CountDownLatch(1)
        var result: JSObject? = null
        var code: String? = null
        submit({false}, {code="admission_rejected";latch.countDown()}) {
            dispatch(action,args,{ result=it;latch.countDown() },{code=it;latch.countDown()})
        }
        check(latch.await(5,TimeUnit.SECONDS)) { "command timed out: $action" }
        if(code != null) throw SpeechFailure(code!!)
        return result!!
    }
    override fun close() = owner.close()
}
private fun records(vararg text: String) = JSONArray().apply { text.forEachIndexed { i, value -> put(JSONObject().put("key", "$i:0:0").put("text", value)) } }
private fun expect(code: String, block: () -> Unit) { try { block(); error("expected $code") } catch(error: SpeechFailure) { check(error.code == code) { "expected $code, got "+error.code } } }
private fun prepare(service: SystemTtsService, vararg text: String): String {
    val id = service.command("begin", JSONObject().put("owner","synthetic").put("sourceVersion","v1").put("expectedUnits",1)).getString("id")
    service.command("append",JSONObject().put("id",id).put("items",records(*text)).put("coverage",JSONArray().put(0)))
    return id
}
fun main(args: Array<String>) {
    val root = File(args[0], UUID.randomUUID().toString()).apply { mkdirs() }
    val service = SystemTtsService(root)
    try {
        val id = prepare(service,"synthetic first","synthetic boundary")
        val incomplete = JSONObject().put("id",id).put("count",3).put("autoplay",false)
        expect("coverage_incomplete") { service.command("commit",incomplete) }
        val commitArgs = JSONObject().put("id",id).put("count",2).put("autoplay",false).put("requestId","commit-1")
        val committed = service.command("commit",commitArgs)
        check(service.command("commit",commitArgs).optLong("generation") == committed.optLong("generation"))
        service.command("seek",JSONObject().put("id",id).put("delta",1))
        service.benchmarkSnapshots()
        check(committed.optString("state") == "paused")
        check(File(root,"checkpoint.json").isFile && android.system.Os.syncs > 0)
        val queue = service.active!!
        check(queue.digest == queue.hash())
        val restored = SpeechQueue(queue.id,queue.owner,queue.file,"v1",1)
        restored.rebuild(); check(restored.hash() == queue.digest && restored.read(0).getString("text") == "synthetic first")
        println("PASS coverage, durable commit, paused recovery, queue hash/rebuild")
        val moved = File(root,"hidden.bin")
        check(queue.file.renameTo(moved))
        val start = System.nanoTime()
        repeat(1000) { check(service.command("status").getString("text") == "synthetic boundary") }
        println("PASS 1000 cached status calls with queue unavailable: "+((System.nanoTime()-start)/1e6)+"ms")
        check(moved.renameTo(queue.file))
        expect("stale_generation") { service.command("pause",JSONObject().put("id",id).put("generation",-1)) }
        expect("instance_replaced") { service.command("status",JSONObject().put("instance","stale")) }
        expect("request_conflict") { service.command("status",JSONObject().put("requestId","commit-1")) }
        println("PASS stale generation/instance and request-id conflict rejection")
        val next = prepare(service,"synthetic second")
        AtomicFile.stalePublish = true
        expect("io_error") { service.command("commit",JSONObject().put("id",next).put("autoplay",false)) }
        AtomicFile.stalePublish = false
        check(service.active!!.id == id && File(root,"$id.bin").isFile && File(root,"$next.bin").isFile)
        check(service.checkpointUncertain)
        service.command("discard",JSONObject().put("id",next))
        check(File(root,"$next.bin").isFile)
        println("PASS failed atomic publication rejects ACK, rolls back cursor and retains both recovery queues")
        val third = prepare(service,"synthetic third")
        android.system.Os.failSync = true
        expect("io_error") { service.command("commit",JSONObject().put("id",third).put("autoplay",false)) }
        android.system.Os.failSync = false
        check(service.active!!.id == id && File(root,"$id.bin").isFile && File(root,"$third.bin").isFile)
        println("PASS directory fsync failure rejects ACK and retains prior queue")
        val gateEntered = CountDownLatch(1)
        val gateRelease = CountDownLatch(1)
        AtomicFile.writeGate = { gateEntered.countDown(); check(gateRelease.await(5,TimeUnit.SECONDS)) }
        val done = CountDownLatch(1)
        service.submit({false},{error("unexpected reject")}) { service.dispatch("commit",JSONObject().put("id",third).put("autoplay",false),{done.countDown()},{error(it)}) }
        check(gateEntered.await(5,TimeUnit.SECONDS))
        check(done.count == 1L) { "ACK happened before durable publication" }
        val cancelled = AtomicBoolean(false)
        val rejected = CountDownLatch(1)
        service.submit({cancelled.get()},{rejected.countDown()}) { error("cancelled queued command mutated state") }
        cancelled.set(true)
        val overflow = AtomicInteger(0)
        repeat(80) { service.submit({true},{overflow.incrementAndGet()}) { error("cancelled admission ran") } }
        check(overflow.get() > 0)
        AtomicFile.writeGate = null
        gateRelease.countDown()
        check(done.await(5,TimeUnit.SECONDS) && rejected.await(5,TimeUnit.SECONDS))
        check(service.command("status").getString("id") == third)
        println("PASS delayed durability has no early ACK; bounded admission and timed-out queued work cannot execute")
        val invalid = prepare(service,"valid")
        expect("invalid_sentence") { service.command("append",JSONObject().put("id",invalid).put("items",records("duplicate key"))) }
        val corrupt = File(root,"corrupt.bin").apply { writeBytes(byteArrayOf(0,0,0,5,1)) }
        expect("queue_corrupt") { SpeechQueue(UUID.randomUUID().toString(),"synthetic",corrupt).rebuild() }
        println("PASS duplicate keys and truncated recovery records are explicit errors")
    } finally { AtomicFile.writeGate=null; AtomicFile.stalePublish=false; android.system.Os.failSync=false; service.close() }
    println("HOST_OK: production queue/persist/dispatch/submit methods; synthetic files only: "+root)
}
`)
  return paths
}
