import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, renameSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { androidVariantMetadata, prepareAndroidVariants } from './prepare-android-variants.mjs'

const generated = 'src-tauri/gen/android'
const gradlePath = `${generated}/app/build.gradle.kts`
const propertiesPath = `${generated}/app/tauri.properties`
const gradle = `android {
  namespace = "io.pagewise.reader"
  defaultConfig { applicationId = "io.pagewise.reader" }
  buildTypes {
    getByName("debug") {
      isDebuggable = true
      packaging { jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so") }
    }
    getByName("release") {
      isMinifyEnabled = true
    }
  }
}`
function fixture() {
  const dir = resolve(import.meta.dirname, '../../.cache/deployment-1.2-20261020/variant-fixtures')
  mkdirSync(dir, { recursive: true })
  const base = mkdtempSync(join(dir, 'case-'))
  const put = (path, data) => { mkdirSync(dirname(join(base, path)), { recursive: true }); writeFileSync(join(base, path), data) }
  put('package.json', JSON.stringify({ version: '1.2.0' }))
  put('src-tauri/tauri.conf.json', JSON.stringify({ identifier: 'io.pagewise.reader', version: '1.2.0', productName: '知页' }))
  put(gradlePath, gradle)
  put(propertiesPath, 'tauri.android.versionCode=1001000\r\ntauri.android.versionName=1.1.0\r\nkeep.unmanaged=yes\r\n')
  put(`${generated}/app/src/main/res/values/strings.xml`, '<resources><string name="app_name">知页</string></resources>')
  return { base, put, cleanup: () => rmSync(base, { recursive: true, force: true }) }
}
function snapshot(dir) {
  return Object.fromEntries(readdirSync(dir, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => {
    const path = join(e.parentPath, e.name)
    return [path.slice(dir.length), readFileSync(path).toString('base64')]
  }))
}

test('release keeps the product name and debug includes the complete package version', () => {
  assert.deepEqual(androidVariantMetadata('1.4.0'), { versionName: '1.4.0', versionCode: 1004000, releaseLabel: '知页', debugLabel: '知页 1.4.0 测试版' })
  assert.deepEqual(androidVariantMetadata('1.3.0'), { versionName: '1.3.0', versionCode: 1003000, releaseLabel: '知页', debugLabel: '知页 1.3.0 测试版' })
  assert.deepEqual(androidVariantMetadata('1.2.0'), { versionName: '1.2.0', versionCode: 1002000, releaseLabel: '知页', debugLabel: '知页 1.2.0 测试版' })
  assert.equal(androidVariantMetadata('1.3.2').debugLabel, '知页 1.3.2 测试版')
  for (const version of ['1.2', '01.2.0', '1.2.0-beta', '1.1000.0', '1.2.1000', '9999999.0.0', '0.0.0']) assert.throws(() => androidVariantMetadata(version))
})

test('prepare uses variant overlays, preserves base branding and unrelated config, and is idempotent', () => {
  const f = fixture()
  try {
    const metadata = prepareAndroidVariants(f.base)
    assert.equal(metadata.versionCode, 1002000)
    const app = join(f.base, generated, 'app')
    const currentGradle = readFileSync(join(f.base, gradlePath), 'utf8')
    assert.equal((currentGradle.match(/applicationIdSuffix/g) ?? []).length, 1)
    assert.match(currentGradle, /applicationIdSuffix = "\.debug"/)
    assert.match(currentGradle, /isMinifyEnabled = true/)
    const properties = readFileSync(join(f.base, propertiesPath), 'utf8')
    assert.match(properties, /versionName=1\.2\.0/); assert.match(properties, /versionCode=1002000/); assert.match(properties, /keep.unmanaged=yes/)
    assert.match(readFileSync(join(app, 'src/debug/res/values/pagewise_variant.xml'), 'utf8'), />知页 1\.2\.0 测试版</)
    assert.match(readFileSync(join(app, 'src/release/res/values/pagewise_variant.xml'), 'utf8'), />知页</)
    assert.equal(readFileSync(join(app, 'src/main/res/values/strings.xml'), 'utf8'), '<resources><string name="app_name">知页</string></resources>')
    const before = snapshot(f.base)
    prepareAndroidVariants(f.base)
    assert.deepEqual(snapshot(f.base), before)
  } finally { f.cleanup() }
})

for (const [name, path, value] of [
  ['mismatched root versions', 'package.json', '{"version":"1.1.0"}'],
  ['wrong identity', 'src-tauri/tauri.conf.json', '{"identifier":"wrong.app","version":"1.2.0","productName":"知页"}'],
  ['foreign debug suffix', gradlePath, gradle.replace('isDebuggable = true', 'applicationIdSuffix = ".foreign"\n isDebuggable = true')],
  ['dynamic suffix', gradlePath, gradle.replace('isDebuggable = true', 'applicationIdSuffix = someValue\n isDebuggable = true')],
  ['duplicate version properties', propertiesPath, 'tauri.android.versionName=1.1.0\ntauri.android.versionName=1.1.0\n'],
  ['conflicting label', `${generated}/app/src/debug/res/values/other.xml`, '<resources><string name="app_name">existing</string></resources>'],
]) {
  test(`${name} fails before any managed write`, () => {
    const f = fixture()
    try {
      f.put(path, value)
      const before = snapshot(f.base)
      assert.throws(() => prepareAndroidVariants(f.base))
      assert.deepEqual(snapshot(f.base), before)
    } finally { f.cleanup() }
  })
}

test('mid-commit failure restores bytes and removes newly created variant resources', () => {
  const f = fixture()
  try {
    const before = snapshot(f.base)
    let writes = 0
    assert.throws(() => prepareAndroidVariants(f.base, { replace(from, to) {
      if (++writes === 4) throw new Error('injected variant commit failure')
      renameSync(from, to)
    } }), /injected variant commit failure/)
    assert.deepEqual(snapshot(f.base), before)
    assert.equal(existsSync(join(f.base, generated, 'app/src/debug/res/values/pagewise_variant.xml')), false)
  } finally { f.cleanup() }
})

test('rollback failure is explicit and retains a recovery directory', () => {
  const f = fixture()
  try {
    let writes = 0
    assert.throws(() => prepareAndroidVariants(f.base, {
      replace(from, to) { if (++writes === 3) throw new Error('commit'); renameSync(from, to) },
      restore() { throw new Error('restore denied') },
    }), /rollback failed/)
    assert.equal(readdirSync(join(f.base, generated)).filter(n => n.startsWith('.pagewise-variants-')).length, 1)
  } finally { f.cleanup() }
})

test('project root metadata agrees and each Android build entry prepares both variants', () => {
  const root = resolve(import.meta.dirname, '..')
  let pkg, lock, config
  try {
    pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))
    config = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8'))
  } catch (error) {
    assert.fail(`Project metadata must parse: ${error.message}`)
  }
  const cargo = readFileSync(join(root, 'src-tauri/Cargo.toml'), 'utf8')
  const cargoLock = readFileSync(join(root, 'src-tauri/Cargo.lock'), 'utf8')
  for (const version of [lock.version, lock.packages[''].version, config.version, /^version = "([^"]+)"/m.exec(cargo)?.[1], /\[\[package\]\]\r?\nname = "pagewise"\r?\nversion = "([^"]+)"/.exec(cargoLock)?.[1]]) assert.equal(version, pkg.version)
  for (const key of ['android:prepare', 'android:dev', 'android:build', 'android:build:release']) assert.match(pkg.scripts[key], /prepare-android-project\.mjs && node scripts\/prepare-android-variants\.mjs/)
})
