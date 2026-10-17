import { sameValue } from './presets.ts'

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const owns = (value: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(value, key)

function validValue(key: string, value: unknown): boolean {
  if (key === 'reader.flow') return value === 'paginated' || value === 'scrolled'
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/** Normalize only retired preferences on an already-parsed settings object, before defaults merge. */
export function normalizeRetiredLyricSettings(saved: unknown): void {
  if (!object(saved) || !object(saved.readingMode)) return
  const mode = saved.readingMode
  const records = object(mode.presets) ? mode.presets : null
  const retired = records && object(records.lyric) ? records.lyric : null
  const reader = object(saved.reader) ? saved.reader : null
  if (records && retired && object(retired.before) && object(retired.applied) && typeof retired.order === 'number' && Number.isFinite(retired.order)) {
    for (const key of ['reader.flow', 'reader.fontSize', 'reader.lineHeight']) {
      if (!owns(retired.before, key) || !owns(retired.applied, key)) continue
      const before = retired.before[key]
      const applied = retired.applied[key]
      if (!validValue(key, before) || !validValue(key, applied)) continue
      let above: Record<string, unknown> | null = null
      for (const [id, candidate] of Object.entries(records)) {
        if (id === 'lyric' || !object(candidate) || !object(candidate.before) || !object(candidate.applied)) continue
        if (typeof candidate.order !== 'number' || !Number.isFinite(candidate.order) || candidate.order <= retired.order) continue
        if (!owns(candidate.applied, key) || !owns(candidate.before, key)) continue
        if (!above || candidate.order < Number(above.order)) above = candidate
      }
      // Transfer the removed layer's baseline to its immediate successor, never overwrite an upper layer or a manual adjustment.
      if (above && object(above.before)) {
        if (sameValue(above.before[key], applied)) above.before[key] = before
      } else if (reader) {
        const field = key.slice('reader.'.length)
        if (owns(reader, field) && sameValue(reader[field], applied)) reader[field] = before
      }
    }
  }
  if (records) delete records.lyric
  delete mode.lyric
  for (const key of ['tab', 'panelTab']) if (mode[key] === 'lyric') mode[key] = 'normal'
}
