import type { InjectionKey } from 'vue'

export const readerActivityKey: InjectionKey<() => () => void> = Symbol('readerActivity')
export const isReaderPath = (path: string) => /^\/read(?:\/|-(?:paper|pdf)\/)/.test(path)

/** App owns committed routes; reader instances can only report failure for their captured epoch. */
export function createReaderActivity(setReading: (active: boolean) => void) {
  let key: string | undefined, epoch = 0, active = false, disposed = false
  const set = (next: boolean) => { if (next !== active) { active = next; setReading(next) } }
  return {
    commit(nextKey: string, path: string) {
      if (disposed || nextKey === key) return
      key = nextKey; epoch++; set(isReaderPath(path))
    },
    captureFailure() {
      const captured = epoch
      return () => { if (!disposed && captured === epoch) set(false) }
    },
    dispose() { if (disposed) return; disposed = true; epoch++; set(false) },
  }
}
