import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve, delimiter } from 'node:path'
import { homedir } from 'node:os'
import { spawnSync } from 'node:child_process'

export const root = resolve(import.meta.dirname, '..')
export const cache = join(homedir(), '.gradle/caches')
export const modules = join(cache, 'modules-2/files-2.1')
export function files(dir, suffix = '.jar') {
  return existsSync(dir) ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter(e => e.isFile() && e.name.endsWith(suffix)).map(e => join(e.parentPath, e.name)) : []
}
export function artifact(group, name, version) {
  const found = files(join(modules, group, name, version)).filter(p => p.endsWith(`${name}-${version}.jar`))
  assert.equal(found.length, 1, `Expected installed ${group}:${name}:${version}; run the project Gradle build first, no test installs dependencies`)
  return found[0]
}
export function toolchain() {
  const version = readFileSync(join(root, 'src-tauri/android/kotlin-version.txt'), 'utf8').trim()
  assert.equal(version, '2.4.20')
  const stdlib = artifact('org.jetbrains.kotlin', 'kotlin-stdlib', version)
  const compiler = [artifact('org.jetbrains.kotlin', 'kotlin-compiler-embeddable', version), stdlib,
    artifact('org.jetbrains.kotlin', 'kotlin-build-tools-api', version),
    artifact('org.jetbrains.kotlin', 'kotlin-script-runtime', version),
    artifact('org.jetbrains.kotlin', 'kotlin-reflect', '1.6.10'),
    artifact('org.jetbrains.kotlin', 'kotlin-daemon-embeddable', version),
    artifact('org.jetbrains.kotlinx', 'kotlinx-coroutines-core-jvm', '1.8.0'),
    ...files(join(modules, 'org.jetbrains/annotations')).filter(p => !p.endsWith('-sources.jar'))]
  return { version, stdlib, compiler }
}
export function runJvm(out, label, args, timeout = 70000) {
  mkdirSync(out, { recursive: true })
  const started = performance.now()
  const run = spawnSync('java', args, { encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true })
  writeFileSync(join(out, `${label}.log`), JSON.stringify({ exitCode: run.status, elapsedMs: performance.now() - started, error: run.error?.message }) + '\n' + (run.stdout ?? '') + (run.stderr ?? ''))
  assert.equal(run.status, 0, run.error?.message ?? run.stdout + run.stderr)
  return run.stdout
}
export function compile(out, sources, dependencies = []) {
  const t = toolchain(), classes = join(out, 'classes')
  mkdirSync(out, { recursive: true })
  const args = ['-no-stdlib', '-no-reflect', '-jvm-target', '1.8', '-classpath', [t.stdlib, ...dependencies].join(delimiter), '-d', classes, ...sources]
  const argFile = join(out, 'compile.args')
  writeFileSync(argFile, args.map(a => JSON.stringify(a)).join('\n'))
  runJvm(out, 'compile', ['-cp', t.compiler.join(delimiter), 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '@' + argFile])
  return [classes, t.stdlib, ...dependencies].join(delimiter)
}
export function emit(out, name, text) {
  mkdirSync(out, { recursive: true })
  const path = join(out, name)
  writeFileSync(path, text)
  return path
}
export function uploadOwnershipSource() {
  const source = readFileSync(join(root, 'src-tauri/android/ExportPlugin.kt'), 'utf8')
  const start = source.indexOf('internal object NativeImportUploads {'), end = source.indexOf('@TauriPlugin', start)
  assert.ok(start >= 0 && end > start)
  return 'package io.pagewise.reader\n' + source.slice(start, end)
}
export function jsonAdapter() {
  return `package org.json
import groovy.json.JsonSlurper
import groovy.json.JsonOutput
open class JSONObject {
 val data: MutableMap<String,Any?>
 constructor() { data=linkedMapOf() }
 constructor(text: String) { @Suppress("UNCHECKED_CAST") val parsed=JsonSlurper().parseText(text) as Map<String,Any?>;data=parsed.toMutableMap() }
 open fun put(k: String,v: Any?): JSONObject { data[k]=when(v){is JSONObject->v.data;is JSONArray->v.data;else->v};return this }
 fun get(k: String)=wrap(data.getValue(k))
 fun keys()=data.keys.iterator()
 fun getString(k: String)=data.getValue(k) as String
 fun getInt(k: String)=(data.getValue(k) as Number).toInt()
 fun getLong(k: String)=(data.getValue(k) as Number).toLong()
 fun getBoolean(k: String)=data.getValue(k) as Boolean
 fun optString(k: String,d: String="")=data[k] as? String ?: d
 fun optBoolean(k: String,d: Boolean=false)=data[k] as? Boolean ?: d
 fun getJSONObject(k: String)=wrap(data.getValue(k)) as JSONObject
 fun optJSONObject(k: String)=data[k]?.let{wrap(it) as JSONObject}
 fun getJSONArray(k: String)=JSONArray(data.getValue(k) as Collection<*>)
 fun isNull(k: String)=data[k]==null
 fun remove(k: String)=data.remove(k)
 fun has(k: String)=data.containsKey(k)
 override fun toString()=JsonOutput.toJson(data)
 @Suppress("UNCHECKED_CAST") constructor(values: MutableMap<String,Any?>) { data=values }
 companion object {
  val NULL: Any?=null
  @Suppress("UNCHECKED_CAST") fun wrap(v:Any?):Any?=when(v){is MutableMap<*,*>->JSONObject(v as MutableMap<String,Any?>);is Collection<*>->JSONArray(v);else->v}
 }
}
class JSONArray {
 val data: MutableList<Any?>
 constructor(){data=arrayListOf()}
 @Suppress("UNCHECKED_CAST") constructor(values: Collection<*>){data=if(values is MutableList<*>) values as MutableList<Any?> else values.toMutableList()}
 fun put(v: Any?): JSONArray {data.add(when(v){is JSONObject->v.data;is JSONArray->v.data;else->v});return this}
 fun length()=data.size
 fun get(i: Int)=JSONObject.wrap(data[i])
 fun getString(i: Int)=data[i] as String
 fun getJSONObject(i: Int)=JSONObject.wrap(data[i]) as JSONObject
 override fun toString()=JsonOutput.toJson(data)
}
`
}
export function groovy() {
  const jars = files(join(homedir(), '.gradle/wrapper/dists')).filter(p => /groovy-(json-)?3\.0\.[0-9]+\.jar$/.test(p))
  assert.ok(jars.some(p => /groovy-json-/.test(p)))
  return jars
}
