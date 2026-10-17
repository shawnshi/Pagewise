import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { createRouter, createMemoryHistory, isNavigationFailure, NavigationFailureType } from 'vue-router'
import { rememberView, restoreView } from '../src/services/navigationSession.ts'

const source = readFileSync(new URL('../src/router/index.ts', import.meta.url), 'utf8')
const ast = ts.createSourceFile('router.ts', source, ts.ScriptTarget.Latest, true)
const callbacks = []
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'router.afterEach') callbacks.push(node.arguments[0].getText(ast))
  ts.forEachChild(node, visit)
}
visit(ast)
assert.equal(callbacks.length, 1, 'exercise the production navigation persistence hook')

function fixture() {
  const values = new Map()
  let writes = 0
  const storage = { getItem: key => values.get(key) ?? null, setItem(key, value) { writes++; values.set(key, value) } }
  const history = createMemoryHistory()
  const router = createRouter({ history, routes: [{ path: '/library', component: {} }, { path: '/read/:id', component: {} }, { path: '/notes', component: {} }] })
  const callback = new Function('rememberView', 'localStorage', 'console', `return (${callbacks[0]})`)(rememberView, storage, console)
  router.afterEach(callback)
  return { router, history, storage, writes: () => writes }
}

test('successful navigation commits the actual current restorable view', async () => {
  const f = fixture()
  await f.router.push('/library')
  await f.router.push('/read/synthetic-book')
  assert.equal(restoreView(f.storage), '/read/synthetic-book')
  await f.router.push('/notes')
  assert.equal(restoreView(f.storage), '/notes')
})

test('aborted navigation must not replace the saved reader with the canceled target', async () => {
  const f = fixture()
  await f.router.push('/read/synthetic-book')
  const before = f.writes()
  f.router.beforeEach(to => to.path === '/library' ? false : undefined)
  const failure = await f.router.push('/library')
  assert.ok(isNavigationFailure(failure, NavigationFailureType.aborted))
  assert.equal(f.router.currentRoute.value.path, '/read/synthetic-book')
  assert.equal(restoreView(f.storage), '/read/synthetic-book')
  assert.equal(f.writes(), before)
})

test('a consumed Back/pop navigation keeps the live and saved reader aligned', async () => {
  const f = fixture()
  await f.router.push('/library')
  await f.router.push('/read/synthetic-book')
  f.router.beforeEach(to => to.path === '/library' ? false : undefined)
  const settled = new Promise(resolve => { const remove = f.router.afterEach((_to, _from, failure) => { remove(); resolve(failure) }) })
  f.history.go(-1)
  const failure = await settled
  assert.ok(isNavigationFailure(failure, NavigationFailureType.aborted))
  assert.equal(f.router.currentRoute.value.path, '/read/synthetic-book')
  assert.equal(restoreView(f.storage), '/read/synthetic-book')
})

test('duplicate navigation is not a second durable commit', async () => {
  const f = fixture()
  await f.router.push('/notes')
  const before = f.writes()
  const failure = await f.router.push('/notes')
  assert.ok(isNavigationFailure(failure, NavigationFailureType.duplicated))
  assert.equal(restoreView(f.storage), '/notes')
  assert.equal(f.writes(), before)
})
