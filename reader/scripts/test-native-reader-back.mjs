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
  const handler = new Function('readerBack', 'toast', 't', 'console', `let nativeBackPending = false; ${compile(node.getText(ast))}; return handleNativeReaderBack`)(readerBack, (...args) => notices.push(args), key => key, { error: (...args) => errors.push(args) })
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
  const hook = source => new Function('nativeBackHost', 'handleNativeReaderBack', `${compile(`const callback = ${source}`)};return callback`)(host, own)
  const mount = hook(hooks.onMounted[0]), unmount = hook(hooks.onBeforeUnmount[0])
  mount(); assert.equal(host.__pagewiseReaderBack, own)
  unmount(); assert.equal(host.__pagewiseReaderBack, undefined)
  mount(); const replacement = () => false; host.__pagewiseReaderBack = replacement
  unmount(); assert.equal(host.__pagewiseReaderBack, replacement)
})

test('Android forwards Back first and disables only its own callback during original-dispatcher fallback', () => {
  const kotlin = readFileSync(new URL('../src-tauri/android/MainActivity.kt', import.meta.url), 'utf8')
  assert.match(kotlin, /OnBackPressedCallback/)
  assert.match(kotlin, /onBackPressedDispatcher\.addCallback\(this, nativeBackCallback\)/)
  assert.match(kotlin, /__pagewiseReaderBack/)
  assert.match(kotlin, /evaluateJavascript/)
  assert.match(kotlin, /handled != "true"/)
  const fallback = kotlin.slice(kotlin.indexOf('private fun fallbackNativeBack'))
  assert.match(fallback, /nativeBackCallback\.isEnabled = false[\s\S]*onBackPressedDispatcher\.onBackPressed\(\)[\s\S]*finally[\s\S]*nativeBackCallback\.isEnabled = true/)
})
