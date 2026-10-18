import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const vue = readFileSync(new URL('../src/views/ReaderView.vue', import.meta.url), 'utf8')
const script = vue.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
const ast = ts.createSourceFile('ReaderView.ts', script, ts.ScriptTarget.Latest, true)
function findFunction(name) { return ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name) }
function compile(source) { return ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText }
function fixture(readerBack) {
  const node = findFunction('handleNativeReaderBack')
  assert.ok(node, 'the native adapter must delegate to the production reader Back entry')
  const errors = [], notices = []
  const handler = new Function('readerBack', 'toast', 't', 'console', `let nativeBackPending = false, nativeBackAlive = true; const nativeBackHost = {}; ${compile(node.getText(ast))}; nativeBackHost.__pagewiseReaderBack = handleNativeReaderBack; return handleNativeReaderBack`)(readerBack, (...args) => notices.push(args), key => key, { error: (...args) => errors.push(args) })
  return { handler, errors, notices }
}
const settle = () => new Promise(resolve => setImmediate(resolve))

test('native Back is synchronously consumed and rapid presses do not reenter asynchronous reader Back', async () => {
  let resolve, calls = 0
  const f = fixture(() => { calls++; return new Promise(done => { resolve = done }) })
  assert.equal(f.handler(), true)
  assert.equal(f.handler(), true)
  assert.equal(calls, 1)
  resolve(); await settle()
  assert.equal(f.handler(), true)
  assert.equal(calls, 2)
  resolve(); await settle()
})

test('reader Back failure is explicit, stays consumed and unlocks a later retry', async () => {
  let calls = 0
  const f = fixture(() => { calls++; return Promise.reject(new Error('synthetic back failure')) })
  assert.equal(f.handler(), true)
  await settle()
  assert.equal(f.errors.length, 1)
  assert.equal(f.notices.length, 1)
  assert.equal(f.handler(), true)
  await settle()
  assert.equal(calls, 2)
})

test('mount registers the actual reader owner; cleanup never deletes a newer owner', () => {
  const hooks = { onMounted: [], onBeforeUnmount: [] }
  for (const node of ast.statements) {
    if (!ts.isExpressionStatement(node) || !ts.isCallExpression(node.expression)) continue
    const call = node.expression, name = call.expression.getText(ast), arg = call.arguments[0]
    if (hooks[name] && arg?.getText(ast).includes('nativeBackHost.__pagewiseReaderBack')) hooks[name].push(arg.getText(ast))
  }
  assert.equal(hooks.onMounted.length, 1)
  assert.equal(hooks.onBeforeUnmount.length, 1)
  const host = {}, own = () => true
  const hook = source => new Function('nativeBackHost', 'handleNativeReaderBack', `let nativeBackAlive = true; ${compile(`const callback = ${source}`)};return callback`)(host, own)
  const mount = hook(hooks.onMounted[0]), unmount = hook(hooks.onBeforeUnmount[0])
  mount(); assert.equal(host.__pagewiseReaderBack, own)
  unmount(); assert.equal(host.__pagewiseReaderBack, undefined)
  mount(); const replacement = () => false; host.__pagewiseReaderBack = replacement
  unmount(); assert.equal(host.__pagewiseReaderBack, replacement)
})

test('actual PDF Back awaits note acknowledgement and leaves the editor intact on rejection', async () => {
  const source = readFileSync(new URL('../src/views/PdfReaderView.vue', import.meta.url), 'utf8').match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
  const pdf = ts.createSourceFile('PdfReaderView.ts', source, ts.ScriptTarget.Latest, true)
  const bodies = ['readerBack', 'saveNote'].map(name => {
    const node = pdf.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)
    assert.ok(node, name)
    return node.getText(pdf)
  }).join('\n')
  const state = { activeAnnotation: { value: { id: 'owned', note: '' } }, noteDraft: { value: 'retain input' }, annotations: { value: [{ id: 'owned' }] } }
  let reject, resolve
  const storage = { updateAnnotation: () => new Promise((yes, no) => { resolve = yes; reject = no }) }
  const back = new Function('activeAnnotation', 'noteDraft', 'annotations', 'getStorage', 'toast', 't', `const bookmarkMutation = null; ${compile(bodies)}; return readerBack`)(state.activeAnnotation, state.noteDraft, state.annotations, async () => storage, () => {}, key => key)
  const failed = back()
  await settle()
  assert.equal(state.activeAnnotation.value.id, 'owned')
  reject(new Error('synthetic PDF note failure'))
  await assert.rejects(failed, /synthetic PDF note failure/)
  assert.equal(state.noteDraft.value, 'retain input')
  assert.equal(state.activeAnnotation.value.id, 'owned')
  const retry = back()
  await settle(); resolve(); await retry
  assert.equal(state.activeAnnotation.value, null)
  assert.equal(state.annotations.value[0].note, 'retain input')
})

test('Android forwards Back first and disables only its own callback during original-dispatcher fallback', () => {
  const kotlin = readFileSync(new URL('../src-tauri/android/MainActivity.kt', import.meta.url), 'utf8')
  assert.match(kotlin, /OnBackPressedCallback/)
  const create = kotlin.slice(kotlin.indexOf('override fun onCreate'), kotlin.indexOf('override fun onWebViewCreate'))
  assert.doesNotMatch(create, /addCallback/)
  const webViewCreate = kotlin.slice(kotlin.indexOf('override fun onWebViewCreate'), kotlin.indexOf('private var barsDark'))
  assert.match(webViewCreate, /nativeBackCallback\.remove\(\)[\s\S]*onBackPressedDispatcher\.addCallback\(this, nativeBackCallback\)/)
  assert.match(kotlin, /__pagewiseReaderBack/)
  assert.match(kotlin, /evaluateJavascript/)
  assert.match(kotlin, /handled != "true"/)
  const fallback = kotlin.slice(kotlin.indexOf('private fun fallbackNativeBack'))
  assert.match(fallback, /nativeBackCallback\.isEnabled = false[\s\S]*onBackPressedDispatcher\.onBackPressed\(\)[\s\S]*finally[\s\S]*nativeBackCallback\.isEnabled = true/)
})
