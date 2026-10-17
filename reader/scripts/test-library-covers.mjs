import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { parse, compileScript, compileTemplate, compileStyle } from '@vue/compiler-sfc'
import * as cache from '../src/services/coverUrlCache.ts'

const source = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
const turn = () => new Promise(resolve => setImmediate(resolve))

function harness(load) {
  const revoked = []
  const calls = []
  const code = ts.transpileModule(source('src/services/libraryCovers.ts'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText
  const exports = {}
  vm.runInNewContext(code, {
    exports,
    URL: { revokeObjectURL: url => revoked.push(url) },
    require: name => {
      if (name === './coverUrlCache.ts') return cache
      if (name === '../storage/index.ts') return {
        getStorage: async () => ({ getCoverUrl: id => { calls.push(id); return load(id) } }),
      }
      throw new Error(`Unexpected production dependency: ${name}`)
    },
  }, { filename: 'libraryCovers.cjs' })
  return { ...exports, revoked, calls }
}

test('library and statistics borrow the same URL; route lease release never disposes the other consumer', async () => {
  const h = harness(id => `blob:${id}`)
  const library = h.acquireLibraryCover('shared')
  const stats = h.acquireLibraryCover('shared')
  assert.equal(await library.ready, 'blob:shared')
  assert.equal(await stats.ready, 'blob:shared')
  assert.deepEqual(h.calls, ['shared'])
  library.release()
  library.release()
  assert.deepEqual(h.revoked, [])
  stats.release()
  h.disposeLibraryCovers()
  assert.deepEqual(h.revoked, ['blob:shared'])
})

test('shared facade bounds actual storage loads at two', async () => {
  const pending = []
  let active = 0
  let peak = 0
  const h = harness(id => new Promise(resolve => {
    active++
    peak = Math.max(peak, active)
    pending.push(() => { active--; resolve(`blob:${id}`) })
  }))
  const leases = ['a', 'b', 'c'].map(id => h.acquireLibraryCover(id))
  await turn()
  assert.equal(h.calls.length, 2)
  pending.shift()()
  await turn()
  assert.equal(h.calls.length, 3)
  while (pending.length) pending.shift()()
  await Promise.all(leases.map(lease => lease.ready))
  assert.equal(peak, 2)
  leases.forEach(lease => lease.release())
  h.disposeLibraryCovers()
  assert.equal(new Set(h.revoked).size, 3)
  assert.equal(h.revoked.length, 3)
})

test('library/statistics route churn retains no more than 32 live idle URLs', async () => {
  const h = harness(id => `blob:${id}`)
  let peak = 0
  for (let id = 0; id < 40; id++) {
    const lease = h.acquireLibraryCover(String(id))
    await lease.ready
    lease.release()
    peak = Math.max(peak, h.calls.length - h.revoked.length)
  }
  assert.equal(peak, 32)
  h.disposeLibraryCovers()
  assert.equal(h.calls.length, 40)
  assert.equal(h.revoked.length, 40)
  assert.equal(new Set(h.revoked).size, 40)
})

test('app disposal preserves referenced URLs until child cleanup and allows a new app pool', async () => {
  const h = harness(id => `blob:${id}`)
  const old = h.acquireLibraryCover('old')
  await old.ready
  h.disposeLibraryCovers()
  assert.deepEqual(h.revoked, [])
  const fresh = h.acquireLibraryCover('fresh')
  assert.equal(await fresh.ready, 'blob:fresh')
  old.release()
  assert.deepEqual(h.revoked, ['blob:old'])
  h.disposeLibraryCovers()
  assert.deepEqual(h.revoked, ['blob:old'])
  fresh.release()
  assert.deepEqual(h.revoked, ['blob:old', 'blob:fresh'])
})

test('storage errors stay errors, distinct from a stored absence of cover', async () => {
  const error = new Error('synthetic cover read failed')
  const h = harness(id => id === 'broken' ? Promise.reject(error) : undefined)
  const broken = h.acquireLibraryCover('broken')
  await assert.rejects(broken.ready, actual => actual === error)
  broken.release()
  const empty = h.acquireLibraryCover('empty')
  assert.equal(await empty.ready, undefined)
  empty.release()
  h.disposeLibraryCovers()
  assert.deepEqual(h.revoked, [])
})

test('both visible consumers and app teardown compile and use the shared facade', () => {
  for (const file of ['src/App.vue', 'src/views/LibraryView.vue', 'src/components/stats/BookThumb.vue']) {
    const code = source(file)
    const { descriptor, errors } = parse(code, { filename: file })
    assert.deepEqual(errors, [], file)
    compileScript(descriptor, { id: file })
    const template = compileTemplate({ source: descriptor.template.content, filename: file, id: file })
    assert.deepEqual(template.errors, [], file)
    for (const style of descriptor.styles) {
      assert.deepEqual(compileStyle({ source: style.content, filename: file, id: file, scoped: style.scoped }).errors, [], file)
    }
  }
  assert.match(source('src/views/LibraryView.vue'), /acquireLibraryCover\(id\)/)
  assert.doesNotMatch(source('src/views/LibraryView.vue'), /coverCache\.dispose\(|createCoverUrlCache\(/)
  assert.match(source('src/components/stats/BookThumb.vue'), /IntersectionObserver/)
  assert.match(source('src/components/stats/BookThumb.vue'), /onCleanup\(.*lease\.release/)
  assert.match(source('src/App.vue'), /disposeLibraryCovers\(\)/)
})
