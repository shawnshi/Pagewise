import type Dexie from 'dexie'
import type { Table } from 'dexie'

interface KvRow { key: string; value: unknown }
interface HashRow { id: string; hash: string }

export interface ReadingIdentity {
  getDeviceId(): Promise<string>
  getHashes(): Promise<Map<string, string>>
}

/** Keep the historical identity and hash mapping without opening baseline or account values. */
export function createReadingIdentity(): ReadingIdentity {
  type Db = Dexie & { kv: Table<KvRow, string>; hashes: Table<HashRow, string> }
  let dbPromise: Promise<Db> | null = null
  const db = () => {
    dbPromise ??= import('dexie').then(({ default: DexieCtor }) => {
      const database = new DexieCtor('lightread-sync') as Db
      database.version(1).stores({ kv: 'key', hashes: 'id' })
      return database
    })
    return dbPromise
  }
  let deviceId: Promise<string> | null = null
  return {
    getDeviceId() {
      deviceId ??= (async () => {
        const database = await db()
        return database.transaction('rw', database.kv, async () => {
          const row = await database.kv.get('deviceId')
          if (typeof row?.value === 'string' && row.value) return row.value
          const id = crypto.randomUUID()
          await database.kv.put({ key: 'deviceId', value: id })
          return id
        })
      })().catch(error => { deviceId = null; throw error })
      return deviceId
    },
    async getHashes() {
      const rows = await (await db()).hashes.toArray()
      return new Map(rows.map(row => [row.id, row.hash]))
    },
  }
}
