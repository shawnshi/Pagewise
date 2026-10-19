// Read-only use of the installed Kotlin/Android caches; all outputs are lane-local.
import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve, delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'

const root = fileURLToPath(new URL('../../', import.meta.url))
const out = join(root, '.cache/performance-20261019/kotlin')
mkdirSync(out, { recursive: true })
const home = homedir()
const modules = join(home, '.gradle/caches/modules-2/files-2.1')
function files(dir, suffix) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? files(path, suffix) : path.endsWith(suffix) ? [path] : []
  })
}
const jar = (group, artifact, version) => {
  const found = files(join(modules, group, artifact, version), '.jar')
  if (found.length !== 1) throw Error(`Expected one cached ${artifact}:${version}, found ${found.length}`)
  return found[0]
}
const stdlib = jar('org.jetbrains.kotlin', 'kotlin-stdlib', '1.9.25')
const compiler = [
  jar('org.jetbrains.kotlin', 'kotlin-compiler-embeddable', '1.9.25'), stdlib,
  jar('org.jetbrains.kotlin', 'kotlin-script-runtime', '1.9.25'),
  jar('org.jetbrains.kotlin', 'kotlin-reflect', '1.6.10'),
  jar('org.jetbrains.intellij.deps', 'trove4j', '1.0.20200330'),
  ...files(join(modules, 'org.jetbrains', 'annotations'), '.jar'),
]
function run(label, args) {
  const start = performance.now()
  const result = spawnSync('java', args, { cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true })
  const receipt = { command: ['java', ...args], exitCode: result.status, signal: result.signal, error: result.error?.message, elapsedMs: performance.now() - start }
  writeFileSync(join(out, `${label}.log`), `${JSON.stringify(receipt)}\n${result.stdout ?? ''}${result.stderr ?? ''}`)
  console.log(`${label}: exit=${result.status}, ${receipt.elapsedMs.toFixed(1)}ms; ${join(out, `${label}.log`)}`)
  if (result.status !== 0) { console.error(result.stderr || result.error); process.exit(result.status ?? 1) }
}
const mode = process.argv[2] ?? 'compile'
if (mode === 'compile') {
  const cargo = join(home, '.cargo/registry/src/index.crates.io-1949cf8c6b5b557f')
  const tauri = join(cargo, 'tauri-2.11.5/mobile/android/build/intermediates/compile_library_classes_jar/debug/bundleLibCompileToJarDebug/classes.jar')
  // The generated scaffold is intentionally not copied (2.9GB). Only its existing
  // MainActivity/R bytecode and dependency jars are read by the standalone compiler.
  const localProject = join(root, 'reader/src-tauri/gen/android')
  const project = existsSync(localProject) ? localProject : resolve(root, '../../reader/src-tauri/gen/android')
  const android = join(home, 'AppData/Local/Android/Sdk/platforms/android-32/android.jar')
  const transformed = files(join(home, '.gradle/caches/8.14.3/transforms'), 'classes.jar')
  const app = join(project, 'app/build/tmp/kotlin-classes/universalDebug')
  const resources = join(project, 'app/build/intermediates/compile_and_runtime_not_namespaced_r_class_jar/universalDebug/processUniversalDebugResources/R.jar')
  const lifecycle = jar('androidx.lifecycle', 'lifecycle-common', '2.5.1')
  const classpath = [android, stdlib, tauri, app, resources, lifecycle, ...transformed]
  for (const file of classpath) if (!existsSync(file)) throw Error(`Missing read-only compile input: ${file}`)
  writeFileSync(join(out, 'compile-inputs.json'), JSON.stringify(classpath, null, 2))
  run('compile', ['-cp', compiler.join(delimiter), 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-jvm-target', '1.8', '-classpath', classpath.join(delimiter), '-d', join(out, 'android-classes'), join(root, 'reader/src-tauri/android/NativeSpeechService.kt'), join(root, 'reader/src-tauri/android/SystemTtsPlugin.kt')])
} else if (mode === 'host') {
  const { generateHost } = await import('./native-speech-kotlin-host.mjs')
  const groovy = files(join(home, '.gradle/wrapper/dists'), '.jar').filter(path => /groovy-(json-)?3\.0\.\d+\.jar$/.test(path))
  if (!groovy.some(path => /groovy-json-/.test(path))) throw Error('Installed Gradle Groovy JSON jars unavailable; no dependencies will be installed')
  const baseline = readFileSync(join(out, '../baseline/reader/src-tauri/android/NativeSpeechService.kt'), 'utf8')
  const source = generateHost(readFileSync(join(root, 'reader/src-tauri/android/NativeSpeechService.kt'), 'utf8'), out, baseline)
  const classpath = [stdlib, ...groovy]
  run('host-compile', ['-cp', compiler.join(delimiter), 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-jvm-target', '1.8', '-classpath', classpath.join(delimiter), '-d', join(out, 'host-classes'), ...source])
  run('host-run', ['-cp', [join(out, 'host-classes'), ...classpath].join(delimiter), 'io.pagewise.reader.NativeSpeechHostKt', join(out, 'synthetic')])
} else throw Error(`Unknown mode: ${mode}`)
