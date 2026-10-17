export interface NavigationStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}
const KEY = 'pagewise-last-view-v1'

export function restorableView(path: unknown): string | null {
  if (typeof path !== 'string' || path.length > 1024) return null
  if (/^\/(library|reading|notes|settings|stats|manual)$/.test(path)) return path
  return /^\/(book|read|read-paper)\/[^/?#\s]+$/.test(path) ? path : null
}

export function restoreView(storage: NavigationStorage): string {
  try {
    const raw = storage.getItem(KEY)
    if (!raw) return '/library'
    const value = JSON.parse(raw)
    return value?.version === 1 ? restorableView(value.path) ?? '/library' : '/library'
  } catch { return '/library' }
}

export function rememberView(path: unknown, storage: NavigationStorage): { success: boolean; error?: string } {
  const safe = restorableView(path)
  if (!safe) return { success: false, error: 'invalid_view' }
  try {
    // Query locations are temporary navigation requests, never a replacement for BookMeta.location.
    storage.setItem(KEY, JSON.stringify({ version: 1, path: safe }))
    return { success: true }
  } catch (error) { return { success: false, error: error instanceof Error ? error.message : 'storage_unavailable' } }
}
