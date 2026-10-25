import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync, writeFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { prepareAndroidProject } from './prepare-android-project.mjs'
import vm from 'node:vm'
import ts from 'typescript'
import { registerHooks } from 'node:module'
import { createNativeBookImportClient, supportsNativeBookImport, validateNativeBatch } from '../src/services/nativeBookImport.ts'
import { createNativeFileJobClient } from '../src/services/nativeFileJobs.ts'

const id = '12345678-1234-4234-8234-123456789abc'
const summary = patch => ({ total: 0, done: 0, imported: 0, updated: 0, skipped: 0, failed: 0, complete: true, results: [], errors: [], ...patch })
test('new shell uses one descriptor-only native batch; per-file load failures retain input order', async () => {
  const calls = [], staged = [], progress = []
  const client = createNativeBookImportClient({
    stage: async (file, path) => { staged.push(file.name); return path },
    cleanup: async () => {}, libraryRoot: () => '',
    job: async (kind, input, consume, onProgress) => {
      calls.push({ kind, input })
      assert.equal(kind, 'import')
      assert.equal(input.request.items.length, 2)
      assert.equal(input.request.source, '合成来源')
      const results = [{ ok: true, fileName: 'one.txt', bookId: id }, { ok: false, fileName: 'bad.epub', error: 'invalid_book' }]
      onProgress?.(summary({ total: 2, done: 1, imported: 1, complete: false, results: results.slice(0, 1) }))
      return consume(summary({ total: 2, done: 2, imported: 1, failed: 1, complete: false, results, errors: [{ fileName: 'bad.epub', code: 'invalid_book' }] }))
    },
  })
  const inputs = [new File(['BODY NEVER IN JOB PAYLOAD'], 'one.txt'), { name: 'unreadable.txt', load: async () => { throw new Error('load denied') } }, new File(['broken'], 'bad.epub')]
  const result = await client.files(inputs, '合成来源', { title: 'Explicit title' }, (...args) => progress.push(args))
  assert.deepEqual(result.map(r => [r.fileName, r.ok]), [['one.txt', true], ['unreadable.txt', false], ['bad.epub', false]])
  assert.deepEqual(staged, ['one.txt', 'bad.epub'])
  assert.ok(!JSON.stringify(calls).includes('BODY NEVER IN JOB PAYLOAD'))
  assert.deepEqual(progress.at(-1), [3, 3, ''])
})

test('lost upload responses retain their full reservation inside the one-GiB batch budget', async () => {
  let attempts = 0, held = 0, peak = 0
  const client = createNativeBookImportClient({ libraryRoot: () => '',
    stage: async file => { attempts++; held += file.size; peak = Math.max(peak, held); throw new Error('upload written; response lost') },
    cleanup: async () => { held = 0 }, job: async () => assert.fail('no input completed staging') })
  const files = ['one.txt', 'two.txt'].map(name => {
    const file = new File(['synthetic'], name)
    Object.defineProperty(file, 'size', { value: 1024 ** 3 })
    return file
  })
  const results = await client.files(files)
  assert.equal(attempts, 1)
  assert.equal(peak, 1024 ** 3)
  assert.ok(results.every(r => !r.ok))
})

test('unknown admission/status/commit failures cannot delete inputs still owned by a native worker', async () => {
  for (const failure of [{ code: 'unavailable' }, { code: 'commit_outcome_unknown' }, { code: 'busy' }, { code: 'busy', admissionRejected: true }]) {
    const cleaned = []
    const client = createNativeBookImportClient({ stage: async (_file, path) => path, cleanup: async path => cleaned.push(path), libraryRoot: () => '', job: async () => { throw failure } })
    await assert.rejects(client.files([new File(['x'], 'one.txt')]), failure)
    assert.equal(cleaned.length, 0)
    await client.abandon()
    assert.equal(cleaned.length, 1, 'explicit abandon is the only release path before the native outcome is reconciled')
  }
})

test('copied import survives a lost start ACK and WebView rebuild through the real batch and job clients', async () => {
  const values = new Map(), calls = []
  const journal = { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v), removeItem: k => values.delete(k) }
  let stages = 0, commits = 0, lost = true, original
  const result = summary({ total: 1, done: 1, imported: 1, finished: true, results: [{ ok: true, fileName: 'one.txt', bookId: id }] })
  const transport = async (action, payload) => {
    calls.push({ action, payload })
    if (action !== 'start') return {}
    original ??= payload
    if (lost) { lost = false; commits++; throw { code: 'unavailable' } }
    assert.equal(payload.id, original.id, 'lost ACK retains the original actual job ID')
    assert.equal(payload.documentId, original.documentId, 'batch identity survives the page rebuild')
    assert.deepEqual(payload.request.items, original.request.items)
    return { ...payload, state: 'succeeded', code: '', result }
  }
  const make = () => {
    const jobs = createNativeFileJobClient(transport, journal, async () => {})
    return createNativeBookImportClient({ journal, libraryRoot: () => '', cleanup: async () => {}, cleanupBatch: async () => {},
      stage: async (_file, path) => { stages++; return path }, job: (k, i, c, p) => jobs.run(k, i, c, undefined, p) })
  }
  const file = new File(['SYNTHETIC BODY'], 'one.txt', { lastModified: 1 })
  await assert.rejects(make().files([file]), { code: 'unavailable' })
  const resumed = await make().files([file])
  assert.equal(resumed[0].bookId, id)
  assert.equal(stages, 1); assert.equal(commits, 1)
  assert.equal(values.size, 0)
})

test('lost result persistence after job ACK reuses the same durable SQL batch identity without re-uploading', async () => {
  const values = new Map(), starts = [], batches = new Set()
  let crash = true, stages = 0
  const journal = { getItem: k => values.get(k) ?? null, removeItem: k => values.delete(k), setItem: (k, v) => {
    if (k === 'pagewise-native-import-batch-v1') {
      let record
      try { record = JSON.parse(v) } catch { assert.fail('client must write a valid batch journal') }
      if (record.phase === 'resolved' && crash) { crash = false; throw new Error('synthetic page teardown') }
    }
    values.set(k, v)
  } }
  const result = summary({ total: 1, done: 1, imported: 1, finished: true, results: [{ ok: true, fileName: 'one.txt', bookId: id }] })
  const transport = async (action, payload) => {
    if (action !== 'start') return {}
    starts.push(payload); batches.add(payload.documentId)
    return { ...payload, state: 'succeeded', code: '', result }
  }
  const make = () => {
    const jobs = createNativeFileJobClient(transport, journal)
    return createNativeBookImportClient({ journal, libraryRoot: () => '', cleanup: async () => {}, cleanupBatch: async () => {},
      stage: async (_file, path) => { stages++; return path }, job: (k, i, c, p) => jobs.run(k, i, c, undefined, p) })
  }
  const file = new File(['one'], 'one.txt', { lastModified: 1 })
  await assert.rejects(make().files([file]), /synthetic page teardown/)
  assert.equal((await make().resume())[0].bookId, id)
  assert.equal(stages, 1); assert.equal(batches.size, 1)
  assert.notEqual(starts[0].id, starts[1].id, 'job ACK may be gone, while the SQL batch identity remains stable')
  assert.equal(values.size, 0)
})

test('custom roots and malformed/unreconciled native receipts fail visibly instead of selecting another DB', async () => {
  const client = createNativeBookImportClient({ stage: async () => assert.fail(), cleanup: async () => {}, libraryRoot: () => '/explicit/custom', job: async () => assert.fail() })
  await assert.rejects(client.index('saf-fixture', false), { code: 'unsupported_library_root' })
  await assert.rejects(client.files([new File(['x'], 'one.txt')]), { code: 'unsupported_library_root' })
  for (const bad of [null, {}, summary({ imported: 1 }), summary({ total: 2, done: 1, imported: 1 }), summary({ errors: [{ code: 123 }] })]) {
    assert.throws(() => validateNativeBatch(bad), { code: 'invalid_receipt' })
  }
  const previous = globalThis.window
  try {
    globalThis.window = { LightReadInsets: { nativeFileJobsVersion: () => 1 } }
    assert.equal(supportsNativeBookImport(), false)
    globalThis.window.LightReadInsets.nativeBookImportVersion = () => 1
    assert.equal(supportsNativeBookImport(), true)
  } finally { if (previous === undefined) delete globalThis.window; else globalThis.window = previous }
})

test('unreconciled journal corruption never becomes an imported book or another cleanup namespace', async () => {
  const values = new Map()
  const journal = { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v), removeItem: k => values.delete(k) }
  let calls = 0
  const client = createNativeBookImportClient({ journal, libraryRoot: () => '', stage: async (_file, path) => path,
    cleanup: async () => assert.fail('corrupt journal cannot authorize deletion'), job: async () => { calls++; throw { code: 'unavailable' } } })
  await assert.rejects(client.files([new File(['x'], 'one.txt')]), { code: 'unavailable' })
  const original = values.get('pagewise-native-import-batch-v1')
  for (const change of [b => { b.positions = [-1] }, b => { b.request.items[0].path = 'books/protected.txt' },
    b => { b.phase = 'resolved'; b.result = [{ ok: true, fileName: 'one.txt', bookId: '../../protected' }] }]) {
    let batch
    try { batch = JSON.parse(original) } catch { assert.fail('fixture is generated by the real client') }
    change(batch); values.set('pagewise-native-import-batch-v1', JSON.stringify(batch))
    await assert.rejects(client.resume(), { code: 'invalid_receipt' })
  }
  assert.equal(calls, 1)
})

test('full Android prepare upgrades project-only Kotlin/DSL/dependencies atomically and leaves upstream scripts untouched', () => {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const base = mkdtempSync(join(tmpdir(), 'pagewise-native-import-prepare-'))
  const project = join(base, 'src-tauri/gen/android')
  const put = (path, text) => { const target = join(base, path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, text) }
  const snapshot = path => Object.fromEntries(readdirSync(path, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => {
    const file = join(e.parentPath, e.name); return [file.slice(path.length), readFileSync(file).toString('base64')]
  }))
  try {
    cpSync(join(root, 'src-tauri/android'), join(base, 'src-tauri/android'), { recursive: true })
    cpSync(join(root, 'src-tauri/android-sdk'), join(base, 'src-tauri/android-sdk'), { recursive: true })
    cpSync(join(root, 'docs/manual'), join(base, 'docs/manual'), { recursive: true })
    put('src-tauri/Cargo.lock', readFileSync(join(root, 'src-tauri/Cargo.lock')))
    const pin = JSON.parse(readFileSync(join(root, 'src-tauri/android-sdk/tauri-2.11.5/upstream.json'), 'utf8'))
    const sdkLine = readFileSync(join(root, 'src-tauri/gen/android/tauri.settings.gradle'), 'utf8').split('\n').find(line => line.includes("project(':tauri-android').projectDir"))
    assert.ok(sdkLine)
    const sdk = JSON.parse(sdkLine.slice(sdkLine.indexOf('new File(') + 9, sdkLine.lastIndexOf(')')))
    for (const name of Object.keys(pin.moduleFiles)) put(`upstream/tauri-android/${name}`, readFileSync(join(sdk, name)))
    cpSync(join(root, 'src-tauri/icons/android'), join(base, 'src-tauri/icons/android'), { recursive: true })
    for (const path of ['package.json', 'src-tauri/tauri.conf.json']) put(path, readFileSync(join(root, path)))
    put('src-tauri/gen/android/buildSrc/src/main/java/io/pagewise/reader/kotlin/BuildTask.kt', 'val executable = """npm""";\nval args = listOf("run", "--", "tauri", "android", "android-studio-script");\n')
    put('src-tauri/gen/android/app/src/main/res/values/strings.xml', '<resources><string name="app_name">old</string><string name="main_activity_title">old</string></resources>')
    put('src-tauri/gen/android/app/src/main/AndroidManifest.xml', '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application><provider android:name="androidx.core.content.FileProvider" android:authorities="${applicationId}.fileprovider" /></application></manifest>')
    put('src-tauri/gen/android/build.gradle.kts', 'classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:1.9.25")\n')
    const oldDsl = 'android {\n    kotlinOptions { jvmTarget = "1.8" }\n}\n'
    put('src-tauri/gen/android/app/build.gradle.kts', oldDsl + 'apply(from = "tauri.build.gradle.kts")\n')
    put('src-tauri/gen/android/settings.gradle', "apply from: 'tauri.settings.gradle'\n")
    const names = ['tauri-android', 'tauri-plugin-dialog', 'tauri-plugin-fs', 'tauri-plugin-opener']
    for (const name of names) if (name !== 'tauri-android') put(`upstream/${name}/build.gradle.kts`, oldDsl)
    put('src-tauri/gen/android/tauri.settings.gradle', names.map(name => `project(':${name}').projectDir = new File(${JSON.stringify(join(base, 'upstream', name))})`).join('\n'))
    const before = snapshot(project), upstream = snapshot(join(base, 'upstream'))
    assert.throws(() => prepareAndroidProject(base, { replace(from, to) {
      if (to.endsWith('tauri-plugin-fs.gradle.kts')) throw new Error('injected Gradle adapter commit failure')
      renameSync(from, to)
    } }), /injected Gradle adapter commit failure/)
    assert.deepEqual(snapshot(project), before, 'rollback restores existing bytes and removes new Kotlin/dependency/adapter outputs')
    prepareAndroidProject(base)
    assert.match(readFileSync(join(project, 'build.gradle.kts'), 'utf8'), /kotlin-gradle-plugin:2\.4\.20/)
    assert.match(readFileSync(join(project, 'app/native-import.gradle.kts'), 'utf8'), /pdfiumandroid:1\.0\.35/)
    for (const name of names) {
      const adapted = readFileSync(join(project, 'native-gradle', name + '.gradle.kts'), 'utf8')
      assert.match(adapted, /JvmTarget.JVM_1_8/); assert.doesNotMatch(adapted, /kotlinOptions/)
    }
    const prepared = snapshot(project); prepareAndroidProject(base)
    assert.deepEqual(snapshot(project), prepared, 'full native prepare is idempotent')
    assert.deepEqual(snapshot(join(base, 'upstream')), upstream)
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test('actual importFile/importFiles native branches initialize existing storage and never call Web parsing/addBook', async () => {
  const text = readFileSync(new URL('../src/services/importer.ts', import.meta.url), 'utf8')
  const ast = ts.createSourceFile('importer.ts', text, ts.ScriptTarget.Latest, true)
  for (const name of ['importFile', 'importFiles']) {
    let initialized = 0, native = 0
    const declaration = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name)
    const body = declaration.getText(ast).replace('export ', '')
    const context = vm.createContext({ supportsNativeBookImport: () => true,
      getStorage: async () => { initialized++; return { addBook: () => assert.fail('native must commit') } },
      importNativeFiles: async files => { native++; assert.equal(initialized, 1); return Array.from(files).map(file => ({ ok: true, fileName: file.name, bookId: id })) },
      prepareBookImport: () => assert.fail('Web parser cannot run on the native route') })
    const action = vm.runInContext(ts.transpileModule(body + '\n' + name, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText, context)
    const file = new File(['synthetic'], 'book.epub')
    const result = await action(name === 'importFile' ? file : [file])
    assert.equal(native, 1)
    assert.equal((Array.isArray(result) ? result[0] : result).bookId, id)
  }
})

test('actual folder manager delegates enumeration/parsing/covers/commits to native and refreshes DB after partial failure', async t => {
  const target = new URL('../src/services/folderLibrary.ts', import.meta.url)
  const stubs = {
    './monitoredFolder': 'export const MONITORED_FOLDER_LIMITS={files:5000,readBytes:67108864};export const getMonitoredFolder=()=>{},selectMonitoredFolder=()=>{},listMonitoredFiles=()=>{},readMonitoredFile=()=>{},subscribeMonitoredFolderChanges=()=>{};',
    '../storage': 'export const getStorage=()=>{};', './importer': 'export const prepareBookImport=()=>{};',
  }
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (context.parentURL === target.href) {
      if (Object.hasOwn(stubs, specifier)) return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true }
      if (specifier === './format') return next(new URL('../src/services/format.ts', import.meta.url).href, context)
    }
    return next(specifier, context)
  } })
  let createFolderLibrary
  try { ({ createFolderLibrary } = await import(target.href)) } finally { hooks.deregister() }
  const folder = { id: 'saf-fixture', label: 'Synthetic', permission: 'granted' }
  let books = [], reads = 0, fail = false, native = 0
  const manager = createFolderLibrary({
    getMonitoredFolder: async () => folder, selectMonitoredFolder: async () => folder,
    listMonitoredFiles: async () => assert.fail('batch enumeration belongs to native'), readMonitoredFile: async () => assert.fail('body cannot cross bridge for import'),
    prepareBookImport: async () => assert.fail('Web bibliography parser cannot run'), subscribeMonitoredFolderChanges: () => () => {},
    getStorage: async () => ({ listBooks: async () => { reads++; return structuredClone(books) } }),
    nativeIndex: async () => {
      native++
      books = [{ id, title: 'Native result', sourceRef: { folderId: folder.id, documentId: 'one' }, fileAvailability: 'available' }]
      if (fail) throw Object.assign(new Error('partial native commit'), { code: 'commit_outcome_unknown' })
      return summary({ total: 1, done: 1, imported: 1 })
    },
  })
  const stop = manager.start(); t.after(stop)
  await manager.rescan()
  assert.ok(native > 0)
  assert.equal(manager.status.value.indexed, 1)
  const before = reads, generation = manager.status.value.generation
  fail = true; await manager.rescan()
  assert.ok(reads >= before + 2, 'must read actual storage even if native replied with failure')
  assert.equal(manager.status.value.state, 'error')
  assert.ok(manager.status.value.generation > generation)
})
