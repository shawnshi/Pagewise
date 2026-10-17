import { onScopeDispose, ref, type Ref } from 'vue'

/** 响应式 matchMedia: 旋转屏幕 / 拖动窗口时实时更新; 不支持 matchMedia 的环境恒为 false */
export function useMediaQuery(query: string): Ref<boolean> {
  const mql = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(query)
    : null
  const matches = ref(!!mql?.matches)
  if (!mql) return matches
  const onChange = (e: MediaQueryListEvent) => { matches.value = e.matches }
  // 旧 WebView (Safari < 14) 只有 addListener
  if (typeof mql.addEventListener === 'function') mql.addEventListener('change', onChange)
  else mql.addListener?.(onChange)
  onScopeDispose(() => {
    if (typeof mql.removeEventListener === 'function') mql.removeEventListener('change', onChange)
    else mql.removeListener?.(onChange)
  })
  return matches
}
