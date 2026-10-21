import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { zipSync, strToU8 } from 'fflate'
import { root, artifact, compile, runJvm, emit, groovy, jsonAdapter, uploadOwnershipSource } from './native-import-test-tools.mjs'

// The production owner, importer, parser and SQL repository execute verbatim.
// Only Android/provider/bitmap bindings are controlled; SQL executes in a persistent real SQLite process.
test('native batch end-to-end: actual SQLite, metadata, publication, partial failures, rollback, unknown commit and cancellation fencing', { timeout: 120000 }, () => {
  const out = resolve(root, '../.cache/native-import-20261021/import-host'), fixture = join(out, `synthetic-${crypto.randomUUID()}`)
  mkdirSync(join(fixture, 'data'), { recursive: true }); mkdirSync(join(fixture, 'sources'), { recursive: true })
  const source = readFileSync(join(root, 'src/storage/tauri.ts'), 'utf8')
  const start = source.indexOf('CREATE TABLE IF NOT EXISTS books')
  const schema = source.slice(start, source.indexOf('`)', start))
  const db = new DatabaseSync(join(fixture, 'data/lightread.db'))
  db.exec(schema)
  const migrations = [...source.matchAll(/"(ALTER TABLE books[^"\r\n]+)"/g), ...source.matchAll(/'(ALTER TABLE books[^'\r\n]+)'/g)].map(m => m[1])
  for (const sql of migrations) if (!db.prepare('PRAGMA table_info(books)').all().some(column => column.name === sql.split(' ')[5])) db.exec(sql)
  db.exec("INSERT INTO books(id,title,author,format,file_name,tags,classification,added_at,reading_seconds,source_ref,file_availability) VALUES('existing','Manual title','User author','epub','old.epub','[\"manual\"]','{\"revision\":7}',1,180,'{\"folderId\":\"saf-fixture\",\"documentId\":\"existing-doc\",\"relativePath\":\"old.epub\",\"version\":\"[1,1]\"}','available'); INSERT INTO annotations(id,book_id,cfi,text,created_at) VALUES('note','existing','locator','KEEP NOTE',1)")
  db.close()
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
  writeFileSync(join(fixture, 'sources/new.epub'), zipSync({
    'META-INF/container.xml': strToU8('<container><rootfile full-path="OPS/content.opf"/></container>'),
    'OPS/content.opf': strToU8('<package xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Native synthetic title</dc:title><dc:creator>Native author</dc:creator><dc:subject>topic</dc:subject><dc:date>2020</dc:date></metadata><manifest><item id="c" href="cover.png" properties="cover-image"/></manifest></package>'),
    'OPS/cover.png': png,
  }))
  writeFileSync(join(fixture, 'sources/bad.epub'), 'not an EPUB')
  writeFileSync(join(fixture, 'sources/one.txt'), 'BODY STAYS NATIVE')
  writeFileSync(join(fixture, 'sources/two.txt'), 'SECOND BODY STAYS NATIVE')
  writeFileSync(join(fixture, 'sources/UPPER.TXT'), 'UPPERCASE BODY')
  writeFileSync(join(fixture, 'sources/UPPER.EPUB'), readFileSync(join(fixture, 'sources/new.epub')))
  const py = emit(out, 'sqlite-host.py', `import json,sqlite3,sys
path,flags=sys.argv[1],int(sys.argv[2])
conn=sqlite3.connect('file:'+path+'?mode=ro',uri=True,isolation_level=None,timeout=5) if flags&1 else sqlite3.connect(path,isolation_level=None,timeout=5)
conn.row_factory=sqlite3.Row
if not flags&1: conn.execute('PRAGMA journal_mode=WAL')
for line in sys.stdin:
 try:
  req=json.loads(line);sql=req['sql'];args=req.get('args',[])
  cursor=conn.execute(sql,args)
  if req['op']=='query': result={'columns':[d[0] for d in cursor.description],'rows':[list(r) for r in cursor.fetchall()]}
  else: result={}
  print(json.dumps(result,ensure_ascii=True),flush=True)
 except Exception as error: print(json.dumps({'error':type(error).__name__+': '+str(error)}),flush=True)
conn.close()
`)
  const sources = []
  const put = (name, text) => sources.push(emit(out, name, text))
  put('ImportUploads.kt', uploadOwnershipSource())
  put('NativeCommitProbe.kt', 'package io.pagewise.reader\ninternal object NativeCommitProbe { @Volatile var beforeSettlement:(()->Unit)?=null }\n')
  put('Json.kt', jsonAdapter())
  put('Js.kt', `package app.tauri.plugin
import org.json.JSONObject
class JSObject:JSONObject {constructor():super();constructor(text:String):super(text);override fun put(k:String,v:Any?):JSObject{super.put(k,v);return this}}
`)
  put('Context.kt', `package android.content
import java.io.File
object Host {lateinit var root:File;var starts=0}
class ComponentName
class Intent(context:Context,cls:Class<*>){val args=mutableMapOf<String,String>();fun putExtra(k:String,v:String):Intent{args[k]=v;return this};fun getStringExtra(k:String)=args[k]}
open class Context {
 open val applicationContext:Context get()=this
 val dataDir get()=File(Host.root,"data")
 val filesDir get()=File(dataDir,"files").apply{mkdirs()}
 val cacheDir get()=File(dataDir,"cache").apply{mkdirs()}
 fun startService(intent:Intent):ComponentName?{Host.starts++;return ComponentName()}
 fun startForegroundService(intent:Intent)=startService(intent)
 fun getSystemService(name:String):Any=android.app.NotificationManager()
 companion object {const val NOTIFICATION_SERVICE="notifications"}
}
`)
  put('App.kt', `package android.app
import android.content.*
import android.os.IBinder
open class Service:Context(){
 open fun onBind(i:Intent?):IBinder?=null;open fun onStartCommand(i:Intent?,f:Int,s:Int)=2
 open fun onTimeout(s:Int,t:Int){};open fun onDestroy(){}
 fun startForeground(i:Int,n:Any){};fun stopSelfResult(i:Int)=true;fun stopSelf(){};fun stopForeground(f:Int){}
 companion object{const val START_NOT_STICKY=2;const val STOP_FOREGROUND_REMOVE=1}
}
class NotificationChannel(i:String,n:String,p:Int)
class NotificationManager{fun createNotificationChannel(c:NotificationChannel){};companion object{const val IMPORTANCE_LOW=2}}
`)
  put('Os.kt', `package android.os
class IBinder
class OperationCanceledException:RuntimeException()
class CancellationSignal{@Volatile var isCanceled=false;fun cancel(){isCanceled=true};fun throwIfCanceled(){if(isCanceled)throw OperationCanceledException()}}
object Build{object VERSION{const val SDK_INT=36}}
object SystemClock{fun elapsedRealtime()=System.nanoTime()/1000000}
class Looper{companion object{fun getMainLooper()=Looper()}}
class Handler(looper:Looper){
 fun post(r:Runnable):Boolean{r.run();return true}
 fun postDelayed(r:Runnable,ms:Long):Boolean{timers.add(r);return true}
 fun removeCallbacks(r:Runnable){timers.remove(r)}
 companion object{val timers=java.util.concurrent.CopyOnWriteArrayList<Runnable>()}
}
`)
  put('Atomic.kt', `package android.util
import java.io.*
import java.nio.file.*
object Log{fun e(t:String,m:String,e:Throwable):Int{System.err.println(t+": "+m+": "+e);return 0}}
class AtomicFile(val baseFile:File){
 fun openRead():FileInputStream{val b=File(baseFile.path+".bak");if(b.exists())Files.move(b.toPath(),baseFile.toPath(),StandardCopyOption.REPLACE_EXISTING);return FileInputStream(baseFile)}
 fun startWrite()=FileOutputStream(File(baseFile.path+".new"))
 fun finishWrite(s:FileOutputStream){s.fd.sync();s.close();Files.move(File(baseFile.path+".new").toPath(),baseFile.toPath(),StandardCopyOption.REPLACE_EXISTING)}
 fun failWrite(s:FileOutputStream){s.close();File(baseFile.path+".new").delete()}
 fun delete(){baseFile.delete();File(baseFile.path+".new").delete();File(baseFile.path+".bak").delete()}
}
`)
  put('Rename.kt', `package android.system
object Os{fun rename(from:String,to:String){java.nio.file.Files.move(java.io.File(from).toPath(),java.io.File(to).toPath(),java.nio.file.StandardCopyOption.REPLACE_EXISTING)}}
`)
  put('Notification.kt', `package androidx.core.app
import android.content.Context
object NotificationCompat{class Builder(c:Context,i:String){fun setSmallIcon(i:Int)=this;fun setContentTitle(s:String)=this;fun setContentText(s:String)=this;fun setOngoing(v:Boolean)=this;fun setSilent(v:Boolean)=this;fun build()=Any()}}
`)
  put('R.kt', 'package android\nobject R{object drawable{const val stat_sys_download=1}}\n')
  put('Cursor.kt', `package android.database
import java.io.Closeable
class Cursor(val columnNames:Array<String>,val rows:List<List<Any?>>):Closeable{
 private var at=-1
 fun moveToNext():Boolean{at++;return at<rows.size};fun moveToFirst():Boolean{at=0;return rows.isNotEmpty()}
 fun isNull(i:Int)=rows[at][i]==null;fun getString(i:Int)=rows[at][i].toString();override fun close(){}
}
`)
  put('SQLite.kt', `package android.database.sqlite
import android.database.Cursor
import org.json.JSONObject
import org.json.JSONArray
import java.io.*
import java.util.concurrent.CountDownLatch
class SQLiteException(message:String):RuntimeException(message)
object HostSql{
 lateinit var script:String
 @Volatile var failRecord=false
 @Volatile var failRecordAfter=0
 @Volatile var bookRecords=0
 @Volatile var failCommitAfter=false
 @Volatile var commitGate:CountDownLatch?=null
 @Volatile var entered=CountDownLatch(1)
}
class SQLiteDatabase private constructor(path:String,flags:Int):Closeable{
 private val process=ProcessBuilder("python","-u",HostSql.script,path,flags.toString()).apply{environment()["PYTHONUTF8"]="1"}.start()
 private val writer=process.outputStream.bufferedWriter(Charsets.UTF_8)
 private val reader=process.inputStream.bufferedReader(Charsets.UTF_8)
 private var success=false
 private var writesBook=false
 private fun send(sql:String,args:List<Any?> = emptyList(),query:Boolean=false):JSONObject{
  writer.write(JSONObject().put("op",if(query)"query" else "exec").put("sql",sql).put("args",JSONArray(args)).toString());writer.newLine();writer.flush()
  val text=reader.readLine()?:throw SQLiteException("SQLite oracle EOF: "+process.errorStream.bufferedReader().readText())
  val result=JSONObject(text);if(result.has("error"))throw SQLiteException(result.getString("error"));return result
 }
 fun rawQuery(sql:String,args:Array<String>?):Cursor{
  val r=send(sql,args?.toList()?:emptyList(),true)
  val columns=r.getJSONArray("columns").data.map{it.toString()}.toTypedArray()
  @Suppress("UNCHECKED_CAST") val rows=r.getJSONArray("rows").data as List<List<Any?>>
  return Cursor(columns,rows)
 }
 fun execSQL(sql:String){execSQL(sql,emptyArray())}
 fun execSQL(sql:String,args:Array<out Any?>){
  if(sql.startsWith("UPDATE native_import_batches")){
   if(writesBook)HostSql.bookRecords++
   if(HostSql.failRecord || (writesBook && HostSql.failRecordAfter>0 && HostSql.bookRecords==HostSql.failRecordAfter))throw SQLiteException("injected receipt update failure")
  }
  if(sql.trimStart().startsWith("INSERT INTO books"))writesBook=true
  send(sql,args.toList())
 }
 fun beginTransactionNonExclusive(){success=false;writesBook=false;send("BEGIN IMMEDIATE")}
 fun setTransactionSuccessful(){success=true}
 fun endTransaction(){
  val gate=HostSql.commitGate
  if(success && writesBook && gate!=null){HostSql.entered.countDown();gate.await()}
  send(if(success)"COMMIT" else "ROLLBACK")
  if(success && writesBook && HostSql.failCommitAfter){HostSql.failCommitAfter=false;throw SQLiteException("injected lost commit acknowledgement")}
 }
 override fun close(){writer.close();process.waitFor(3,java.util.concurrent.TimeUnit.SECONDS);if(process.isAlive)process.destroyForcibly()}
 companion object{
  const val OPEN_READONLY=1;const val OPEN_READWRITE=0;const val NO_LOCALIZED_COLLATORS=16;const val ENABLE_WRITE_AHEAD_LOGGING=0x20000000
  fun openDatabase(path:String,factory:Any?,flags:Int)=SQLiteDatabase(path,flags)
 }
}
`)
  put('Provider.kt', `package io.pagewise.reader
import android.content.Context
import android.os.CancellationSignal
import app.tauri.plugin.JSObject
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID
object Source{
 data class Document(val id:String,val name:String,val file:File,val modified:Long=2)
 var documents=listOf<Document>();var granted=true;var complete=true;var reads=0
}
class MonitoredFolderIo(val context:Context){
 class Failure(val code:String):java.io.IOException(code)
 data class Folder(val id:String="saf-fixture",val label:String="Synthetic folder")
 fun stored()=Folder();fun granted(f:Folder)=Source.granted;fun validId(id:String)=id.isNotEmpty()
 fun authorized(id:String):Folder{if(id!="saf-fixture")throw Failure("invalid_reference");if(!Source.granted)throw Failure("permission_denied");return Folder()}
 fun code(e:Exception)=if(e is Failure)e.code else "io_error"
 fun discard(r:JSObject?){val path=r?.optString("path")?:return;if(path.startsWith("cache/pagewise-read/"))File(context.dataDir,path).delete()}
 fun list(id:String,c:CancellationSignal,deadline:Long):JSObject{
  authorized(id);c.throwIfCanceled();val files=JSONArray()
  for(d in Source.documents)files.put(JSONObject().put("documentId",d.id).put("name",d.name).put("relativePath",d.name).put("size",d.file.length()).put("modifiedAt",d.modified))
  val errors=JSONArray();if(!Source.complete)errors.put(JSONObject().put("code","provider_loading"))
  return JSObject().put("files",files).put("complete",Source.complete).put("errors",errors)
 }
 fun read(folder:String,id:String,c:CancellationSignal,deadline:Long):JSObject{
  authorized(folder);c.throwIfCanceled();Source.reads++
  val d=Source.documents.find{it.id==id}?:throw Failure("not_found")
  val out=File(context.cacheDir,"pagewise-read/"+UUID.randomUUID()+".bin");out.parentFile.mkdirs()
  d.file.inputStream().use{input->out.outputStream().use{output->val b=ByteArray(65536);while(true){c.throwIfCanceled();val n=input.read(b);if(n<0)break;output.write(b,0,n)}}}
  return JSObject().put("path","cache/pagewise-read/"+out.name)
 }
}
// Android/JNI/Bitmap are deliberately not simulated as a successful PDF parser.
internal object NativePdfMetadata{
 fun parse(c:Context,f:File,n:String,w:Boolean,check:()->Unit):NativeBibliography{throw NativeImportFailure("pdf_requires_device")}
 fun normalizeCover(b:ByteArray?,check:()->Unit):ByteArray?{check();return b}
}
`)
  put('NativeImportHost.kt', `package io.pagewise.reader
import android.content.*
import android.database.sqlite.HostSql
import java.io.File
import java.util.UUID
import java.util.concurrent.*
import org.json.JSONObject
import org.json.JSONArray
fun main(args:Array<String>){
 Host.root=File(args[0]);HostSql.script=args[1];val context=Context();val service=NativeFileJobService();var assertions=0
 fun verify(v:Boolean,message:String){assertions++;check(v){message}}
 fun uuid()=UUID.randomUUID().toString()
 val documentIds=mutableMapOf<String,String>()
 fun command(action:String,id:String,kind:String="index",request:JSONObject=JSONObject(),documentId:String?=null):app.tauri.plugin.JSObject{
  val payload=JSONObject().put("id",id)
  if(action=="start")payload.put("kind",kind).put("folderId",if(kind=="import")"app-import" else "saf-fixture").put("documentId",if(kind=="import")documentId?:documentIds.getOrPut(id){uuid()} else "").put("request",request)
  return NativeFileJobs.command(context,JSONObject().put("action",action).put("payload",payload))
 }
 fun start(id:String){service.onStartCommand(Intent(context,NativeFileJobService::class.java).putExtra("jobId",id),0,Host.starts)}
 fun await(id:String):app.tauri.plugin.JSObject{repeat(100){val r=command("status",id);if(r.getString("state") !in setOf("queued","running"))return r;Thread.sleep(10)};error("job did not settle")}
 fun idle(){val f=NativeFileJobs::class.java.getDeclaredField("physicalWorkers").apply{isAccessible=true};repeat(300){if(synchronized(NativeFileJobs){(f.get(null) as Map<*,*>).isEmpty()})return;Thread.sleep(10)};error("worker remains active")}
 fun stage(name:String):Pair<File,JSONObject>{val f=File(context.cacheDir,"import-"+uuid()+".bin");f.parentFile.mkdirs();File(Host.root,"sources/"+name).copyTo(f);return f to JSONObject().put("path","cache/"+f.name).put("fileName",name)}
 fun batch(item:JSONObject)=JSONObject().put("items",JSONArray().put(item)).put("source","Synthetic copy")
 fun query(sql:String)=NativeImportDatabase(context).use{it.rows(sql)}
 try{
  val (uploadInput,uploadItem)=stage("one.txt");val uploadPath=uploadItem.getString("path");val uploadBatch=uuid()
  verify(NativeImportUploads.acquire(uploadPath)==null,"upload owns its token before entering queue")
  fun cleanupUpload()=NativeFileJobs.command(context,JSONObject().put("action","cleanupImport").put("payload",JSONObject().put("id",uploadBatch).put("paths",JSONArray().put(uploadPath))))
  val uploadBusy=try{cleanupUpload();false}catch(e:MonitoredFolderIo.Failure){e.code=="busy"}
  verify(uploadBusy && uploadInput.isFile,"preparing cleanup cannot pass an in-flight ExportPlugin path owner")
  val premature=uuid();val admitBusy=try{command("start",premature,"import",batch(uploadItem));false}catch(e:MonitoredFolderIo.Failure){e.code=="busy"}
  verify(admitBusy && !File(context.filesDir,"native-file-jobs/"+premature+".json").exists(),"library admission cannot read a still-uploading input")
  NativeImportUploads.finish(uploadPath)
  verify(cleanupUpload().getString("state")=="released" && !uploadInput.exists(),"released upload can be physically deleted")
  verify(NativeImportUploads.acquire(uploadPath)=="invalid_reference","late upload IPC cannot recreate a sealed token")
  println("PASS shared upload/library release fencing and late-IPC sealing")
  val good=File(Host.root,"sources/new.epub");val bad=File(Host.root,"sources/bad.epub")
  Source.documents=listOf(Source.Document("existing-doc","renamed.epub",good),Source.Document("new-doc","new.epub",good),Source.Document("bad-doc","bad.epub",bad))
  val partial=uuid();command("start",partial);start(partial);val p=await(partial)
  verify(p.getString("state")=="succeeded","batch receipt exists even with individual failures")
  val pr=p.getJSONObject("result");verify(pr.getInt("imported")==1 && pr.getInt("updated")==1 && pr.getInt("failed")==1 && !pr.getBoolean("complete"),"partial counters reconcile")
  val manual=query("SELECT * FROM books WHERE id='existing'").single()
  verify(manual["title"]=="Manual title" && manual["tags"]=="[\\"manual\\"]" && manual["classification"]=="{\\"revision\\":7}" && manual["reading_seconds"]=="180","manual bibliography/classification/history preserved")
  verify(query("SELECT text FROM annotations WHERE id='note'").single()["text"]=="KEEP NOTE","annotation untouched")
  verify(query("SELECT title FROM books WHERE id!='existing'").single()["title"]=="Native synthetic title","metadata committed by native")
  verify(File(context.dataDir,"covers").listFiles()!!.count{!it.name.startsWith(".") }==1,"cover bytes published natively")
  command("ack",partial);idle()
  Source.documents=listOf(Source.Document("existing-doc","renamed.epub",good));Source.complete=false
  val incomplete=uuid();command("start",incomplete);start(incomplete);verify(!await(incomplete).getJSONObject("result").getBoolean("complete"),"partial enumeration remains partial")
  verify(query("SELECT file_availability FROM books WHERE id!='existing'").single()["file_availability"]=="available","partial listing cannot prove disappearance");command("ack",incomplete);idle()
  Source.complete=true;val clean=uuid();command("start",clean);start(clean);verify(await(clean).getJSONObject("result").getBoolean("complete"),"clean scan finishes")
  verify(query("SELECT file_availability FROM books WHERE id!='existing'").single()["file_availability"]=="missing","only complete error-free scan marks unseen missing");command("ack",clean);idle()
  println("PASS native indexing, cover publication, metadata/manual-data preservation, partial listings and missing-source reconciliation")

  val before=query("SELECT id FROM books").size
  val (input,item)=stage("one.txt");HostSql.failRecord=true
  val rollback=uuid();command("start",rollback,"import",batch(item));start(rollback);verify(await(rollback).getString("state")=="failed","SQLite failure is a task error");idle();HostSql.failRecord=false
  verify(query("SELECT id FROM books").size==before,"failed receipt transaction rolls book insertion back")
  verify(input.isFile,"unknown/failed DB outcomes retain owned input for retry")
  verify(File(context.dataDir,"books").listFiles()?.none{!it.name.startsWith(".")}?:true,"failed DB transaction removes only its own published book")
  command("ack",rollback)
  val retry=uuid();command("start",retry,"import",batch(item));start(retry);verify(await(retry).getJSONObject("result").getInt("imported")==1,"retry can commit after proven rollback");command("ack",retry);idle()
  verify(query("SELECT id FROM books").size==before+1,"one committed copy")

  val (uncertainInput,uncertainItem)=stage("one.txt");HostSql.failCommitAfter=true
  val uncertain=uuid();command("start",uncertain,"import",batch(uncertainItem));start(uncertain);val unknown=await(uncertain);idle()
  verify(unknown.getString("code")=="commit_outcome_unknown","lost commit ACK is not ordinary failure/no data")
  verify(unknown.getJSONObject("progress").getInt("imported")==1,"durable SQLite receipt reconciles a committed book")
  verify(uncertainInput.isFile,"unknown response retains staging until reconciliation")
  val count=query("SELECT id FROM books").size;command("ack",uncertain)
  val adopt=uuid();command("start",adopt,"import",batch(uncertainItem));start(adopt);verify(await(adopt).getJSONObject("result").getInt("skipped")==1,"same input token adopts committed book")
  verify(query("SELECT id FROM books").size==count,"no duplicate after unknown commit");command("ack",adopt);idle()
  println("PASS real SQLite rollback, atomic book/receipt publication, unknown commit reconciliation and copied-token idempotence")

  val (cancelInput,cancelItem)=stage("one.txt");HostSql.entered=CountDownLatch(1);HostSql.commitGate=CountDownLatch(1)
  val cancel=uuid();command("start",cancel,"import",batch(cancelItem));start(cancel)
  verify(HostSql.entered.await(3,TimeUnit.SECONDS),"book reached commit gate")
  command("cancel",cancel);val pending=command("status",cancel)
  verify(pending.getString("state")=="running" && pending.getString("phase")=="committing","cancel cannot publish an uncommitted/failed lie while COMMIT is in flight")
  val prematureCleanup=try{
   NativeFileJobs.command(context,JSONObject().put("action","cleanupImport").put("payload",JSONObject().put("id",documentIds.getValue(cancel)).put("paths",JSONArray().put(cancelItem.getString("path")))));false
  }catch(e:MonitoredFolderIo.Failure){e.code=="busy"}
  verify(prematureCleanup && cancelInput.isFile,"input cleanup cannot race a physical worker blocked inside COMMIT")
  HostSql.commitGate!!.countDown();HostSql.commitGate=null
  val cancelled=await(cancel);idle();verify(cancelled.getString("state")=="cancelled","deferred cancel settles after commit")
  verify(!cancelInput.exists(),"cancelled worker releases inputs only after its physical IO finishes")
  verify(cancelled.getJSONObject("progress").getInt("imported")==1,"partial committed count remains authoritative after cancellation");command("ack",cancel)
  println("PASS cancellation fencing during actual SQLite commit; no late unreported write")

  val (combinedInput,combinedItem)=stage("one.txt");HostSql.entered=CountDownLatch(1);HostSql.commitGate=CountDownLatch(1)
  val combined=uuid();command("start",combined,"import",batch(combinedItem));start(combined)
  verify(HostSql.entered.await(3,TimeUnit.SECONDS),"combined fault reaches COMMIT")
  HostSql.failCommitAfter=true;command("cancel",combined);HostSql.commitGate!!.countDown();HostSql.commitGate=null
  val combinedResult=await(combined);idle()
  verify(combinedResult.getString("code")=="commit_outcome_unknown" && combinedInput.isFile,"cancel cannot erase unknown SQL outcome or its recoverable input")
  verify(combinedResult.getJSONObject("progress").getInt("imported")==1,"combined fault still exposes the actual committed receipt");command("ack",combined)
  println("PASS unknown COMMIT outcome takes precedence over a deferred cancel")

  val (racedFirst,racedItem)=stage("one.txt");val (racedSecond,racedSecondItem)=stage("two.txt")
  val raceRequest=JSONObject().put("items",JSONArray().put(racedItem).put(racedSecondItem)).put("source","Synthetic race")
  val settlementEntered=CountDownLatch(1);val settlementRelease=CountDownLatch(1)
  NativeCommitProbe.beforeSettlement={settlementEntered.countDown();check(settlementRelease.await(5,TimeUnit.SECONDS))}
  HostSql.failCommitAfter=true;val raced=uuid();command("start",raced,"import",raceRequest);start(raced)
  try{
   verify(settlementEntered.await(3,TimeUnit.SECONDS),"unknown COMMIT pauses before guard settlement")
   command("cancel",raced)
   verify(command("status",raced).getString("state")=="running","racing cancellation remains deferred while commit guard is held")
  }finally{NativeCommitProbe.beforeSettlement=null;settlementRelease.countDown()}
  val raceResult=await(raced);idle()
  verify(raceResult.getString("code")=="commit_outcome_unknown" && racedSecond.isFile,"cancel between classification and settlement cannot erase unknown outcome or unprocessed input")
  verify(raceResult.getJSONObject("progress").getInt("done")==1,"race preserves actual committed prefix")
  command("ack",raced)
  val raceResume=uuid();command("start",raceResume,"import",raceRequest,documentIds.getValue(raced));start(raceResume)
  verify(await(raceResume).getJSONObject("result").getInt("imported")==2,"raced partial batch resumes without duplicate commits");idle();command("ack",raceResume)
  verify(!racedFirst.exists() && !racedSecond.exists(),"resumed race inputs release only after resolution")
  println("PASS deterministic cancel between unknown-COMMIT classification and guard settlement")

  for(name in listOf("UPPER.TXT","UPPER.EPUB")){
   val (staged,item)=stage(name);val upper=uuid();command("start",upper,"import",batch(item));start(upper)
   val result=await(upper).getJSONObject("result");idle();val bookId=result.getJSONArray("results").getJSONObject(0).getString("bookId")
   val stored=File(context.dataDir,"books/"+bookId+"."+name.substringAfterLast('.'))
   verify(stored.isFile && stored.readBytes().contentEquals(File(Host.root,"sources/"+name).readBytes()),"actual legacy bookPath reads uppercase extension: "+name)
   verify(query("SELECT file_name FROM books WHERE id='"+bookId+"'").single()["file_name"]==name,"DB keeps original filename")
   verify(!staged.exists(),"successful worker releases staging")
   if(name=="UPPER.EPUB"){
    val receipt=File(context.filesDir,"native-file-jobs/"+upper+".json");val saved=JSONObject(receipt.readText())
    val old=saved.getJSONObject("request");val oldItem=old.getJSONArray("items").getJSONObject(0)
    saved.put("request",JSONObject().put("source",old.getString("source")).put("items",JSONArray().put(JSONObject().put("fileName",oldItem.getString("fileName")).put("path",oldItem.getString("path")))))
    saved.put("state","running");saved.remove("result");saved.remove("progress");receipt.writeText(saved.toString())
    NativeFileJobs::class.java.getDeclaredField("root").apply{isAccessible=true}.set(null,null)
    val recovered=command("status",upper)
    verify(recovered.getString("state")=="succeeded" && recovered.getJSONObject("result").getJSONArray("results").getJSONObject(0).getString("bookId")==bookId,"process loss after SQL commit recovers authoritative success without re-parsing deleted input")
    val mismatch=try{NativeImportDatabase.progress(context,documentIds.getValue(upper),"wrong-request");false}catch(e:NativeImportFailure){e.code=="invalid_reference"}
    verify(mismatch,"SQL receipt reconciliation is fenced by canonical request identity")
   }
   command("ack",upper)
   verify(stored.delete() && !stored.exists(),"actual case-sensitive post-import deletion uses the same bookPath")
  }
  println("PASS uppercase publication/read/delete, stable canonical request identity and process-loss SQL receipt recovery")

  val (firstInput,firstItem)=stage("one.txt");val (secondInput,secondItem)=stage("two.txt")
  val pair=JSONObject().put("items",JSONArray().put(firstItem).put(secondItem)).put("source","Synthetic copy")
  val interrupted=uuid();HostSql.bookRecords=0;HostSql.failRecordAfter=2
  command("start",interrupted,"import",pair);start(interrupted);val failedPair=await(interrupted);idle();HostSql.failRecordAfter=0
  verify(failedPair.getString("code")=="database_error" && failedPair.getJSONObject("progress").getInt("done")==1,"second-book rollback retains exact committed prefix")
  verify(!firstInput.exists() && secondInput.isFile,"only unprocessed staging remains after a recoverable failure")
  val prefixCount=query("SELECT id FROM books").size;command("ack",interrupted)
  val oldReceipt=File(context.filesDir,"native-file-jobs/"+interrupted+".json")
  oldReceipt.writeText(JSONObject(oldReceipt.readText()).put("createdAt",System.currentTimeMillis()-3_600_001L).toString())
  NativeFileJobs::class.java.getDeclaredField("root").apply{isAccessible=true}.set(null,null)
  val aged=command("status",interrupted)
  verify(aged.getJSONObject("progress").getInt("done")==1 && secondInput.isFile,"observation expiry cannot destroy a recoverable partial-batch input")
  val changedId=uuid();val changed=JSONObject(pair.toString()).put("source","changed request")
  val rejected=try{command("start",changedId,"import",changed,documentIds.getValue(interrupted));false}catch(e:NativeImportFailure){e.code=="invalid_reference"}
  verify(rejected && secondInput.isFile && !File(context.filesDir,"native-file-jobs/"+changedId+".json").exists(),"changed batch request is rejected before admission or input destruction")
  val resumed=uuid();command("start",resumed,"import",pair,documentIds.getValue(interrupted));start(resumed);val resumedResult=await(resumed).getJSONObject("result");idle()
  verify(resumedResult.getInt("imported")==2 && query("SELECT id FROM books").size==prefixCount+1,"fresh job resumes the same SQL batch after ACK without duplicating committed prefix")
  verify(!secondInput.exists(),"resumed worker releases remaining staging");command("ack",resumed)
  println("PASS actual partial-prefix SQL resumption across a fresh job ID and ACK boundary")

  Source.granted=false;val revoke=uuid();command("start",revoke);start(revoke);verify(await(revoke).getJSONObject("result").getJSONArray("errors").getJSONObject(0).getString("code")=="permission_denied","revocation is explicit")
  verify(query("SELECT file_availability FROM books WHERE id='existing'").single()["file_availability"]=="permission-denied","native availability updates on lost grant");command("ack",revoke);idle();Source.granted=true
  NativeImportDatabase(context).use{database->
   val old=database.linked("saf-fixture","existing-doc").single();val newer=JSONObject(old["source_ref"]!!).put("documentId","user-selected")
   database.execute("UPDATE books SET source_ref=? WHERE id=?",listOf(newer.toString(),"existing"))
   val stopped=try{database.transaction{database.updateReference(old,JSONObject(old["source_ref"]!!),"old.epub","epub","available")};false}catch(e:NativeImportFailure){e.code=="source_changed"}
   verify(stopped,"source CAS conflict cannot overwrite a concurrent user relink")
  }
  println("HOST_PASS assertions="+assertions+"; actual production owner/importer/SQL, Python SQLite oracle, controlled provider and bitmap adapters; no Android device claim")
 }finally{
  HostSql.commitGate?.countDown()
  for(name in listOf("executor","cancellationExecutor")){val f=NativeFileJobs::class.java.getDeclaredField(name).apply{isAccessible=true};(f.get(null) as ThreadPoolExecutor).shutdownNow()}
 }
}
`)
  const productionJobs = readFileSync(join(root, 'src-tauri/android/NativeFileJobs.kt'), 'utf8')
  const settlementSeam = '                throw error\n            } finally {\n                synchronized(this@NativeFileJobs)'
  assert.equal(productionJobs.split(settlementSeam).length, 2, 'one scheduling-only commit-settlement seam')
  const scheduledJobs = emit(out, 'ProductionNativeFileJobs.kt', productionJobs.replace(settlementSeam,
    '                NativeCommitProbe.beforeSettlement?.invoke()\n' + settlementSeam))
  const kotlin = ['NativeBookMetadata.kt', 'NativeMobiLocales.kt', 'NativeBookImporter.kt', 'NativeImportDatabase.kt'].map(n => join(root, 'src-tauri/android', n))
  kotlin.push(scheduledJobs)
  const cp = compile(out, [...sources, ...kotlin], [artifact('org.commonmark', 'commonmark', '0.21.0'), artifact('net.sf.kxml', 'kxml2', '2.3.0'), ...groovy()])
  const output = runJvm(out, 'run', ['-Xmx128m', '-cp', cp, 'io.pagewise.reader.NativeImportHostKt', fixture, py], 60000)
  assert.match(output, /HOST_PASS assertions=/)
  console.log(output)
  // A second independent connection verifies the final persisted DB, not a mocked write list.
  const after = new DatabaseSync(join(fixture, 'data/lightread.db'))
  assert.equal(after.prepare("SELECT text FROM annotations WHERE id='note'").get().text, 'KEEP NOTE')
  assert.equal(after.prepare("SELECT count(*) AS n FROM books WHERE source_ref IS NULL").get().n, 10)
  after.close()
})
