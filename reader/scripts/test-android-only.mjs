import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, readFileSync, readdirSync, mkdirSync, cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import ts from 'typescript'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = path => readFileSync(join(root, path), 'utf8')
const json = path => {
  try { return JSON.parse(read(path)) }
  catch (error) { throw new Error(`Invalid contract file ${path}: ${error.message}`, { cause: error }) }
}
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? files(path) : [path]
  })
}
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex')

test('Android is the only native application/bundle target', () => {
  const config = json('src-tauri/tauri.conf.json')
  assert.equal(config.identifier, 'io.pagewise.reader')
  assert.equal(config.productName, '知页')
  assert.equal(config.bundle.android.debugApplicationIdSuffix, '.debug')
  assert.deepEqual(config.bundle.targets, [])
  assert.deepEqual(config.bundle.icon, ['icons/icon.png'])
  assert.equal(config.bundle.windows, undefined)
  assert.deepEqual(json('src-tauri/capabilities/default.json').platforms, ['android'])
  assert.equal(existsSync(join(root, 'src-tauri/src/main.rs')), false)
  assert.match(read('src-tauri/Cargo.toml'), /^autobins\s*=\s*false$/m)
})

test('desktop/PWA/iOS publication entries and resources are absent', () => {
  const pkg = json('package.json')
  for (const name of ['tauri', 'deploy']) assert.equal(pkg.scripts[name], undefined)
  assert.match(pkg.scripts.android, /^tauri android$/)
  assert.match(pkg.scripts.preview, /^vite preview$/)
  for (const name of ['vite-plugin-pwa', '@cloudflare/vite-plugin', 'wrangler']) assert.equal(pkg.devDependencies[name], undefined)
  assert.equal(existsSync(join(root, 'wrangler.jsonc')), false)
  for (const path of ['src-tauri/icons/ios', 'src-tauri/icons/icon.ico', 'src-tauri/icons/icon.icns', 'public/icon-192.png', 'public/icon-512.png', 'public/icon-maskable-512.png']) {
    assert.equal(existsSync(join(root, path)), false, path)
  }
  const vite = read('vite.config.ts')
  assert.doesNotMatch(vite, /VitePWA|vite-plugin-pwa|cloudflare\(/)
  assert.match(vite, /foliatePaginatorFork\(\)/)
  assert.match(vite, /legacyRegexRewrite\(\)/)
  assert.match(vite, /vue\(\)/)
  const icons = json('src-tauri/icons/source/icon-manifest.json')
  assert.deepEqual(icons.platforms, ['android'])
  assert.equal(icons.derived_icons.length, 26)
  assert.ok(icons.derived_icons.every(icon => icon.path.startsWith('src-tauri/icons/android/') || icon.path === 'src-tauri/icons/icon.png'))
})

test('built Android web assets contain no PWA registration or install manifest', () => {
  const dist = join(root, 'dist')
  assert.ok(existsSync(join(dist, 'index.html')), 'Run npm run build first')
  assert.doesNotMatch(readFileSync(join(dist, 'index.html'), 'utf8'), /rel=["']manifest["']|registerSW/i)
  for (const path of files(dist)) {
    assert.doesNotMatch(path, /(?:^|[/\\])(?:sw\.js|registerSW\.js|workbox-[^/\\]+\.js)$|\.webmanifest$/i)
  }
  // Historical WebView cache cleanup is allowed. New service-worker registration is not.
  assert.doesNotMatch(read('src/main.ts'), /serviceWorker\.register\s*\(/)
})

test('unsupported desktop engines are not advertised as Android capabilities', () => {
  assert.match(read('src/services/localTts.ts'), /localTtsAvailable\s*=\s*\(\)\s*=>\s*false/)
  for (const retired of ['babeldoc', 'paperAgent', 'calibre', 'updater']) {
    assert.equal(existsSync(join(root, `src/services/${retired}.ts`)), false, retired)
  }
  const settings = read('src/views/SettingsView.vue')
  assert.doesNotMatch(settings, /settings\.(?:desktopVersion|webVersion)/)
  assert.match(settings, /settings\.previewVersion/)
  for (const view of ['ReaderView.vue', 'PaperReaderView.vue']) {
    assert.match(read(`src/views/${view}`), /<button v-if="localTtsAvailable\(\)"/)
  }
  assert.doesNotMatch(read('src/App.vue'), /<BabeldocTaskStatus/)
  assert.match(read('src/views/ManualView.vue'), /manual\.androidOnlyNote/)
})

test('release workflow has only Android builds and preserves signed-APK validation', () => {
  const workflow = read('.github/workflows/release.yml')
  assert.doesNotMatch(workflow, /runs-on:\s*(?:windows|macos)|full_release|tauri build(?:\s|$)|\.dmg|\.AppImage|\.msi/)
  assert.match(workflow, /aarch64-linux-android/)
  assert.match(workflow, /tauri android build --apk --target aarch64/)
  assert.match(workflow, /ANDROID_KEYSTORE_B64/)
  assert.match(workflow, /ANDROID_CERT_SHA256/)
  assert.match(workflow, /check-release\.mjs.*--apk/)
  assert.match(workflow, /prepare-android-project\.mjs/)
  assert.match(workflow, /concurrency:[\s\S]*?cancel-in-progress:\s*false/)
  assert.match(workflow, /packages:\s*platform-tools/)
})

test('legacy schemas and AI/TTS stay stable except the additive nullable reading state', () => {
  const baseline = JSON.parse(read('scripts/fixtures/android-only-contract.json'))
  for (const [path, expected] of Object.entries(baseline.sourceHashes)) {
    assert.equal(createHash('sha256').update(read(path).replace(/\r\n/g, '\n')).digest('hex'), expected, path)
  }
  assert.deepEqual(read('src/storage/dexie.ts').replace(/\r\n/g, '\n').match(/version\(\d+\)\.stores\(\{[\s\S]*?\}\)/g), baseline.dexieSchemas)
  const statements = []
  const ast = ts.createSourceFile('tauri.ts', read('src/storage/tauri.ts'), ts.ScriptTarget.Latest, true)
  function visit(node) {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && /^\s*(?:CREATE|ALTER|DROP) (?:TABLE|INDEX)\b/.test(node.text)) {
      for (const statement of node.text.split(';')) if (statement.trim()) statements.push(statement.replace(/\s+/g, ' ').trim())
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  const books = statements.find(statement => statement.startsWith('CREATE TABLE IF NOT EXISTS books ('))
  assert.match(books, /reading_status TEXT, /)
  assert.equal(statements.filter(statement => statement.includes('reading_status')).length, 2)
  const migration = 'ALTER TABLE books ADD COLUMN reading_status TEXT'
  assert.equal(statements.filter(statement => statement === migration).length, 1)
  const originalSchemas = statements.filter(statement => statement !== migration).map(statement => statement === books ? statement.replace('reading_status TEXT, ', '') : statement)
  assert.deepEqual(originalSchemas, baseline.sqliteDDL)
  for (const path of ['sync-server/src/index.ts', 'library-server/uploads.py', 'src/services/sync/index.ts']) {
    assert.equal(existsSync(join(root, path)), false, path)
  }
})

test('Android project preparation installs managed resources and is idempotent', () => {
  const cache = resolve(root, '../.cache')
  mkdirSync(cache, { recursive: true })
  const fixture = mkdtempSync(join(cache, 'android-project-test-'))
  try {
    for (const path of ['scripts/prepare-android-project.mjs', 'src-tauri/tauri.conf.json', 'src-tauri/android/MainActivity.kt']) {
      mkdirSync(dirname(join(fixture, path)), { recursive: true })
      cpSync(join(root, path), join(fixture, path))
    }
    cpSync(join(root, 'src-tauri/icons/android'), join(fixture, 'src-tauri/icons/android'), { recursive: true })
    const project = join(fixture, 'src-tauri/gen/android')
    const res = join(project, 'app/src/main/res')
    const activity = join(project, 'app/src/main/java/io/pagewise/reader/MainActivity.kt')
    mkdirSync(dirname(activity), { recursive: true })
    mkdirSync(join(res, 'values'), { recursive: true })
    mkdirSync(join(res, 'xml'), { recursive: true })
    writeFileSync(activity, 'package io.pagewise.reader\n')
    writeFileSync(join(res, 'values/strings.xml'), '<resources><string name="app_name">placeholder</string><string name="main_activity_title">placeholder</string></resources>')
    writeFileSync(join(project, 'app/src/main/AndroidManifest.xml'), '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application><provider android:name="androidx.core.content.FileProvider" android:authorities="${applicationId}.fileprovider" /></application></manifest>')
    writeFileSync(join(res, 'xml/file_paths.xml'), '<paths></paths>')
    const run = () => execFileSync(process.execPath, [join(fixture, 'scripts/prepare-android-project.mjs')], { cwd: fixture, encoding: 'utf8' })
    run()
    const before = new Map(files(project).map(path => [path, hash(path)]))
    run()
    assert.deepEqual(new Map(files(project).map(path => [path, hash(path)])), before)
    assert.match(readFileSync(join(res, 'values/strings.xml'), 'utf8'), />知页</)
    assert.equal(hash(activity), hash(join(root, 'src-tauri/android/MainActivity.kt')))
    assert.doesNotMatch(readFileSync(join(project, 'app/src/main/AndroidManifest.xml'), 'utf8'), /REQUEST_INSTALL_PACKAGES/)
    assert.ok(existsSync(join(res, 'mipmap-xxxhdpi/ic_launcher_foreground.png')))
  } finally {
    // This unique test-created directory contains no user files or books.
    rmSync(fixture, { recursive: true, force: true })
  }
})
