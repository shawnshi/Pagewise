import { errorCode, jsonObject, parseStateObject, stateError, type NativeStateClient } from './nativeState.ts'

export interface LegacySnapshot { rows: unknown[]; deviceId: unknown; hashes: unknown[] }
export interface LegacyStateSource {
  settings(): string | null
  snapshot(): Promise<LegacySnapshot>
}

/** Read-only transactions only. Aborting a first-open upgrade leaves a missing legacy DB missing. */
async function openExisting(name: string): Promise<IDBDatabase | null> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name)
    let absent = false
    request.onupgradeneeded = event => {
      absent = event.oldVersion === 0
      request.transaction!.abort()
    }
    let blocked = false
    request.onsuccess = () => {
      if (blocked) request.result.close()
      else resolve(request.result)
    }
    request.onerror = () => absent ? resolve(null) : reject(stateError('legacy_database_open_failed'))
    request.onblocked = () => { blocked = true; reject(stateError('legacy_database_blocked')) }
  })
}

async function readLegacy(name: string, stores: string[]): Promise<{ rows: unknown[]; deviceId: unknown; hashes: unknown[] }> {
  const database = await openExisting(name)
  if (!database) return { rows: [], deviceId: null, hashes: [] }
  try {
    for (const store of stores) if (!database.objectStoreNames.contains(store)) throw stateError('legacy_database_schema_mismatch')
    return await new Promise((resolve, reject) => {
      const tx = database.transaction(stores, 'readonly')
      let rows: unknown[] = [], hashes: unknown[] = [], deviceId: unknown = null
      const readAll = (store: string, max: number, accept: (values: unknown[]) => void) => {
        const table = tx.objectStore(store)
        const count = table.count()
        count.onsuccess = () => {
          if (count.result > max) { reject(stateError('resource_limit')); tx.abort(); return }
          const request = table.getAll()
          request.onsuccess = () => accept(request.result)
        }
      }
      // Count and read within one readonly transaction: a stable primary-key-ordered source snapshot.
      if (stores.includes('log')) readAll('log', 2_000_000, values => { rows = values })
      if (stores.includes('hashes')) {
        readAll('hashes', 100000, values => { hashes = values })
        // Never enumerate kv: retired account/baseline values must not cross the migration boundary.
        const identity = tx.objectStore('kv').get('deviceId')
        identity.onsuccess = () => {
          try { deviceId = identity.result === undefined ? null : jsonObject(identity.result).value }
          catch (error) { reject(error); tx.abort() }
        }
      }
      tx.oncomplete = () => resolve({ rows, deviceId, hashes })
      tx.onerror = () => reject(stateError('legacy_database_read_failed'))
      tx.onabort = () => reject(stateError('legacy_database_read_aborted'))
    })
  } finally { database.close() }
}

export function legacyStateSource(): LegacyStateSource {
  return {
    settings: () => localStorage.getItem('lightread-settings'),
    snapshot: async () => {
      const [stats, identity] = await Promise.all([
        readLegacy('lightread-stats', ['log']), readLegacy('lightread-sync', ['kv', 'hashes']),
      ])
      return { rows: stats.rows, deviceId: identity.deviceId, hashes: identity.hashes }
    },
  }
}

function sourceRoot(raw: string | null): string {
  if (raw === null) return ''
  const settings = parseStateObject(raw)
  if (!Object.hasOwn(settings, 'libraryRoot')) return ''
  if (typeof settings.libraryRoot !== 'string') throw stateError('invalid_legacy_library_root')
  return settings.libraryRoot
}

function identityJson(source: LegacySnapshot): string {
  if (source.deviceId !== null && (typeof source.deviceId !== 'string' || !source.deviceId || source.deviceId.includes('|'))) throw stateError('invalid_legacy_identity')
  const seen = new Set<string>()
  const hashes = source.hashes.map(item => {
    const row = jsonObject(item)
    if (typeof row.id !== 'string' || !row.id || typeof row.hash !== 'string' || !row.hash || seen.has(row.id)) throw stateError('invalid_legacy_hash')
    seen.add(row.id)
    return [row.id, row.hash]
  })
  return JSON.stringify({ deviceId: source.deviceId, hashes })
}

function validateRows(rows: unknown[]): void {
  if (rows.length > 2_000_000) throw stateError('resource_limit')
  const seen = new Set<string>()
  for (const item of rows) {
    const row = jsonObject(item)
    if (typeof row.key !== 'string' || !/^[^|]+\|\d{4}-\d{2}-\d{2}\|(id:|h:).+$/.test(row.key) || seen.has(row.key) ||
      typeof row.seconds !== 'number' || !Number.isFinite(row.seconds) || row.seconds <= 0 ||
      (row.updatedAt !== undefined && row.updatedAt !== null && (typeof row.updatedAt !== 'number' || !Number.isFinite(row.updatedAt)))) throw stateError('invalid_legacy_reading_row')
    seen.add(row.key)
  }
}

/** Replays every ordinal (including acknowledged chunks) so changed raw source cannot pass unnoticed. */
export async function migrateNativeState(client: NativeStateClient, source: LegacyStateSource,
  normalize: (raw: string | null) => object): Promise<void> {
  let root: string | undefined
  let raw: string | null | undefined
  let status
  try { status = await client.status() } catch (error) {
    if (errorCode(error) !== 'migration_not_initialized') throw error
    raw = source.settings()
    root = sourceRoot(raw)
    status = await client.status(root)
  }
  if (status.state === 'complete') {
    client.acceptSettings(status.settings)
    return
  }
  raw = raw === undefined ? source.settings() : raw
  // A staging store without a locator still needs the exact explicit root for every command.
  root ??= sourceRoot(raw)
  const settings = JSON.stringify(normalize(raw))
  const legacy = await source.snapshot()
  validateRows(legacy.rows)
  const identity = identityJson(legacy)
  const count = legacy.rows.length
  const begun = jsonObject(await client.invoke('migrationBegin', { settings, identity, rows: count, chunks: Math.ceil(count / 256) }, root))
  if (begun.state !== 'complete') {
    for (let offset = 0; offset < count; offset += 256) {
      await client.invoke('migrationChunk', { ordinal: offset / 256, rows: JSON.stringify(legacy.rows.slice(offset, offset + 256)) }, root)
    }
    await client.invoke('migrationCommit', {}, root)
  }
  const completed = await client.status(root)
  if (completed.state !== 'complete') throw stateError('migration_incomplete')
  client.acceptSettings(completed.settings)
}
