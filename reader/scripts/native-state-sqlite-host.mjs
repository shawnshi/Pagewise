import { spawnSync } from 'node:child_process'
import { emit, jsonAdapter } from './native-import-test-tools.mjs'

// Platform boundaries only: Kotlin owns every state transition and SQL statement.
// One long-lived Python sqlite3 connection per Android SQLiteDatabase preserves
// real transactions; independent probes use a separate SQLite connection.
export function sqliteOracle(script, database, statements, { readonly = false } = {}) {
  const result = spawnSync('python', ['-u', script, '--probe', database, readonly ? 'ro' : 'rw'], {
    input: JSON.stringify(statements), encoding: 'utf8', timeout: 15000, windowsHide: true,
    env: { ...process.env, PYTHONUTF8: '1' },
  })
  if (result.status !== 0) throw new Error(`SQLite oracle failed (${result.status}): ${result.error?.message ?? result.stderr}`)
  try {
    return JSON.parse(result.stdout)
  } catch (error) {
    throw new Error('SQLite oracle returned an invalid JSON response', { cause: error })
  }
}

export function platformSources(out) {
  const python = emit(out, 'sqlite-boundary.py', `import json, sqlite3, sys
from pathlib import Path

def connect(path, readonly=False):
    if readonly:
        return sqlite3.connect(Path(path).resolve().as_uri() + '?mode=ro', uri=True, isolation_level=None)
    return sqlite3.connect(path, isolation_level=None)

def execute(db, request):
    cursor = db.execute(request['sql'], request.get('args', []))
    columns = [item[0] for item in cursor.description] if cursor.description else []
    rows = cursor.fetchall() if cursor.description else []
    return {'columns': columns, 'rows': rows}

if sys.argv[1] == '--probe':
    with connect(sys.argv[2], sys.argv[3] == 'ro') as db:
        print(json.dumps([execute(db, item) for item in json.load(sys.stdin)]))
else:
    db = connect(sys.argv[1])
    try:
        for line in sys.stdin:
            try:
                request = json.loads(line)
                result = execute(db, request)
            except Exception as error:
                # Boundary errors remain explicit; never substitute an empty query.
                result = {'error': type(error).__name__ + ': ' + str(error)}
            print(json.dumps(result, ensure_ascii=False), flush=True)
    finally:
        db.close()
`)
  // Reuse the project's installed Groovy JSON boundary, adding only org.json APIs
  // used by this owner. Parsing failures retain JSONException semantics.
  const json = jsonAdapter()
    .replace('open class JSONObject {', 'class JSONException(message:String,cause:Throwable?=null):RuntimeException(message,cause)\nopen class JSONObject {')
    .replace('JsonSlurper().parseText(text) as Map<String,Any?>', 'parseObject(text)')
    .replace('fun get(k: String)=wrap(data.getValue(k))', 'fun get(k: String):Any? { if(!data.containsKey(k))throw JSONException("missing key");return wrap(data[k]) }')
    .replace('fun getString(k: String)=data.getValue(k) as String', 'fun getString(k: String)=get(k) as? String ?: throw JSONException("expected string")')
    .replace('fun getJSONObject(k: String)=wrap(data.getValue(k)) as JSONObject', 'fun getJSONObject(k: String)=get(k) as? JSONObject ?: throw JSONException("expected object")')
    .replace('fun optJSONObject(k: String)=data[k]?.let{wrap(it) as JSONObject}', 'fun optJSONObject(k: String)=data[k]?.let{wrap(it) as? JSONObject}')
    .replace('fun getJSONArray(k: String)=JSONArray(data.getValue(k) as Collection<*>)', 'fun getJSONArray(k: String)=get(k) as? JSONArray ?: throw JSONException("expected array")')
    .replace('val NULL: Any?=null', `val NULL: Any?=null
  @Suppress("UNCHECKED_CAST") fun parseObject(text:String):Map<String,Any?> = try { JsonSlurper().parseText(text) as? Map<String,Any?> ?: throw JSONException("expected object") } catch(e:JSONException){throw e} catch(e:Exception){throw JSONException("invalid JSON",e)}`)
    .replace('constructor(){data=arrayListOf()}', `constructor(){data=arrayListOf()}
 constructor(text:String){data=try { (JsonSlurper().parseText(text) as? List<*>)?.toMutableList() ?: throw JSONException("expected array") } catch(e:JSONException){throw e} catch(e:Exception){throw JSONException("invalid JSON",e)}}`)
    .replace('data=if(values is MutableList<*>) values as MutableList<Any?> else values.toMutableList()', 'data=values.map{when(it){is JSONObject->it.data;is JSONArray->it.data;else->it}}.toMutableList()')
    .replace('fun getJSONObject(i: Int)=JSONObject.wrap(data[i]) as JSONObject', 'fun getJSONObject(i: Int)=JSONObject.wrap(data[i]) as? JSONObject ?: throw JSONException("expected object")')
    .replace('fun getString(i: Int)=data[i] as String', 'fun getString(i: Int)=data[i] as? String ?: throw JSONException("expected string")\n fun getJSONArray(i:Int)=JSONObject.wrap(data[i]) as? JSONArray ?: throw JSONException("expected array")')
  const sources = [emit(out, 'Json.kt', json)]
  const put = (name, text) => sources.push(emit(out, name, text))
  put('Context.kt', `package android.content
import java.io.File
import java.util.Properties
open class Context(val dataDir:File) {
 open val applicationContext:Context get()=this
 fun getSharedPreferences(name:String,mode:Int)=SharedPreferences(File(dataDir,"host-prefs-"+name+".properties"))
 companion object {const val MODE_PRIVATE=0}
}
class SharedPreferences(private val file:File){
 private fun load()=Properties().apply{if(file.exists())file.inputStream().use{load(it)}}
 fun getString(key:String,fallback:String?):String?=load().getProperty(key)?:fallback
 fun edit()=Editor(file,load())
 class Editor(private val file:File,private val values:Properties){
  fun putString(key:String,value:String):Editor{values.setProperty(key,value);return this}
  fun commit():Boolean{file.outputStream().use{values.store(it,"synthetic host preferences")};return true}
 }
}
`)
  put('Cursor.kt', `package android.database
import java.io.Closeable
class Cursor(val columnNames:Array<String>,private val rows:List<List<Any?>>):Closeable{
 private var at=-1
 fun moveToNext():Boolean{at++;return at<rows.size}
 fun isNull(i:Int)=rows[at][i]==null
 fun getString(i:Int)=rows[at][i].toString()
 override fun close(){}
}
`)
  put('SQLite.kt', `package android.database.sqlite
import android.database.Cursor
import org.json.JSONObject
import org.json.JSONArray
import java.io.*
import java.util.concurrent.TimeUnit
class SQLiteException(message:String):RuntimeException(message)
object HostSql {lateinit var script:String;var fault=""}
class SQLiteDatabase private constructor(path:String):Closeable{
 private val process=ProcessBuilder("python","-u",HostSql.script,path).apply{environment()["PYTHONUTF8"]="1"}.start()
 private val writer=process.outputStream.bufferedWriter(Charsets.UTF_8)
 private val reader=process.inputStream.bufferedReader(Charsets.UTF_8)
 private var success=false
 private fun send(sql:String,args:List<Any?> = emptyList()):JSONObject{
  writer.write(JSONObject().put("sql",sql).put("args",JSONArray(args)).toString());writer.newLine();writer.flush()
  val text=reader.readLine()?:throw SQLiteException("SQLite boundary EOF: "+process.errorStream.bufferedReader().readText())
  val result=JSONObject(text)
  if(result.has("error"))throw SQLiteException(result.getString("error"))
  return result
 }
 fun execSQL(sql:String){send(sql)}
 fun execSQL(sql:String,args:Array<out Any?>){send(sql,args.toList())}
 fun rawQuery(sql:String,args:Array<String>?):Cursor{
  if(HostSql.fault=="query-error" && sql.startsWith("SELECT key,json FROM native_core_reading"))throw SQLiteException("injected source page read failure")
  val result=send(sql,args?.toList()?:emptyList())
  val columns=result.getJSONArray("columns").data.map{it.toString()}.toTypedArray()
  @Suppress("UNCHECKED_CAST") val rows=result.getJSONArray("rows").data as List<List<Any?>>
  return Cursor(columns,rows)
 }
 fun beginTransaction(){success=false;send("BEGIN IMMEDIATE")}
 fun setTransactionSuccessful(){success=true}
 fun endTransaction(){
  val fault=HostSql.fault;HostSql.fault=""
  if(success && fault=="rollback-before-ack") {send("ROLLBACK");throw SQLiteException("injected rolled-back COMMIT outcome")}
  send(if(success)"COMMIT" else "ROLLBACK")
  if(success && fault=="commit-before-ack")throw SQLiteException("injected committed COMMIT acknowledgement loss")
 }
 override fun close(){writer.close();if(!process.waitFor(3,TimeUnit.SECONDS)){process.destroyForcibly();throw SQLiteException("SQLite child did not close")};if(process.exitValue()!=0)throw SQLiteException("SQLite child failed: "+process.errorStream.bufferedReader().readText())}
 companion object {fun openOrCreateDatabase(path:String,factory:Any?)=SQLiteDatabase(path)}
}
`)
  put('App.kt', 'package android.app\nclass Activity(dataDir:java.io.File):android.content.Context(dataDir)\n')
  put('Annotations.kt', 'package app.tauri.annotation\nannotation class Command\nannotation class TauriPlugin\n')
  put('Plugin.kt', `package app.tauri.plugin
import org.json.JSONObject
open class Plugin(activity:android.app.Activity)
class JSObject(text:String):JSONObject(text)
class Invoke(private val args:JSONObject){
 fun getArgs()=args
 fun resolve(value:JSObject){}
 fun reject(message:String,code:String){}
}
`)
  put('StateHost.kt', `package io.pagewise.reader
import android.content.Context
import android.database.sqlite.HostSql
import java.io.File
import org.json.JSONObject
fun main(args:Array<String>){
 HostSql.script=args[0]
 for(line in generateSequence(::readLine)){
  val response=try{
   val request=JSONObject(line)
   HostSql.fault=request.optString("fault")
   val context=Context(File(request.getString("directory")))
   val root=if(request.has("root"))request.getString("root") else null
   val result=NativeStateStore(context,root).use{it.command(request.getString("action"),request.optJSONObject("payload")?:JSONObject())}
   JSONObject().put("ok",true).put("result",result)
  }catch(error:Exception){
   JSONObject().put("ok",false).put("code",if(error is NativeStateFailure)error.code else "host_unexpected_exception").put("type",error.javaClass.name).put("message",error.message?:"")
  }finally{HostSql.fault=""}
  println(response.toString())
 }
}
`)
  return { python, sources }
}
