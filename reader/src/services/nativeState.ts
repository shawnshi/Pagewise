/** Canonical Android state. The numeric bridge is capability-only; all data uses Rust IPC. */
import type { ReadingLogDelta, ReadingLogRow, ReadingLogStore } from './readingLog.ts'
import type { ReadingIdentity } from './localReadingIdentity.ts'

export type JsonObject = Record<string, unknown>
export type StateInvoke = (action: string, payload: JsonObject, libraryRoot?: string) => Promise<unknown>
export interface SettingsSnapshot { revision: number; raw: string }
export interface FieldValue { present: boolean; value?: unknown }
export interface SettingsPatch { path: string[]; before: FieldValue; after: FieldValue }
export type NativeStatus = { state: 'empty' | 'staging'; nextChunk?: number; stagedRows?: number }
  | { state: 'complete'; settings: SettingsSnapshot; rows: number }

export function hasNativeState(): boolean {
  const host = typeof window === 'undefined' ? undefined : window as Window & {
    LightReadInsets?: { nativeStorageVersion?: () => number }
  }
  return host?.LightReadInsets?.nativeStorageVersion?.() === 1
}

export function stateError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code })
}
export function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') return error.code
  return undefined
}
export function jsonObject(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw stateError('invalid_native_state')
  return value as JsonObject
}
export function parseStateObject(raw: string): JsonObject {
  try { return jsonObject(JSON.parse(raw)) } catch { throw stateError('invalid_state_json') }
}
export const jsonClone = <T>(value: T): T => {
  try { return JSON.parse(JSON.stringify(value)) as T } catch { throw stateError('invalid_settings_value') }
}
const object = (value: unknown): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value)
const equal = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b)
function canonical(value: unknown): string {
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const raw = JSON.stringify(value)
  if (raw === undefined) throw stateError('invalid_settings_value')
  return raw
}

/** Arrays are atomic; nested JSON object fields use existence/value CAS, never whole-state replacement. */
export function settingsDiff(before: JsonObject, after: JsonObject, path: string[] = []): SettingsPatch[] {
  const patches: SettingsPatch[] = []
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw stateError('invalid_settings_path')
    const oldPresent = Object.hasOwn(before, key), newPresent = Object.hasOwn(after, key)
    const old = before[key], next = after[key], at = [...path, key]
    if (oldPresent && newPresent && equal(old, next)) continue
    if (oldPresent && newPresent && object(old) && object(next) && at.length < 8) {
      patches.push(...settingsDiff(old, next, at))
    } else {
      patches.push({ path: at, before: oldPresent ? { present: true, value: jsonClone(old) } : { present: false },
        after: newPresent ? { present: true, value: jsonClone(next) } : { present: false } })
    }
  }
  return patches
}

/** Rebase only edits made while an ACK was in flight, leaving unrelated canonical changes intact. */
export function rebaseSettings(canonicalState: JsonObject, sent: JsonObject, local: JsonObject): JsonObject {
  const result = jsonClone(canonicalState)
  for (const patch of settingsDiff(sent, local)) {
    let parent = result
    for (const key of patch.path.slice(0, -1)) {
      if (!object(parent[key])) parent[key] = {}
      parent = jsonObject(parent[key])
    }
    const key = patch.path.at(-1)!
    if (patch.after.present) parent[key] = patch.after.value
    else delete parent[key]
  }
  return result
}

function snapshot(value: unknown): SettingsSnapshot {
  const v = jsonObject(value)
  if (!Number.isSafeInteger(v.revision) || Number(v.revision) < 1 || typeof v.raw !== 'string') throw stateError('invalid_native_settings')
  parseStateObject(v.raw)
  return { revision: Number(v.revision), raw: v.raw }
}

export class NativeStateClient {
  private current: SettingsSnapshot | null = null
  private mutationQueue: Promise<unknown> = Promise.resolve()
  private pending: { action: string; fields: string; payload: JsonObject; attempts: number } | null = null
  readonly invoke: StateInvoke
  constructor(invoke: StateInvoke) { this.invoke = invoke }
  acceptSettings(value: unknown): SettingsSnapshot {
    const next = snapshot(value)
    if (!this.current || next.revision >= this.current.revision) this.current = next
    return this.settingsSnapshot()
  }
  settingsSnapshot(): SettingsSnapshot {
    if (!this.current) throw stateError('native_state_not_initialized')
    return { ...this.current }
  }
  settings(): JsonObject { return parseStateObject(this.settingsSnapshot().raw) }
  async status(root?: string): Promise<NativeStatus> {
    const result = jsonObject(await this.invoke('status', {}, root))
    if (result.state === 'complete') {
      if (!Number.isSafeInteger(result.rows) || Number(result.rows) < 0) throw stateError('invalid_native_status')
      return { state: 'complete', rows: Number(result.rows), settings: snapshot(result.settings) }
    }
    if (result.state !== 'empty' && result.state !== 'staging') throw stateError('invalid_native_status')
    return { state: result.state }
  }
  async refreshSettings(): Promise<SettingsSnapshot> {
    return this.acceptSettings(await this.invoke('settingsGet', {}))
  }
  /** One immutable envelope, at most three executions. Unknown outcome must consult its receipt first. */
  mutate(action: string, fields: JsonObject): Promise<JsonObject> {
    const immutable = jsonClone(fields)
    const task = this.mutationQueue.then(() => this.runMutation(action, immutable))
    this.mutationQueue = task.catch(() => undefined)
    return task
  }
  /** Receipt-only recovery. An empty receipt cannot fence commands still entering the native executor. */
  reconcilePendingMutation(): Promise<void> {
    const task = this.mutationQueue.then(async () => {
      const pending = this.pending
      if (!pending) return
      const result = await this.receipt(pending.payload)
      if (!result) throw stateError('native_mutation_unresolved')
      if (pending.action === 'settingsPatch') this.acceptSettings(result)
      this.pending = null
    })
    this.mutationQueue = task.catch(() => undefined)
    return task
  }
  private async receipt(payload: JsonObject): Promise<JsonObject | null> {
    const receipt = jsonObject(await this.invoke('receipt', { requestId: payload.requestId }))
    if (receipt.found === false) return null
    if (receipt.found !== true || typeof receipt.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.fingerprint)) throw stateError('invalid_native_receipt')
    return jsonObject(receipt.result)
  }
  private async runMutation(action: string, fields: JsonObject): Promise<JsonObject> {
    this.settingsSnapshot()
    const signature = canonical(fields)
    if (this.pending && (this.pending.action !== action || this.pending.fields !== signature)) throw stateError('native_mutation_pending')
    if (this.pending) {
      // A failed receipt leaves the envelope live. Explicit caller retry must reconcile it before replay.
      const result = await this.receipt(this.pending.payload)
      if (result) { this.pending = null; return result }
    } else {
      this.pending = { action, fields: signature, payload: jsonClone({ ...fields, requestId: crypto.randomUUID(), createdAt: Date.now() }), attempts: 0 }
    }
    const pending = this.pending
    const payload = pending.payload
    if (pending.attempts >= 3) throw stateError('native_mutation_unresolved')
    while (pending.attempts < 3) {
      pending.attempts++
      try {
        const result = jsonObject(await this.invoke(action, payload))
        this.pending = null
        return result
      } catch (error) {
        const code = errorCode(error)
        if (code && !['unavailable', 'commit_outcome_unknown', 'location_receipt_error', 'native_state_error'].includes(code)) {
          this.pending = null
          throw error
        }
        // This may itself fail: retain pending, block unrelated mutations, never allocate a replacement UUID.
        const result = await this.receipt(payload)
        if (result) { this.pending = null; return result }
        // No receipt is not proof of non-admission: keep the original UUID fenced after the execution cap.
        if (pending.attempts === 3) throw error
      }
    }
    throw stateError('native_mutation_unresolved')
  }
  async patchSettings(patches: SettingsPatch[]): Promise<SettingsSnapshot> {
    if (!patches.length) return this.refreshSettings()
    if (patches.length > 512) throw stateError('resource_limit')
    if (patches.some(patch => patch.path[0] === 'libraryRoot')) throw stateError('library_move_required')
    try { return this.acceptSettings(await this.mutate('settingsPatch', { patches })) } catch (error) {
      if (errorCode(error) === 'settings_conflict') await this.refreshSettings()
      throw error
    }
  }
  private async pageAll(action: string): Promise<unknown[]> {
    this.settingsSnapshot()
    let after = ''
    const cursors = new Set<string>([''])
    const all: unknown[] = []
    for (;;) {
      const page = jsonObject(await this.invoke(action, { after, limit: 256 }))
      if (!Array.isArray(page.rows) || page.rows.length > 256 || typeof page.next !== 'string') throw stateError('invalid_native_page')
      if (!page.rows.length) {
        if (page.next !== after) throw stateError('invalid_native_page')
        return all
      }
      // SQLite orders UTF-8 keys, not JavaScript's UTF-16 code units. Detect stalled/cyclic cursors.
      if (cursors.has(page.next)) throw stateError('invalid_native_page')
      cursors.add(page.next)
      all.push(...page.rows)
      after = page.next
    }
  }
  readingStore(): ReadingLogStore {
    return {
      all: async () => {
        const { normalizeRow } = await import('./readingLog.ts')
        return (await this.pageAll('readingPage')).map(value => {
          const v = jsonObject(value), row = normalizeRow(v)
          if (!row || typeof v.seconds !== 'number') throw stateError('invalid_native_reading_row')
          return row
        })
      },
      add: async (deltas: ReadingLogDelta[], now: number) => {
        this.settingsSnapshot()
        if (deltas.length > 256) throw stateError('resource_limit')
        if (deltas.length) await this.mutate('readingAdd', { deltas, now })
      },
      putMax: async (rows: ReadingLogRow[]) => {
        this.settingsSnapshot()
        // Max merge is replay-safe across partial pages; settle any prior envelope before restarting.
        await this.reconcilePendingMutation()
        let changed = 0
        // Per-page atomicity; earlier pages can be committed if a later page fails. Max merge is replayable.
        for (let offset = 0; offset < rows.length; offset += 256) {
          const result = await this.mutate('readingPutMax', { rows: rows.slice(offset, offset + 256) })
          if (!Number.isSafeInteger(result.changed) || Number(result.changed) < 0) throw stateError('invalid_native_result')
          changed += Number(result.changed)
        }
        return changed
      },
    }
  }
  identity(): ReadingIdentity {
    return {
      getDeviceId: async () => {
        this.settingsSnapshot()
        const result = jsonObject(await this.invoke('identityGet', {}))
        if (typeof result.deviceId !== 'string' || !result.deviceId) throw stateError('invalid_native_identity')
        return result.deviceId
      },
      getHashes: async () => {
        const pairs = await this.pageAll('hashesPage')
        const map = new Map<string, string>()
        for (const pair of pairs) {
          if (!Array.isArray(pair) || pair.length !== 2 || pair.some(value => typeof value !== 'string' || !value) || map.has(pair[0])) throw stateError('invalid_native_hashes')
          map.set(pair[0], pair[1])
        }
        return map
      },
    }
  }
}

let native: NativeStateClient | undefined
let initializing: Promise<void> | undefined
export function getNativeState(): NativeStateClient {
  if (!native) throw stateError('native_state_not_initialized')
  native.settingsSnapshot()
  return native
}
/** Await BEFORE Pinia creation/mount and any getLibraryRoot()/reading access. Fail closed on Android. */
export function initializeNativeState(): Promise<void> {
  if (!hasNativeState()) return Promise.resolve()
  initializing ??= (async () => {
    const [{ invoke }, { migrateNativeState, legacyStateSource }, { normalizeLegacySettings }] = await Promise.all([
      import('@tauri-apps/api/core'), import('./nativeStateMigration.ts'), import('../stores/settings.ts'),
    ])
    const client = new NativeStateClient((action, payload, libraryRoot) => invoke('native_state', {
      action, payload, ...(libraryRoot === undefined ? {} : { libraryRoot }),
    }))
    await migrateNativeState(client, legacyStateSource(), normalizeLegacySettings)
    native = client
  })()
  return initializing
}
