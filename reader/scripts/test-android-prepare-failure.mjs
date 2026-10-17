import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { prepareAndroidProject } from './prepare-android-project.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const generated = 'src-tauri/gen/android'
const activity = `${generated}/app/src/main/java/io/pagewise/reader/MainActivity.kt`
const strings = `${generated}/app/src/main/res/values/strings.xml`
const manifest = `${generated}/app/src/main/AndroidManifest.xml`
const template = 'src-tauri/android/MainActivity.kt'
const buildBridge = `${generated}/buildSrc/src/main/java/io/pagewise/reader/kotlin/BuildTask.kt`
const legacyBridge = 'val executable = """npm""";\nval args = listOf("run", "--", "tauri", "android", "android-studio-script");\n'
const permission = '<uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />'
const xml = `<manifest xmlns:android="http://schemas.android.com/apk/res/android"><uses-permission android:name="android.permission.INTERNET" />${permission}<application><provider android:name="androidx.core.content.FileProvider" android:authorities="\${applicationId}.fileprovider" /></application></manifest>`

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'pagewise-android-prepare-'))
  const put = (path, value) => { mkdirSync(dirname(join(base, path)), { recursive: true }); writeFileSync(join(base, path), value) }
  for (const path of ['package.json', 'src-tauri/tauri.conf.json', template]) put(path, readFileSync(join(root, path)))
  put(buildBridge, legacyBridge)
  cpSync(join(root, 'src-tauri/icons/android'), join(base, 'src-tauri/icons/android'), { recursive: true })
  put(activity, 'old activity\r\n')
  put(strings, '<resources><string name="app_name">old</string><string name="main_activity_title">old</string></resources>')
  put(manifest, xml)
  put(`${generated}/app/src/main/res/xml/file_paths.xml`, '<paths><cache-path name="cache" path="." /></paths>')
  put(`${generated}/app/src/main/res/mipmap-mdpi/ic_launcher.png`, 'old icon')
  return { base, put, cleanup: () => rmSync(base, { recursive: true, force: true }) }
}

function snapshot(directory) {
  return Object.fromEntries(readdirSync(directory, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => {
    const path = join(entry.parentPath, entry.name)
    return [path.slice(directory.length), readFileSync(path).toString('base64')]
  }))
}

for (const [name, path, value] of [
  ['missing application-name resources', strings, '<resources><string name="other">old</string></resources>'],
  ['malformed strings XML', strings, '<resources><string name="app_name">old</resources>'],
  ['duplicate strings', strings, '<resources><string name="app_name">a</string><string name="app_name">b</string><string name="main_activity_title">c</string></resources>'],
  ['mismatched template package', template, 'package wrong.identity\nclass MainActivity : TauriActivity() {}'],
  ['truncated template', template, 'package io.pagewise.reader\n'],
  ['missing FileProvider', manifest, '<manifest><application /></manifest>'],
  ['malformed manifest', manifest, xml.replace('</application>', '')],
  ['unsupported native build bridge', buildBridge, 'val args = listOf("run", "unknown");'],
  ['unexpected trailing bridge statement', buildBridge, legacyBridge.replace(');', '); unexpectedCall()')],
  ['duplicate bridge argument declarations', buildBridge, legacyBridge + legacyBridge],
  ['wrong Android npm entry', 'package.json', JSON.stringify({ scripts: { android: 'unsupported-cli' } })],
]) {
  test(`${name}: no generated file changes`, () => {
    const { base, put, cleanup } = fixture()
    try {
      put(path, value)
      const before = snapshot(join(base, generated))
      assert.throws(() => prepareAndroidProject(base))
      assert.deepEqual(snapshot(join(base, generated)), before)
    } finally { cleanup() }
  })
}

test('staged commit failure restores all existing bytes and removes newly created files', () => {
  const { base, cleanup } = fixture()
  try {
    const before = snapshot(join(base, generated))
    let count = 0
    assert.throws(() => prepareAndroidProject(base, { replace(from, to) {
      if (++count === 7) throw new Error('injected commit failure')
      renameSync(from, to)
    } }), /injected commit failure/)
    assert.deepEqual(snapshot(join(base, generated)), before)
    assert.equal(readdirSync(join(base, generated)).some(name => name.startsWith('.pagewise-prepare-')), false)
  } finally { cleanup() }
})

test('rollback failures are explicit and retain recovery files', () => {
  const { base, cleanup } = fixture()
  try {
    let count = 0
    assert.throws(() => prepareAndroidProject(base, {
      replace(from, to) {
        if (++count === 27) throw new Error('commit failed')
        renameSync(from, to)
      },
      restore() { throw new Error('restore denied') },
    }), /rollback failed:.*restore denied.*recovery files:/)
    assert.ok(readdirSync(join(base, generated)).some(name => name.startsWith('.pagewise-prepare-')))
  } finally { cleanup() }
})

test('successful prepare retains branding, FileProvider, INTERNET and unmanaged resources, and is idempotent', () => {
  const { base, cleanup } = fixture()
  try {
    const filePaths = join(base, generated, 'app/src/main/res/xml/file_paths.xml')
    const previousPaths = readFileSync(filePaths)
    prepareAndroidProject(base)
    assert.deepEqual(readFileSync(join(base, activity)), readFileSync(join(root, template)))
    const bridge = readFileSync(join(base, buildBridge), 'utf8')
    assert.match(bridge, /listOf\("run", "--", "android", "android-studio-script"\)/)
    assert.doesNotMatch(bridge, /"tauri", "android"/)
    const pkg = JSON.parse(readFileSync(join(base, 'package.json'), 'utf8'))
    assert.equal(pkg.scripts.android, 'tauri android')
    assert.equal(pkg.scripts.tauri, undefined, 'do not revive the desktop-capable generic entry')
    assert.match(readFileSync(join(base, strings), 'utf8'), />知页</)
    assert.equal(readFileSync(join(base, manifest), 'utf8'), xml.replace(permission, ''))
    assert.deepEqual(readFileSync(filePaths), previousPaths)
    const icons = join(base, 'src-tauri/icons/android')
    for (const [path, bytes] of Object.entries(snapshot(icons))) {
      assert.equal(readFileSync(join(base, generated, 'app/src/main/res', path), 'base64'), bytes)
    }
    const prepared = snapshot(join(base, generated))
    prepareAndroidProject(base)
    assert.deepEqual(snapshot(join(base, generated)), prepared)
    assert.equal(existsSync(join(root, 'scripts/patch-android-project.mjs')), false)
  } finally { cleanup() }
})

for (const [name, bridge] of [
  ['semicolon-free legacy bridge', legacyBridge.replaceAll(';', '')],
  ['semicolon-free prepared bridge', legacyBridge.replaceAll(';', '').replace('"tauri", "android"', '"android"')],
]) {
  test(`${name}: supports normal Kotlin formatting without reviving generic npm entry`, () => {
    const { base, put, cleanup } = fixture()
    try {
      put(buildBridge, bridge)
      prepareAndroidProject(base)
      const output = readFileSync(join(base, buildBridge), 'utf8')
      assert.match(output, /listOf\("run", "--", "android", "android-studio-script"\)/)
      assert.doesNotMatch(output, /"tauri", "android"/)
      const before = snapshot(join(base, generated))
      prepareAndroidProject(base)
      assert.deepEqual(snapshot(join(base, generated)), before)
    } finally { cleanup() }
  })
}

test('native allowlist is exact and Android bridge excludes only updater functionality', () => {
  const lib = readFileSync(join(root, 'src-tauri/src/lib.rs'), 'utf8')
  const list = lib.match(/const SUPPORTED_EXTENSIONS:[\s\S]*?= &\[([\s\S]*?)\];/)[1]
  assert.deepEqual([...list.matchAll(/"([^"]+)"/g)].map(match => match[1]), ['epub', 'mobi', 'pdf', 'txt', 'md', 'markdown'])
  assert.doesNotMatch(lib.slice(lib.indexOf('fn is_supported_path'), lib.indexOf('fn supported_paths')), /fb2|ends_with/)
  const kotlin = readFileSync(join(root, template), 'utf8')
  assert.doesNotMatch(kotlin, /Updater|[Ii]nstall|updatesDir|FileProvider|\bThread\s*\{/)
  for (const value of ['LightReadInsets', 'setImmersive', 'setKeepScreenOn', 'setBarsDark', 'onApplyWindowInsets']) assert.ok(kotlin.includes(value), value)
})
