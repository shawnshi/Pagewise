import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve, delimiter } from 'node:path'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { jsonAdapter, toolchain, uploadOwnershipSource } from './native-import-test-tools.mjs'

// Execute the actual file-job owner and Service methods with controlled Android adapters.
// This is not a device/provider/foreground-service permission acceptance test.
test('production Kotlin file jobs: durable admission, independent lanes, detach, cancel, timeout, late results and restart', { timeout: 100000 }, () => {
  const root = resolve(import.meta.dirname, '..'), out = resolve(root, '../.cache/native-boundaries-20261021/file-jobs-host')
  mkdirSync(out, { recursive: true })
  const sources = []
  const emit = (name, text) => { const path = join(out, name); writeFileSync(path, text); sources.push(path) }
  emit('ImportUploads.kt', uploadOwnershipSource())
  emit('Json.kt', jsonAdapter())
  emit('Js.kt', `package app.tauri.plugin
import org.json.JSONObject
class JSObject : JSONObject {
  constructor() : super()
  constructor(text: String) : super(text)
  override fun put(key: String, value: Any?): JSObject { super.put(key,value); return this }
}
`)
  emit('Context.kt', `package android.content
import java.io.File
object HostContext { lateinit var root: File; var deny = false; var starts = 0 }
class ComponentName
class Intent(context: Context, cls: Class<*>) {
  private val extras = mutableMapOf<String,String>()
  fun putExtra(key: String,value: String): Intent { extras[key]=value; return this }
  fun getStringExtra(key: String): String? = extras[key]
}
open class Context {
  open val applicationContext: Context get() = this
  val filesDir get() = File(HostContext.root,"files").apply { mkdirs() }
  val cacheDir get() = File(HostContext.root,"cache").apply { mkdirs() }
  fun startService(intent: Intent): ComponentName? { if(HostContext.deny) throw IllegalStateException("background start denied"); HostContext.starts++; return ComponentName() }
  fun startForegroundService(intent: Intent) = startService(intent)
  fun getSystemService(name: String): Any = android.app.NotificationManager()
  companion object { const val NOTIFICATION_SERVICE="notifications" }
}
`)
  emit('App.kt', `package android.app
import android.content.Context
import android.content.Intent
import android.os.IBinder
open class Service : Context() {
  open fun onBind(intent: Intent?): IBinder? = null
  open fun onStartCommand(intent: Intent?,flags: Int,startId: Int) = 2
  open fun onDestroy() {}
  open fun onTimeout(startId: Int,fgsType: Int) {}
  fun startForeground(id: Int, notification: Any) {}
  fun stopForeground(flags: Int) {}
  fun stopSelfResult(id: Int) = true
  fun stopSelf() {}
  companion object { const val START_NOT_STICKY=2; const val STOP_FOREGROUND_REMOVE=1 }
}
class NotificationChannel(id: String,name: String,importance: Int)
class NotificationManager { fun createNotificationChannel(channel: NotificationChannel) {}; companion object { const val IMPORTANCE_LOW=2 } }
`)
  emit('Os.kt', `package android.os
import java.util.concurrent.*
class IBinder
object Build { object VERSION { const val SDK_INT=36 } }
class CancellationSignal { @Volatile var isCanceled=false; fun cancel() { isCanceled=true }; fun throwIfCanceled() { if(isCanceled) throw IllegalStateException("cancelled") } }
object SystemClock { fun elapsedRealtime() = System.nanoTime()/1000000 }
class Looper { companion object { fun getMainLooper() = Looper() } }
class Handler(looper: Looper) {
  fun post(task: Runnable): Boolean { task.run(); return true }
  fun postDelayed(task: Runnable, delay: Long): Boolean { timers.add(task); return true }
  fun removeCallbacks(task: Runnable) { timers.remove(task) }
  companion object { val timers=CopyOnWriteArrayList<Runnable>(); fun expire() { timers.toList().forEach { it.run() } } }
}
`)
  emit('Atomic.kt', `package android.util
import java.io.*
import java.nio.file.*
object Log { fun e(tag: String,message: String,error: Throwable)=0 }
class AtomicFile(val baseFile: File) {
  companion object { var fail=false }
  fun openRead(): FileInputStream { val bak=File(baseFile.path+".bak"); if(bak.exists()) { Files.move(bak.toPath(),baseFile.toPath(),StandardCopyOption.REPLACE_EXISTING) }; return FileInputStream(baseFile) }
  fun startWrite(): FileOutputStream { if(fail) throw IOException("injected receipt write failure"); return FileOutputStream(File(baseFile.path+".new")) }
  fun finishWrite(out: FileOutputStream) { out.close(); Files.move(File(baseFile.path+".new").toPath(),baseFile.toPath(),StandardCopyOption.REPLACE_EXISTING) }
  fun failWrite(out: FileOutputStream) { out.close(); File(baseFile.path+".new").delete() }
  fun delete() { baseFile.delete(); File(baseFile.path+".bak").delete(); File(baseFile.path+".new").delete() }
}
`)
  emit('Notification.kt', `package androidx.core.app
import android.content.Context
object NotificationCompat { class Builder(context: Context,id: String) {
  fun setSmallIcon(id: Int)=this; fun setContentTitle(s: String)=this; fun setContentText(s: String)=this
  fun setOngoing(v: Boolean)=this; fun setSilent(v: Boolean)=this; fun build()=Any()
} }
`)
  emit('R.kt', `package android
object R { object drawable { const val stat_sys_download=1 } }
`)
  emit('Io.kt', `package io.pagewise.reader
import android.content.Context
import android.os.CancellationSignal
import app.tauri.plugin.JSObject
import java.io.File
import java.util.concurrent.CountDownLatch
object HostIo {
  @Volatile var gate: CountDownLatch?=null
  @Volatile var entered=CountDownLatch(1)
  @Volatile var ignoreCancel=false
  @Volatile var fail=false
  @Volatile var granted=true
  @Volatile var padding=0
  var reads=0
}
class MonitoredFolderIo(val context: Context) {
  class Failure(val code: String): java.io.IOException(code)
  data class Stored(val id:String)
  fun stored()=Stored("saf-fixture")
  fun validId(id: String)=id.isNotEmpty()
  fun authorized(id: String) { if(!HostIo.granted) throw Failure("permission_denied"); if(id!="saf-fixture") throw Failure("invalid_reference") }
  fun code(error: Exception)=if(error is Failure) error.code else "io_error"
  fun discard(result: JSObject?) { val path=result?.optString("path") ?: return; if(path.startsWith("cache/pagewise-read/")) File(context.cacheDir,"pagewise-read/"+path.substringAfterLast('/')).delete() }
  fun list(id: String,signal: CancellationSignal,deadline: Long): JSObject { authorized(id); signal.throwIfCanceled(); return JSObject().put("files",emptyList<String>()).put("complete",true).put("errors",emptyList<String>()).put("padding","x".repeat(HostIo.padding)) }
  fun read(id: String,document: String,signal: CancellationSignal,deadline: Long): JSObject {
    authorized(id); HostIo.reads++; HostIo.entered.countDown()
    while(HostIo.gate?.count==1L) { if(!HostIo.ignoreCancel) signal.throwIfCanceled(); Thread.sleep(5) }
    if(HostIo.fail) throw Failure("io_error")
    val file=File(context.cacheDir,"pagewise-read/12345678-1234-1234-1234-123456789abc.bin");file.parentFile.mkdirs();file.writeText("SYNTHETIC")
    return JSObject().put("path","cache/pagewise-read/"+file.name)
  }
}
`)
  emit('ImportBoundary.kt', `package io.pagewise.reader
import android.content.Context
import org.json.JSONObject
import app.tauri.plugin.JSObject
internal interface NativeImportControl {
 fun checkpoint(); fun commit(action:()->Unit); fun progress(result:JSONObject)
}
internal class NativeImportFailure(val code:String):java.io.IOException(code)
internal class NativeImportDatabase {
 companion object { fun progress(context:Context,id:String,expectedHash:String?=null):JSONObject?=null }
}
internal class NativeBookImporter(context:Context) {
 fun index(id:String,folderId:String,request:JSONObject,cancellation:android.os.CancellationSignal,deadline:Long,control:NativeImportControl):JSObject=error("not an import test")
 fun import(id:String,request:JSONObject,control:NativeImportControl):JSObject=error("not an import test")
 fun inspect(folderId:String,documentId:String,fileName:String,cancellation:android.os.CancellationSignal,deadline:Long,control:NativeImportControl):JSObject=error("not an import test")
 companion object {
  const val MAX_ITEMS=128
  fun requestFingerprint(kind:String,folderId:String,request:JSONObject)=kind+":"+folderId+":"+request.toString()
  fun code(error:Exception)=if(error is NativeImportFailure) error.code else "io_error"
 }
}
`)
  emit('NativeFileJobsHost.kt', `package io.pagewise.reader
import android.content.*
import android.os.Handler
import android.util.AtomicFile
import org.json.JSONObject
import java.io.File
import java.util.UUID
import java.util.concurrent.*
fun main(args: Array<String>) {
  HostContext.root=File(args[0]).apply { mkdirs() }
  val context=Context()
  val service=NativeFileJobService()
  fun command(action: String,id: String,kind: String="read"): app.tauri.plugin.JSObject {
    val payload=JSONObject().put("id",id)
    if(action=="start") payload.put("kind",kind).put("folderId","saf-fixture").put("documentId",if(kind=="read") "synthetic.pdf" else "")
    return NativeFileJobs.command(context,JSONObject().put("action",action).put("payload",payload))
  }
  fun start(id: String) { service.onStartCommand(Intent(context,NativeFileJobService::class.java).putExtra("jobId",id),0,HostContext.starts) }
  fun state(id: String)=command("status",id).getString("state")
  fun settled(id: String): String { repeat(400) { val s=state(id); if(s!in setOf("queued","running")) return s; Thread.sleep(5) }; error("job did not settle") }
  fun resetRead() { HostIo.gate=CountDownLatch(1);HostIo.entered=CountDownLatch(1);HostIo.ignoreCancel=false;HostIo.fail=false }
  fun uuid()=UUID.randomUUID().toString()
  fun physicalIdle() {
    val f=NativeFileJobs::class.java.getDeclaredField("physicalWorkers").apply { isAccessible=true }
    repeat(400) { if(synchronized(NativeFileJobs) { (f.get(null) as Map<*,*>).isEmpty() }) return;Thread.sleep(5) };error("physical worker not released")
  }
  fun restartLedger() {
    NativeFileJobs::class.java.getDeclaredField("root").apply { isAccessible=true }.set(null,null)
    val field=NativeFileJobs::class.java.getDeclaredField("jobs").apply { isAccessible=true }
    (field.get(null) as MutableMap<*,*>).clear()
  }
  try {
    resetRead(); val read=uuid();check(command("start",read).getString("state")=="queued");start(read)
    check(HostIo.entered.await(1,TimeUnit.SECONDS));check(state(read)=="running")
    val starts=HostContext.starts;command("start",read);check(HostContext.starts==starts && HostIo.reads==1)
    try { command("start",uuid());error("unbounded read admission") } catch(e: MonitoredFolderIo.Failure) { check(e.code=="busy") }
    val list=uuid();command("start",list,"list");start(list);check(settled(list)=="succeeded");command("ack",list)
    check(state(read)=="running");HostIo.gate!!.countDown();check(settled(read)=="succeeded")
    check(command("status",read).has("result"))
    HostIo.granted=false
    try { command("status",read);error("result returned after revocation") } catch(e: MonitoredFolderIo.Failure) { check(e.code=="permission_denied") }
    check(!command("cancel",read).has("result"));command("ack",read);command("ack",read);HostIo.granted=true
    check(!File(context.cacheDir,"pagewise-read/12345678-1234-1234-1234-123456789abc.bin").exists())
    println("PASS durable admission/idempotence, independent list/read, native completion without WebView, ACK cleanup")

    resetRead();HostIo.ignoreCancel=true;val cancel=uuid();command("start",cancel);start(cancel);check(HostIo.entered.await(1,TimeUnit.SECONDS))
    command("cancel",cancel);check(state(cancel)=="cancelled");check(!command("status",cancel).has("result"))
    try { command("start",uuid());error("cancelled but blocked worker freed its physical slot") } catch(e: MonitoredFolderIo.Failure) { check(e.code=="busy") }
    HostIo.gate!!.countDown();physicalIdle();command("ack",cancel)
    resetRead();HostIo.ignoreCancel=true;val timeout=uuid();command("start",timeout);start(timeout);check(HostIo.entered.await(1,TimeUnit.SECONDS));Handler.expire()
    check(state(timeout)=="failed");check(command("status",timeout).getString("code")=="timeout")
    try { command("start",uuid());error("timed-out blocking worker freed its physical slot") } catch(e: MonitoredFolderIo.Failure) { check(e.code=="busy") }
    HostIo.gate!!.countDown();physicalIdle();command("ack",timeout)
    println("PASS cancellation/timeout never publish late temp files or false success")

    resetRead();HostIo.ignoreCancel=true;val interrupted=uuid();command("start",interrupted);start(interrupted);check(HostIo.entered.await(1,TimeUnit.SECONDS))
    val incoming=uuid();command("start",incoming,"list");service.onDestroy()
    check(state(interrupted)=="interrupted");check(state(incoming)=="queued") { "old service cannot interrupt a not-yet-delivered new start" }
    HostIo.gate!!.countDown();physicalIdle();check(!command("status",interrupted).has("result"));command("ack",interrupted)
    NativeFileJobService().onStartCommand(Intent(context,NativeFileJobService::class.java).putExtra("jobId",incoming),0,HostContext.starts)
    check(settled(incoming)=="succeeded");command("ack",incoming)
    HostContext.deny=true;val denied=uuid();check(command("start",denied).getString("code")=="background_start_denied");HostContext.deny=false;command("ack",denied)
    HostIo.fail=true;HostIo.gate=null;val failed=uuid();command("start",failed);start(failed);check(settled(failed)=="failed");check(command("status",failed).getString("code")=="io_error");command("ack",failed);HostIo.fail=false
    println("PASS service teardown, background-start denial and provider errors stay explicit")

    val queued=uuid();command("start",queued);val disk=File(context.filesDir,"native-file-jobs/$queued.json");check(disk.exists());restartLedger()
    check(state(queued)=="interrupted");check(JSONObject(disk.readText()).getString("state")=="interrupted");command("ack",queued)
    val backup=uuid();command("start",backup);val base=File(context.filesDir,"native-file-jobs/$backup.json");check(base.renameTo(File(base.path+".bak")));restartLedger();check(state(backup)=="interrupted");command("ack",backup)
    AtomicFile.fail=true;try { command("start",uuid());error("receipt write failure accepted") } catch(e: java.io.IOException) {};AtomicFile.fail=false
    HostIo.granted=false;try { command("start",uuid());error("revoked permission accepted") } catch(e: MonitoredFolderIo.Failure) { check(e.code=="permission_denied") };HostIo.granted=true
    println("PASS process-restart interruption, backup-only AtomicFile recovery, receipt failure and revoked authorization")
    HostIo.padding=8*1024*1024-100;val oversized=uuid();command("start",oversized,"list");start(oversized);check(settled(oversized)=="failed");physicalIdle()
    check(command("status",oversized).getString("code")=="resource_limit");restartLedger();check(state(oversized)=="failed");command("ack",oversized)
    HostIo.padding=8*1024*1024-1024;val near=uuid();command("start",near,"list");start(near);check(settled(near)=="succeeded");physicalIdle();restartLedger();check(state(near)=="succeeded");command("ack",near)
    println("PASS full-envelope byte limit matches restart decoding; near-limit results survive restore")
    println("HOST_PASS")
  } finally {
    HostIo.gate?.countDown()
    for(name in listOf("executor","cancellationExecutor")) { val f=NativeFileJobs::class.java.getDeclaredField(name).apply { isAccessible=true };(f.get(null) as ThreadPoolExecutor).shutdownNow() }
  }
}
`)
  const files = (dir, suffix) => existsSync(dir) ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter(e => e.isFile() && e.name.endsWith(suffix)).map(e => join(e.parentPath, e.name)) : []
  const tools = toolchain(), compiler = tools.compiler, kotlin = [tools.stdlib]
  const groovy = files(join(homedir(), '.gradle/wrapper/dists'), '.jar').filter(p => /groovy-(json-)?3\.0\.\d+\.jar$/.test(p))
  assert.ok(groovy.some(p => /groovy-json-/.test(p)), 'uses installed JSON adapter; no dependency installation')
  const classpath = [...kotlin, ...groovy].join(delimiter), classes = join(out, 'classes')
  const compile = spawnSync('java', ['-cp', [...compiler, ...kotlin].join(delimiter), 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-classpath', classpath, '-d', classes, ...sources, join(root, 'src-tauri/android/NativeFileJobs.kt')], { encoding: 'utf8', timeout: 70000 })
  writeFileSync(join(out, 'compile.log'), (compile.stdout ?? '') + (compile.stderr ?? ''))
  assert.equal(compile.status, 0, compile.error?.message ?? compile.stdout + compile.stderr)
  const synthetic = join(out, `synthetic-${crypto.randomUUID()}`)
  const run = spawnSync('java', ['-cp', [classes, ...kotlin, ...groovy].join(delimiter), 'io.pagewise.reader.NativeFileJobsHostKt', synthetic], { encoding: 'utf8', timeout: 25000 })
  writeFileSync(join(out, 'run.log'), (run.stdout ?? '') + (run.stderr ?? ''))
  assert.equal(run.status, 0, run.error?.message ?? run.stdout + run.stderr)
  assert.match(run.stdout, /HOST_PASS/)
  console.log(run.stdout)
})
