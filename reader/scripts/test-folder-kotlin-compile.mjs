import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')

test('all authoritative Kotlin templates compile with the real project-local Kotlin 2.4.20 Android dependency graph', { timeout: 150000 }, () => {
  const project = join(root, 'src-tauri/gen/android')
  const templates = join(root, 'src-tauri/android')
  const target = join(project, 'app/src/main/java/io/pagewise/reader')
  for (const name of readdirSync(templates).filter(name => name.endsWith('.kt'))) {
    assert.deepEqual(readFileSync(join(target, name)), readFileSync(join(templates, name)), `${name}: run android:prepare before compiling`)
  }
  assert.match(readFileSync(join(project, 'build.gradle.kts'), 'utf8'), /kotlin-gradle-plugin:2\.4\.20/)
  const output = resolve(root, '../.cache/native-import-20261021/kotlin-full')
  mkdirSync(output, { recursive: true })
  const args = ['--offline', '--no-daemon', ':app:compileUniversalDebugKotlin', '-x', ':app:rustBuildUniversalDebug']
  const command = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : './gradlew'
  const argv = process.platform === 'win32' ? ['/c', 'gradlew.bat', ...args] : args
  const env = { ...process.env, ANDROID_HOME: process.env.ANDROID_HOME || resolve(process.env.USERPROFILE, 'AppData/Local/Android/Sdk') }
  const compile = spawnSync(command, argv, { cwd: project, env, encoding: 'utf8', timeout: 140000 })
  writeFileSync(join(output, 'compile.log'), (compile.stdout ?? '') + (compile.stderr ?? ''))
  assert.equal(compile.status, 0, compile.error?.message ?? compile.stdout + compile.stderr)
  assert.ok(readFileSync(join(project, 'app/build/tmp/kotlin-classes/universalDebug/io/pagewise/reader/NativeBookImporter.class')).byteLength > 0)
  console.log('Real Android/AndroidX/Tauri/PDFium/CommonMark compile passed; this is not device runtime acceptance.')
})
