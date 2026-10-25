import assert from 'node:assert/strict'
import { mkdirSync, existsSync, writeFileSync } from 'node:fs'
import { resolve, join, delimiter } from 'node:path'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { compile, toolchain, files, modules } from './native-import-test-tools.mjs'

const [serial, label, expectation] = process.argv.slice(2)
assert.match(serial ?? '', /^emulator-\d+$/, 'Only a task-owned test emulator is allowed')
assert.match(label ?? '', /^[\w-]+$/)
const root = resolve(import.meta.dirname, '../..'), out = join(root, '.cache/eink-ui-s1-20261023', 'android-' + label)
assert.ok(!existsSync(out), 'Keep old framework evidence immutable')
mkdirSync(out, { recursive: true })
const sdk = join(homedir(), 'AppData/Local/Android/Sdk'), jdk = 'C:/Program Files/Java/jdk-21.0.12.1'
process.env.JAVA_HOME = jdk; process.env.PATH = join(jdk, 'bin') + delimiter + process.env.PATH
const android = join(sdk, 'platforms/android-32/android.jar'), adb = join(sdk, 'platform-tools/adb.exe')
function run(name, cmd, args, allowFailure = false) {
  const p = spawnSync(cmd, args, { encoding: 'utf8', timeout: 70000, maxBuffer: 8 * 1024 * 1024 })
  writeFileSync(join(out, name + '.log'), JSON.stringify({ exit: p.status, error: p.error?.message }) + '\n' + (p.stdout ?? '') + (p.stderr ?? ''))
  if (!allowFailure) assert.equal(p.status, 0, p.error?.message ?? p.stdout + p.stderr)
  return p
}
const identity = run('identity', adb, ['-s', serial, 'emu', 'avd', 'name'])
assert.equal(identity.stdout.split(/\r?\n/)[0].trim(), 'EinkNativeUi32')
const aar = files(join(modules, 'androidx.core/core/1.13.1'), '.aar'); assert.equal(aar.length, 1)
const core = join(out, 'path-parser.jar')
run('core-types', 'python', ['-X', 'utf8', '-c', "import zipfile,io,sys;z=zipfile.ZipFile(sys.argv[1]);c=zipfile.ZipFile(io.BytesIO(z.read('classes.jar')));o=zipfile.ZipFile(sys.argv[2],'w');[(o.writestr(n,c.read(n))) for n in c.namelist() if n.startswith('androidx/core/graphics/PathParser') and n.endswith('.class')];o.close()", aar[0], core])
compile(out, ['NativeUi.kt','NativeUiMetrics.kt'].map(p => join(root, 'reader/src-tauri/android', p)).concat(join(root, 'reader/scripts/fixtures/NativeEinkViewMain.kt')), [android, core])
const jar = join(jdk, 'bin/jar.exe'), classes = join(out, 'classes.jar'), dex = join(out, 'dex')
run('classes', jar, ['cf', classes, '-C', join(out, 'classes'), '.']); mkdirSync(dex)
run('dex', join(jdk, 'bin/java.exe'), ['-cp', join(sdk, 'build-tools/36.0.0/lib/d8.jar'), 'com.android.tools.r8.D8', '--min-api', '24', '--lib', android, '--output', dex, classes, toolchain().stdlib, core])
const harness = join(out, 'harness.jar');run('jar', jar, ['cf', harness, '-C', dex, '.'])
const remote = '/data/local/tmp/pagewise-eink-s1-' + label
run('push', adb, ['-s', serial, 'push', harness, remote + '.jar'])
const p = run('framework', adb, ['-s', serial, 'shell', 'env', 'CLASSPATH=' + remote + '.jar', 'app_process', '/system/bin', 'io.pagewise.reader.NativeEinkViewMainKt', remote + '-fixtures'], true)
const line = p.stdout.split(/\r?\n/).find(s => s.startsWith('{') && s.includes('"cases"'));assert.ok(line, p.stdout + p.stderr)
let result
try { result = JSON.parse(line) } catch (cause) { throw new Error('Invalid Android View regression receipt', { cause }) }
writeFileSync(join(out, 'result.json'), JSON.stringify({ serial, exit: p.status, expectedFailure: expectation === '--expect-failure', ...result }, null, 2))
if (expectation === '--expect-failure') assert.ok(result.failures > 0, 'Old ImageView integration must reproduce the reported scale problem')
else { assert.equal(p.status, 0, p.stdout + p.stderr); assert.equal(result.failures, 0) }
run('images', adb, ['-s', serial, 'pull', remote + '-fixtures', join(out, 'images')])
console.log(JSON.stringify({ serial, label, failures: result.failures, cases: result.cases.length, expectedFailure: expectation === '--expect-failure' }))
