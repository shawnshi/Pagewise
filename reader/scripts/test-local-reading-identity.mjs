import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { test } from 'node:test'

// Execute production bodies with only the lazy Dexie import replaced; no database is opened.
const source = stripTypeScriptTypes(readFileSync(new URL('../src/services/localReadingIdentity.ts', import.meta.url), 'utf8'))
assert.equal(source.split("import('dexie')").length, 2)
const dataUrl = text => `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`
let fixtureId = 0

async function fixture({ device = 'historical-device', hashes = [{ id: 'old-book', hash: 'H1' }] } = {}) {
  const values = new Map(device === null ? [] : [['deviceId', device]])
  const calls = { opens: 0, transactions: 0, puts: 0 }
  let failIdentity = false
  let failHashes = false
  class FakeDexie {
    constructor(name) {
      assert.equal(name, 'lightread-sync')
      calls.opens++
      this.kv = {
        get: async key => {
          assert.equal(key, 'deviceId', 'must not read account or baseline values')
          if (failIdentity) throw new Error('identity read failed')
          return values.has(key) ? { key, value: values.get(key) } : undefined
        },
        put: async row => { assert.equal(row.key, 'deviceId'); calls.puts++; values.set(row.key, row.value) },
      }
      this.hashes = { toArray: async () => {
        if (failHashes) throw new Error('hash read failed')
        return structuredClone(hashes)
      } }
    }
    version(version) {
      assert.equal(version, 1)
      return { stores: schema => assert.deepEqual(schema, { kv: 'key', hashes: 'id' }) }
    }
    async transaction(mode, table, callback) {
      assert.equal(mode, 'rw')
      assert.equal(table, this.kv)
      calls.transactions++
      return callback()
    }
  }
  const dependencyUrl = dataUrl(`// fixture ${fixtureId++}\nlet Dexie; export { Dexie as default }; export const set = value => { Dexie = value }`)
  const dependency = await import(dependencyUrl)
  dependency.set(FakeDexie)
  const { createReadingIdentity: create } = await import(dataUrl(source.replace("import('dexie')", `import(${JSON.stringify(dependencyUrl)})`)))
  return { create, values, calls, hashes, failIdentity: value => { failIdentity = value }, failHashes: value => { failHashes = value } }
}

test('historical identity and hash correlation survive without reading retired account/baseline data', async () => {
  const f = await fixture()
  const identity = f.create()
  assert.equal(f.calls.opens, 0, 'lazy until used')
  assert.equal(await identity.getDeviceId(), 'historical-device')
  assert.deepEqual(await identity.getHashes(), new Map([['old-book', 'H1']]))
  f.hashes.push({ id: 'second-book', hash: 'H2' })
  assert.deepEqual(await identity.getHashes(), new Map([['old-book', 'H1'], ['second-book', 'H2']]))
  assert.equal(f.calls.puts, 0)
  assert.equal(f.calls.opens, 1)
})

test('new identity is generated once for concurrent callers and reused by a new service instance', async () => {
  const f = await fixture({ device: null })
  const identity = f.create()
  const [first, second] = await Promise.all([identity.getDeviceId(), identity.getDeviceId()])
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  assert.equal(second, first)
  assert.equal(f.calls.transactions, 1)
  assert.equal(f.calls.puts, 1)
  assert.equal(await f.create().getDeviceId(), first)
  assert.equal(f.calls.puts, 1)
})

test('identity and hash storage failures propagate; a failed identity read can recover without replacing history', async () => {
  const f = await fixture()
  const identity = f.create()
  f.failIdentity(true)
  await assert.rejects(identity.getDeviceId(), /identity read failed/)
  f.failIdentity(false)
  assert.equal(await identity.getDeviceId(), 'historical-device')
  f.failHashes(true)
  await assert.rejects(identity.getHashes(), /hash read failed/)
  f.failHashes(false)
  assert.deepEqual(await identity.getHashes(), new Map([['old-book', 'H1']]))
  assert.equal(f.calls.puts, 0)
})
