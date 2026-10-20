import type { PagewiseCompanionPrefs } from '../../stores/settings.ts'

// These identifiers are persisted contracts from released APKs, not product/module names.
export const LEGACY_COMPANION_SETTINGS_KEY = 'dianjing'
export const LEGACY_COMPANION_MANUAL = '05-点睛阅读.md'
export const COMPANION_MANUAL = '05-伴读.md'

type StoredCompanionSettings = { pagewiseCompanion?: unknown; [key: string]: unknown }
export type SerializedCompanionSettings<T> = Omit<T, 'pagewiseCompanion'>
  & Record<typeof LEGACY_COMPANION_SETTINGS_KEY, PagewiseCompanionPrefs>

export function readCompanionPreferences(saved: StoredCompanionSettings | null | undefined): Partial<PagewiseCompanionPrefs> {
  const valid = (value: unknown): value is Partial<PagewiseCompanionPrefs> =>
    !!value && typeof value === 'object' && !Array.isArray(value)
  const legacy = saved?.[LEGACY_COMPANION_SETTINGS_KEY]
  const canonical = saved?.pagewiseCompanion
  let source: Partial<PagewiseCompanionPrefs> = {}
  if (valid(canonical)) source = canonical
  else if (valid(legacy)) source = legacy
  const preferences = { ...source }
  for (const key of ['consentAll', 'enabled'] as const) {
    if (Object.hasOwn(preferences, key)) preferences[key] = preferences[key] === true
  }
  if (Object.hasOwn(preferences, 'perBook')) {
    const overrides = preferences.perBook
    // Preserve denials under existing global consent; otherwise malformed entries must not invent consent history.
    preferences.perBook = overrides && typeof overrides === 'object' && !Array.isArray(overrides)
      ? Object.fromEntries(Object.entries(overrides)
        .filter(([, enabled]) => typeof enabled === 'boolean' || preferences.consentAll === true)
        .map(([bookId, enabled]) => [bookId, enabled === true]))
      : {}
  }
  return preferences
}

/** Preserve downgrade/sync compatibility without exposing the legacy key in runtime state. */
export function serializeCompanionSettings<T extends { pagewiseCompanion: PagewiseCompanionPrefs }>(state: T): SerializedCompanionSettings<T> {
  const { pagewiseCompanion, ...rest } = state
  return { ...rest, [LEGACY_COMPANION_SETTINGS_KEY]: pagewiseCompanion }
}

export function companionManualFile(file: string): string {
  return file === LEGACY_COMPANION_MANUAL ? COMPANION_MANUAL : file
}
