import { onScopeDispose, ref, type Ref } from 'vue'
import { isPortraitView } from '../services/portraitLayout'

/**
 * 是否按竖屏排版 (见 isPortraitView): 旋转屏幕 / 拖动窗口时实时更新,
 * 屏幕键盘弹出压矮视口时保持不变。
 */
export function usePortraitView(): Ref<boolean> {
  if (typeof window === 'undefined') return ref(false)
  const read = () => isPortraitView({
    width: window.innerWidth,
    height: window.innerHeight,
    screenWidth: window.screen?.width,
    screenHeight: window.screen?.height,
    orientationType: window.screen?.orientation?.type,
    legacyOrientation: typeof (window as any).orientation === 'number' ? (window as any).orientation : undefined,
  })
  const portrait = ref(read())
  const update = () => {
    const next = read()
    if (next !== portrait.value) portrait.value = next
  }
  window.addEventListener('resize', update)
  window.addEventListener('orientationchange', update)
  window.screen?.orientation?.addEventListener?.('change', update)
  onScopeDispose(() => {
    window.removeEventListener('resize', update)
    window.removeEventListener('orientationchange', update)
    window.screen?.orientation?.removeEventListener?.('change', update)
  })
  return portrait
}
