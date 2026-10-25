import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, join, delimiter } from 'node:path'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { compile, toolchain } from './native-import-test-tools.mjs'

const [serial, label, expectation] = process.argv.slice(2)
assert.ok(serial && /^[\w-]+$/.test(label), 'Usage: node test-native-sql-bootstrap-android.mjs SERIAL unique-label [--expect-failure]')
const root = resolve(import.meta.dirname, '../..')
const out = join(root, '.cache/pw17-bootstrap-fix-20261023', 'android-' + label)
assert.ok(!existsSync(out), 'Keep prior verification evidence immutable')
mkdirSync(out, { recursive: true })
const sdk = join(homedir(), 'AppData/Local/Android/Sdk')
const jdk = 'C:/Program Files/Java/jdk-21.0.12.1'
process.env.JAVA_HOME = jdk
process.env.PATH = join(jdk, 'bin') + delimiter + process.env.PATH
const android = join(sdk, 'platforms/android-32/android.jar')
const adb = join(sdk, 'platform-tools/adb.exe')
function run(name, executable, args, timeout = 70000, allowFailure = false) {
  const p = spawnSync(executable, args, { encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 })
  writeFileSync(join(out, name + '.log'), JSON.stringify({ exit: p.status, error: p.error?.message }) + '\n' + (p.stdout ?? '') + (p.stderr ?? ''))
  if (!allowFailure) assert.equal(p.status, 0, p.error?.message ?? p.stdout + p.stderr)
  return p
}
compile(out, ['CanonicalDatabase.kt', 'NativeStateStore.kt', 'NativeSqlDatabase.kt'].map(p => join(root, 'reader/src-tauri/android', p)).concat(join(root, 'reader/scripts/fixtures/NativeSqlBootstrapMain.kt')), [android])
const classes = join(out, 'classes.jar'), jar = join(jdk, 'bin/jar.exe')
run('jar-classes', jar, ['cf', classes, '-C', join(out, 'classes'), '.'])
const dex = join(out, 'dex'); mkdirSync(dex)
run('dex', join(jdk, 'bin/java.exe'), ['-cp', join(sdk, 'build-tools/36.0.0/lib/d8.jar'), 'com.android.tools.r8.D8', '--min-api', '24', '--lib', android, '--output', dex, classes, toolchain().stdlib])
const harness = join(out, 'harness.jar')
run('jar-dex', jar, ['cf', harness, '-C', dex, '.'])
const deviceJar = '/data/local/tmp/pagewise-pw17-bootstrap-' + label + '.jar'
run('push', adb, ['-s', serial, 'push', harness, deviceJar])
const p = run('framework', adb, ['-s', serial, 'shell', 'env', 'CLASSPATH=' + deviceJar, 'app_process', '/system/bin', 'io.pagewise.reader.NativeSqlBootstrapMainKt', '/data/local/tmp/pagewise-pw17-bootstrap-' + label + '-fixtures'], 70000, true)
const line = p.stdout.split(/\r?\n/).find(l => l.startsWith('{') && l.includes('"results"'))
assert.ok(line, p.stdout + p.stderr)
let result
try { result = JSON.parse(line) } catch (cause) { throw new Error('Invalid Android harness JSON receipt', { cause }) }
writeFileSync(join(out, 'result.json'), JSON.stringify({ serial, expectedFailure: expectation === '--expect-failure', exit: p.status, ...result }, null, 2))
if (expectation === '--expect-failure') {
  assert.ok(result.failures > 0 && result.results.some(r => r.name.startsWith('native state migration') && !r.passed), 'Baseline must reproduce the actual bootstrap-order failure')
} else {
  assert.equal(p.status, 0, p.stdout + p.stderr)
  assert.equal(result.failures, 0)
}
console.log(JSON.stringify({ serial, label, expectedFailure: expectation === '--expect-failure', ...result }))
