import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { root, compile, runJvm, emit, groovy, jsonAdapter } from './native-import-test-tools.mjs'
import { createMemoryReadingLogStore, createReadingLog } from '../src/services/readingLog.ts'
import { milestones, rangeSummary } from '../src/services/readingStats.ts'
import { compareLibraryBooks } from '../src/services/libraryQuery.ts'

function parseFixtureJson(text) {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error('Invalid synthetic repository fixture JSON', { cause: error })
  }
}

// Only Android API transport is adapted. Production Kotlin queries/transactions run on Python SQLite.
test('native library repository: shared-schema SQLite, CAS, retained files, classification and JS statistics parity', async () => {
  const out = resolve(root, '../.cache/native-library-host', `${Date.now()}-${process.pid}`)
  const fixture = join(out, 'synthetic')
  mkdirSync(fixture, { recursive: true })
  const data = join(fixture, 'data'), custom = join(fixture, 'custom')
  for (const path of [data, custom, join(custom, 'books'), join(custom, 'covers')]) mkdirSync(path, { recursive: true })
  const schemaSource = readFileSync(join(root, 'src/storage/tauri.ts'), 'utf8')
  const start = schemaSource.indexOf('CREATE TABLE IF NOT EXISTS books')
  const schema = schemaSource.slice(start, schemaSource.indexOf('`)', start))
  const dbPath = join(custom, 'lightread.db')
  const db = new DatabaseSync(dbPath)
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) db.exec(`DROP TABLE "${name}"`)
  db.exec(schema)
  for (const [, , sql] of schemaSource.matchAll(/(["'])(ALTER TABLE (?:books|annotations)[^\r\n]*?)\1/g)) {
    const [, , table, , , column] = sql.split(' ')
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column)) db.exec(sql)
  }
  db.exec(`CREATE TABLE native_core_migration(id INTEGER PRIMARY KEY,state TEXT NOT NULL);
    CREATE TABLE native_core_settings(id INTEGER PRIMARY KEY,revision INTEGER NOT NULL,json TEXT NOT NULL);
    CREATE TABLE native_core_reading(key TEXT PRIMARY KEY,seconds REAL NOT NULL,json TEXT NOT NULL);
    CREATE TABLE native_core_hashes(book_id TEXT PRIMARY KEY,hash TEXT NOT NULL);
    INSERT INTO native_core_migration VALUES(1,'complete')`)
  db.prepare('INSERT INTO native_core_settings VALUES(1,1,?)').run(JSON.stringify({ libraryRoot: custom, aiProfiles: [{ id: 'synthetic-profile', apiKey: 'synthetic-not-a-key' }] }))
  const classification = { version: 1, revision: 7, category: { value: 'computing-ai', locked: true, source: 'manual' }, topics: [{ value: '数据库', locked: true, source: 'manual' }], feature: null, facets: {}, legacyTags: ['保留  原始'] }
  const insert = db.prepare('INSERT INTO books(id,title,author,format,file_name,tags,classification,added_at,last_read_at,progress,reading_seconds,reading_status,source_ref,has_cover) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
  const books = [
    { id: 'early', title: 'Canonical', author: 'Writer', addedAt: 1, lastReadAt: 100, readingStatus: null, tags: ['人工智能'], classification: null },
    { id: 'alias', title: 'Alias', author: 'Writer', addedAt: 2, lastReadAt: 200, readingStatus: 'paused', tags: ['manual'], classification },
    { id: 'legacy-unread', title: 'Unread', author: '', addedAt: 3, lastReadAt: 300, readingStatus: 'unread', tags: [], classification: null },
    { id: 'progress-only', title: 'Progress', author: '', addedAt: 4, lastReadAt: null, readingStatus: null, tags: [], classification: null },
    { id: 'explicit', title: 'Ｒｅａｄｉｎｇ  Book', author: 'ＡＵＴＨＯＲ', addedAt: 5, lastReadAt: null, readingStatus: 'reading', tags: ['Ｔａｇ'], classification: null },
    { id: 'linked', title: 'Linked', author: '', addedAt: 6, lastReadAt: null, readingStatus: null, tags: [], classification: null },
    { id: 'raw', title: 'Raw', author: '', addedAt: 7, lastReadAt: null, readingStatus: null, tags: [' Raw  tag '], classification: { revision: 99, unknown: 'preserve' } },
    { id: 'remove', title: 'Removable', author: '', addedAt: 8, lastReadAt: null, readingStatus: null, tags: [], classification: null },
  ]
  for (const b of books) insert.run(b.id, b.title, b.author, 'epub', `${b.id}.epub`, JSON.stringify(b.tags), b.classification && JSON.stringify(b.classification), b.addedAt, b.lastReadAt, .7, 10, b.readingStatus, b.id === 'linked' ? JSON.stringify({ folderId: 'synthetic-saf', documentId: 'doc', relativePath: 'a.epub', version: '[1,1]' }) : null, b.id === 'remove' ? 1 : 0)
  db.exec("UPDATE books SET kind='paper' WHERE id='raw'; UPDATE books SET pinned_at=9 WHERE id='remove'")
  db.exec(`INSERT INTO annotations(id,book_id,cfi,text,note,color,created_at,kind) VALUES
    ('note','early','epubcfi(/6/2)','Original selection','Thought','yellow',3,'highlight'),
    ('orphan','gone','epubcfi(/6/4)','Deleted source text',NULL,'blue',2,'bookmark'),
    ('remove-note','remove','epubcfi(/6/8)','Remove note',NULL,'yellow',1,'highlight');
    INSERT INTO booklists VALUES('list','Synthetic list',1,2);
    INSERT INTO booklist_items VALUES('list','remove',1)`)
  const hashes = new Map([['early', 'shared-hash'], ['alias', 'shared-hash'], ['deleted', 'deleted-hash']])
  for (const [id, hash] of hashes) db.prepare('INSERT INTO native_core_hashes VALUES(?,?)').run(id, hash)
  const logRows = [
    ['d1|2026-01-01|id:early', 100, 'Canonical snapshot'],
    ['d1|2026-01-01|h:shared-hash', 20, 'Landed difference'],
    ['d1|2026-01-01|id:alias', 30, 'Alias snapshot'],
    ['d2|2026-01-01|h:shared-hash', 50, 'Other device'],
    ['d1|2026-01-02|id:deleted', 80, 'Deleted title snapshot'],
    ['d1|2026-01-05|id:early', 100, 'Snapshot'],
    ['d1|2026-01-05|h:shared-hash', 20, 'Landed delta'],
    ['d1|2026-01-06|h:z-sort-key', 40, 'Alpha'],
    ['d1|2026-01-06|h:a-sort-key', 40, 'Zeta'],
    ['d1|2026-01-03|id:unknown', 5, 'Unhashed deleted snapshot'],
    ['d1|2026-01-04|h:remote', 40, 'Remote title snapshot'],
  ].map(([key, seconds, title]) => {
    const [device, day, ref] = key.split('|')
    return { key, device, day, title, kind: 'book', seconds, updatedAt: 1, ...(ref.startsWith('id:') ? { bookId: ref.slice(3) } : { hash: ref.slice(2) }) }
  })
  for (const r of logRows) db.prepare('INSERT INTO native_core_reading VALUES(?,?,?)').run(r.key, r.seconds, JSON.stringify(r))
  db.close()
  const sourceFile = join(custom, 'books/remove.epub'), coverFile = join(custom, 'covers/remove.jpg')
  writeFileSync(sourceFile, 'SYNTHETIC DOCUMENT'); writeFileSync(coverFile, 'SYNTHETIC COVER')
  const sources = [], put = (name, content) => sources.push(emit(out, name, content))
  const stateSource = readFileSync(join(root, 'src-tauri/android/NativeStateStore.kt'), 'utf8')
  const errorStart = stateSource.indexOf('internal class NativeStateFailure('), errorEnd = stateSource.indexOf('/**', errorStart)
  put('Failure.kt', 'package io.pagewise.reader\n' + stateSource.slice(errorStart, errorEnd))
  put('Json.kt', jsonAdapter().replace('open class JSONObject {', 'class JSONException(message:String):RuntimeException(message)\nopen class JSONObject {')
    .replace('fun get(k: String)=wrap(data.getValue(k))', 'fun get(k: String)=if(!data.containsKey(k))throw JSONException("missing field") else wrap(data[k])')
    .replace('constructor(){data=arrayListOf()}', 'constructor(){data=arrayListOf()}\n constructor(text:String):this(groovy.json.JsonSlurper().parseText(text) as Collection<*>)')
    .replace('data=if(values is MutableList<*>) values as MutableList<Any?> else values.toMutableList()', 'data=if(values is MutableList<*> && values.none{it is JSONObject || it is JSONArray}) values as MutableList<Any?> else values.map{when(it){is JSONObject->it.data;is JSONArray->it.data;else->it}}.toMutableList()'))
  put('Context.kt', `package android.content
import java.io.File
class Preferences(private val root:String?){fun getString(key:String,default:String?)=root?:default}
class Context(val dataDir:File,val root:String?){fun getSharedPreferences(name:String,mode:Int)=Preferences(root);companion object{const val MODE_PRIVATE=0}}
`)
  put('Cursor.kt', `package android.database
import java.io.Closeable
class Cursor(val columnNames:Array<String>,val rows:List<List<Any?>>):Closeable{
 private var at=-1
 fun moveToNext():Boolean{at++;return at<rows.size}
 fun isNull(i:Int)=rows[at][i]==null
 fun getString(i:Int)=rows[at][i].toString()
 override fun close(){}
}
`)
  const py = emit(out, 'sqlite-host.py', `import json,sqlite3,sys
conn=sqlite3.connect('file:'+sys.argv[1]+'?mode=rw',uri=True,isolation_level=None,timeout=5)
for line in sys.stdin:
 try:
  req=json.loads(line); c=conn.execute(req['sql'],req.get('args',[]))
  result={'columns':[d[0] for d in c.description],'rows':[list(r) for r in c.fetchall()]} if req['query'] else {}
  print(json.dumps(result,ensure_ascii=True),flush=True)
 except sqlite3.Error as error:
  print(json.dumps({'error':type(error).__name__}),flush=True)
conn.close()
`)
  put('SQLite.kt', `package android.database.sqlite
import android.database.Cursor
import org.json.JSONObject
import org.json.JSONArray
import java.io.Closeable
object HostSql{lateinit var script:String;var failSql:String?=null;var lostCommit=false;var opens=0;var closes=0}
class SQLiteException(message:String):RuntimeException(message)
class SQLiteDatabase private constructor(path:String):Closeable{
 private val process=ProcessBuilder("python","-u",HostSql.script,path).apply{environment()["PYTHONUTF8"]="1"}.start()
 private val writer=process.outputStream.bufferedWriter(Charsets.UTF_8)
 private val reader=process.inputStream.bufferedReader(Charsets.UTF_8)
 private var success=false
 init{HostSql.opens++}
 private fun send(sql:String,args:List<Any?> = emptyList(),query:Boolean=false):JSONObject{
  if(sql==HostSql.failSql){HostSql.failSql=null;throw SQLiteException("injected SQL failure")}
  writer.write(JSONObject().put("sql",sql).put("args",JSONArray(args)).put("query",query).toString());writer.newLine();writer.flush()
  val result=JSONObject(reader.readLine()?:throw SQLiteException("oracle EOF"))
  if(result.has("error"))throw SQLiteException(result.getString("error"));return result
 }
 fun rawQuery(sql:String,args:Array<String>?):Cursor{
  val r=send(sql,args?.toList()?:emptyList(),true)
  @Suppress("UNCHECKED_CAST") val rows=r.getJSONArray("rows").data as List<List<Any?>>
  return Cursor(r.getJSONArray("columns").data.map{it.toString()}.toTypedArray(),rows)
 }
 fun execSQL(sql:String){send(sql)}
 fun execSQL(sql:String,args:Array<out Any?>){send(sql,args.toList())}
 fun beginTransactionNonExclusive(){success=false;send("BEGIN IMMEDIATE")}
 fun setTransactionSuccessful(){success=true}
 fun endTransaction(){send(if(success)"COMMIT" else "ROLLBACK");if(success&&HostSql.lostCommit){HostSql.lostCommit=false;throw SQLiteException("lost ACK")}}
 override fun close(){writer.close();process.waitFor(3,java.util.concurrent.TimeUnit.SECONDS);if(process.isAlive)process.destroyForcibly();HostSql.closes++}
 companion object{const val OPEN_READWRITE=0;const val NO_LOCALIZED_COLLATORS=16;fun openDatabase(path:String,factory:Any?,flags:Int)=SQLiteDatabase(path)}
}
`)
  put('Harness.kt', `package io.pagewise.reader
import android.content.Context
import android.database.sqlite.HostSql
import org.json.JSONObject
import org.json.JSONArray
import java.io.File
fun expect(code:String,body:()->Unit){try{body();error("Expected "+code)}catch(e:NativeStateFailure){check(e.code==code){"Expected "+code+" got "+e.code}}}
fun main(args:Array<String>){
 HostSql.script=args[0];val fixture=File(args[1]);val custom=File(fixture,"custom");val context=Context(File(fixture,"data"),custom.path)
 expect("migration_not_initialized"){NativeLibraryRepository(Context(context.dataDir,null))}
 expect("unsupported_library_root"){NativeLibraryRepository(Context(context.dataDir,"content:synthetic"))}
 expect("library_database_missing"){NativeLibraryRepository(Context(context.dataDir,""))}
 check(!File(context.dataDir,"lightread.db").exists())
 NativeLibraryRepository(context).use{repo->
  fun cmd(a:String,p:JSONObject=JSONObject())=repo.command(a,p)
  fun book(id:String)=cmd("book",JSONObject().put("id",id)).getJSONObject("book")
  fun patch(id:String,before:JSONObject,p:JSONObject)=cmd("bookPatch",JSONObject().put("id",id).put("before",before).put("patch",p))
  check(cmd("books").getLong("total")==8L)
  val page=cmd("books",JSONObject().put("offset",1).put("limit",2));check(page.getJSONArray("items").length()==2&&page.getLong("total")==8L)
  check(cmd("books",JSONObject().put("offset",100).put("limit",1)).getJSONArray("items").length()==0)
  for(p in listOf(JSONObject().put("limit",257),JSONObject().put("offset",-1),JSONObject().put("limit",0),JSONObject().put("limit",1.5)))expect("invalid_payload"){cmd("books",p)}
  check(cmd("books",JSONObject().put("query","reading AUTHOR tag")).getLong("total")==1L)
  check(cmd("books",JSONObject().put("readingOnly",true)).getLong("total")==2L)
  check(cmd("books",JSONObject().put("kind","paper")).getLong("total")==1L)
  check(cmd("books",JSONObject().put("kind","book")).getLong("total")==7L)
  check(cmd("books",JSONObject().put("readingStatus","unmarked")).getLong("total")==5L)
  check(cmd("books",JSONObject().put("readingStatus","unread")).getLong("total")==5L)
  check(cmd("books",JSONObject().put("readingStatus","paused")).getLong("total")==1L)
  check(cmd("books",JSONObject().put("kind","paper").put("readingStatus","unmarked")).getLong("total")==1L)
  check(cmd("books",JSONObject().put("readingOnly",true).put("readingStatus","paused")).getLong("total")==0L)
  for(p in listOf(JSONObject().put("format","epub"),JSONObject().put("sort","published"),JSONObject().put("kind","unknown"),JSONObject().put("readingStatus","guess-finished")))expect("unsupported_filter"){cmd("books",p)}
  expect("unsupported_filter"){cmd("annotations",JSONObject().put("kind","highlight"))}
  val orders=JSONObject()
  for(sort in listOf("recent","title","author","added","pinned"))orders.put(sort,cmd("books",JSONObject().put("sort",sort)))
  orders.put("titlePage",cmd("books",JSONObject().put("sort","title").put("offset",2).put("limit",2)))
  File(fixture,"library-query.json").writeText(orders.toString())
  check(cmd("books",JSONObject().put("query","%' OR 1=1 --")).getLong("total")==0L)
  val original=book("early");check(original.isNull("publisher")&&original.isNull("classification"))
  // Separate connection simulates the reader updating progress after the management draft was opened.
  android.database.sqlite.SQLiteDatabase.openDatabase(File(custom,"lightread.db").path,null,0).use{it.execSQL("UPDATE books SET progress=.9,location='new-cfi',reading_seconds=45 WHERE id='early'")}
  val edited=patch("early",original,JSONObject().put("title","Edited title")).getJSONObject("book")
  check((edited.get("progress") as Number).toDouble()==.9&&edited.getString("location")=="new-cfi"&&edited.getLong("readingSeconds")==45L)
  expect("book_conflict"){patch("early",original,JSONObject().put("title","Stale title"))}
  expect("unsupported_field"){patch("early",edited,JSONObject().put("location","clobber"))}
  val raw=book("raw");val rawUpdated=patch("raw",raw,JSONObject().put("author","Updated author")).getJSONObject("book")
  check(rawUpdated.getJSONObject("classification").toString()==raw.getJSONObject("classification").toString()&&rawUpdated.getJSONArray("tags").toString()==raw.getJSONArray("tags").toString())
  val structured=book("alias")
  expect("classification_required"){patch("alias",structured,JSONObject().put("tags",JSONArray().put("overwrite")))}
  val next=JSONObject(structured.getJSONObject("classification").toString()).put("revision",8)
  next.getJSONArray("topics").put(JSONObject().put("value","网络").put("locked",true).put("source","manual"))
  val saved=patch("alias",structured,JSONObject().put("classification",next)).getJSONObject("book")
  check(saved.getJSONArray("tags").toString()==JSONArray().put("计算机与AI").put("数据库").put("网络").toString())
  check(saved.getJSONObject("classification").getJSONArray("legacyTags").getString(0)=="保留  原始")
  expect("book_conflict"){patch("alias",structured,JSONObject().put("classification",next))}
  val invalid=JSONObject(saved.getJSONObject("classification").toString()).put("revision",9)
  invalid.getJSONArray("topics").put(JSONObject().put("value","系统").put("locked",false).put("source","ai"))
  expect("manual_classification_required"){patch("alias",saved,JSONObject().put("classification",invalid))}
  val bad=JSONObject(saved.getJSONObject("classification").toString()).put("revision",9)
  bad.getJSONArray("topics").put(JSONObject().put("value","数据库/关系").put("locked",true).put("source","manual"))
  expect("invalid_classification"){patch("alias",saved,JSONObject().put("classification",bad))}
  expect("invalid_classification"){patch("early",edited,JSONObject().put("tags",JSONArray().put("bad\\u0000tag")))}
  val notes=cmd("annotations");check(notes.getLong("total")==3L)
  check(cmd("annotations",JSONObject().put("filter","thoughts")).getLong("total")==1L)
  check(cmd("annotations",JSONObject().put("filter","highlights").put("limit",1)).getLong("total")==2L)
  check(cmd("annotations",JSONObject().put("filter","highlights").put("limit",1)).getJSONArray("items").length()==1)
  check(cmd("annotations",JSONObject().put("filter","bookmarks").put("bookId","gone")).getLong("total")==1L)
  check(cmd("annotations",JSONObject().put("filter","thoughts").put("query","writer")).getLong("total")==1L)
  expect("unsupported_filter"){cmd("annotations",JSONObject().put("filter","unknown"))}
  check(cmd("annotations",JSONObject().put("query","thought")).getLong("total")==1L)
  check(cmd("annotations",JSONObject().put("query","writer")).getLong("total")==1L)
  check(cmd("annotations",JSONObject().put("bookId","early")).getLong("total")==1L)
  val note=cmd("annotations",JSONObject().put("bookId","early")).getJSONArray("items").getJSONObject(0)
  val notePayload=JSONObject().put("id","note").put("before",note).put("patch",JSONObject().put("note","New thought"))
  val updated=cmd("annotationPatch",notePayload).getJSONObject("annotation")
  check(updated.getString("cfi")==note.getString("cfi")&&updated.getString("text")==note.getString("text"))
  expect("annotation_conflict"){cmd("annotationPatch",notePayload)}
  expect("unsupported_field"){cmd("annotationPatch",JSONObject().put("id","note").put("before",updated).put("patch",JSONObject().put("cfi","destroy")))}
  val orphan=cmd("annotations",JSONObject().put("bookId","gone")).getJSONArray("items").getJSONObject(0)
  check(orphan.isNull("bookTitle")&&orphan.getBoolean("sourceMissing"))
  cmd("annotationRemove",JSONObject().put("id","orphan").put("before",orphan))
  check(cmd("annotations").getLong("total")==2L)
  val detail=book("linked");check(detail.getString("fileName")=="linked.epub"&&detail.getJSONObject("sourceRef").getString("relativePath")=="a.epub")
  val pinned=patch("linked",detail,JSONObject().put("pinnedAt",100)).getJSONObject("book");check(pinned.getLong("pinnedAt")==100L)
  expect("book_conflict"){patch("linked",detail,JSONObject().put("pinnedAt",200))}
  val unpinned=patch("linked",pinned,JSONObject().put("pinnedAt",JSONObject.NULL)).getJSONObject("book")
  check(unpinned.isNull("pinnedAt")&&unpinned.getString("fileName")==detail.getString("fileName")&&unpinned.getJSONObject("sourceRef").toString()==detail.getJSONObject("sourceRef").toString())
  val linked=book("linked")
  expect("source_linked_book"){cmd("bookRemove",JSONObject().put("id","linked").put("before",linked))}
  val removable=book("remove");check(removable.getBoolean("hasCover")&&removable.getString("coverPath").endsWith("remove.jpg"))
  HostSql.failSql="DELETE FROM books WHERE id=?"
  expect("database_error"){cmd("bookRemove",JSONObject().put("id","remove").put("before",removable))}
  check(cmd("annotations",JSONObject().put("bookId","remove")).getLong("total")==1L)
  val removed=cmd("bookRemove",JSONObject().put("id","remove").put("before",removable));check(removed.getBoolean("filesRetained"))
  check(File(custom,"books/remove.epub").isFile&&File(custom,"covers/remove.jpg").isFile)
  expect("book_not_found"){book("remove")}
  check(cmd("booklists").getJSONArray("items").getJSONObject(0).getString("id")=="list")
  HostSql.lostCommit=true
  expect("commit_outcome_unknown"){patch("early",book("early"),JSONObject().put("language","en"))}
  check(book("early").getString("language")=="en")
  File(fixture,"statistics.json").writeText(cmd("statistics").toString())
  expect("unsupported_action"){cmd("mystery")}
  repo.close();repo.close()
  expect("repository_closed"){cmd("books")}
 }
 check(HostSql.opens==HostSql.closes)
 // Constructor failure closes its connection; no table recreation/migration takes place.
 android.database.sqlite.SQLiteDatabase.openDatabase(File(custom,"lightread.db").path,null,0).use{it.execSQL("UPDATE native_core_migration SET state='staging' WHERE id=1")}
 expect("native_state_not_ready"){NativeLibraryRepository(context)}
 android.database.sqlite.SQLiteDatabase.openDatabase(File(custom,"lightread.db").path,null,0).use{it.execSQL("UPDATE native_core_migration SET state='complete' WHERE id=1");it.execSQL("DROP TABLE annotations")}
 expect("library_schema_mismatch"){NativeLibraryRepository(context)}
 check(HostSql.opens==HostSql.closes)
 println("PASS: SQLite CAS, rollback, lost commit ACK, bounded pages/search, raw/manual classifications, source guard and file retention")
}
`)
  const repository = join(root, 'src-tauri/android/NativeLibraryRepository.kt')
  sources.push(repository)
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? join(homedir(), 'AppData/Local/Android/Sdk')
  const androidJar = join(sdk, 'platforms/android-36/android.jar')
  assert.ok(existsSync(androidJar), 'Installed Android 36 SDK required; no dependency installation')
  compile(join(out, 'android-api'), [join(out, 'Failure.kt'), repository], [androidJar])
  const cp = compile(out, sources, groovy())
  const output = runJvm(out, 'repository', ['-cp', cp, 'io.pagewise.reader.HarnessKt', py, fixture])
  assert.match(output, /PASS: SQLite CAS/)
  const statistics = parseFixtureJson(readFileSync(join(fixture, 'statistics.json'), 'utf8'))
  const store = createMemoryReadingLogStore(logRows)
  const shelf = books.filter(b => b.id !== 'remove').map(b => ({ ...b, title: b.id === 'early' ? 'Edited title' : b.title, kind: 'book' }))
  const log = createReadingLog({ store, identity: { getDeviceId: async () => 'd1', getHashes: async () => hashes }, listBooks: async () => shelf })
  const expectedDaily = await log.loadDaily()
  assert.deepEqual(statistics.daily, expectedDaily)
  const ordered = parseFixtureJson(readFileSync(join(fixture, 'library-query.json'), 'utf8'))
  for (const sort of ['recent', 'title', 'author', 'added', 'pinned']) {
    const sortBy = sort === 'added' ? 'addedAt' : sort === 'recent' || sort === 'pinned' ? 'lastRead' : sort
    const expected = books.map(b => ({ ...b, pinnedAt: b.id === 'remove' ? 9 : undefined })).sort((a, b) => compareLibraryBooks(a, b, { sortBy, pinnedFirst: true }))
    assert.deepEqual(ordered[sort].items.map(b => b.id), expected.map(b => b.id), `Global ${sort} order matches libraryQuery`)
    assert.equal(ordered[sort].total, books.length)
  }
  assert.deepEqual(ordered.titlePage.items.map(b => b.id), ordered.title.items.slice(2, 4).map(b => b.id))
  assert.equal(ordered.titlePage.total, books.length, 'Total is global, not sliced-page count')
  assert.equal(statistics.daily['2026-01-01'].seconds, 200, '100 id + 20 landed delta + 30 alias + 50 other device')
  assert.equal(statistics.daily['2026-01-05'].seconds, 120, '100 id + 20 landed delta is additive, not max')
  assert.equal(statistics.totalSeconds, milestones(expectedDaily).totalSeconds)
  assert.equal(statistics.activeDays, milestones(expectedDaily).activeDays)
  assert.deepEqual(statistics.books, rangeSummary(expectedDaily, '0000-01-01', '9999-12-31').books)
  const finalDb = new DatabaseSync(dbPath)
  assert.deepEqual(parseFixtureJson(finalDb.prepare('SELECT json FROM native_core_settings WHERE id=1').get().json), { libraryRoot: custom, aiProfiles: [{ id: 'synthetic-profile', apiKey: 'synthetic-not-a-key' }] })
  assert.equal(finalDb.prepare('SELECT count(*) AS n FROM native_core_reading').get().n, logRows.length)
  assert.equal(finalDb.prepare('SELECT count(*) AS n FROM native_core_hashes').get().n, hashes.size)
  assert.equal(finalDb.prepare('SELECT count(*) AS n FROM booklist_items').get().n, 0)
  assert.equal(parseFixtureJson(finalDb.prepare("SELECT source_ref FROM books WHERE id='linked'").get().source_ref).documentId, 'doc')
  finalDb.close()
  assert.ok(existsSync(sourceFile) && existsSync(coverFile))
  assert.equal(existsSync(join(data, 'lightread.db')), false)
  writeFileSync(join(out, 'summary.json'), JSON.stringify({ status: 'passed', oracle: 'production Kotlin + real Python SQLite, cross-checked with actual readingLog.ts and readingStats.ts', totalSeconds: statistics.totalSeconds, activeDays: statistics.activeDays, output }, null, 2))
})
