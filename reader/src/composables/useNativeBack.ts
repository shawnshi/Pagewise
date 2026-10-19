/**
 * 页面级 Android Back 接管 (MainActivity 已把系统返回先交给 window.__pagewiseReaderBack,
 * 返回 false 时再走原生回退)。阅读页自己管理这个槽位优先保存进度; 普通页面只在
 * 有弹层 / 管理态需要逐级退出时占用, 不改变没有弹层时的默认返回行为。
 *
 * Vue Router 切换路由时先卸载旧页面再挂载新页面, 所以“仅当槽位为空才登记”不会
 * 让上一页残留处理器覆盖新页面; 卸载时也只删除自己登记的处理器。
 */
import { onBeforeUnmount, onMounted } from 'vue'

export type NativeBackHandler = () => boolean

export interface NativeBackHost {
  __pagewiseReaderBack?: () => boolean
}

export interface NativeBackSlot {
  install(): void
  dispose(): void
}

/** 纯净的槽位逻辑 (可单测): 不抢占已有处理器, 只删除自己登记的处理器。 */
export function claimNativeBack(host: NativeBackHost, handler: NativeBackHandler): NativeBackSlot {
  let alive = true
  const consume = (): boolean => {
    if (!alive || host.__pagewiseReaderBack !== consume) return false
    return handler()
  }
  return {
    install() {
      if (!host.__pagewiseReaderBack) host.__pagewiseReaderBack = consume
    },
    dispose() {
      alive = false
      if (host.__pagewiseReaderBack === consume) delete host.__pagewiseReaderBack
    },
  }
}

export function useNativeBack(handler: NativeBackHandler): void {
  // SAFETY: The Android shell injects this optional property on window; TypeScript's Window type cannot declare it.
  const slot = claimNativeBack(window as unknown as NativeBackHost, handler)
  onMounted(() => {
    slot.install()
    // 同一次路由 patch 中旧页面可能晚于本页卸载: 下一个微任务再补登记一次。
    void Promise.resolve().then(slot.install)
  })
  onBeforeUnmount(slot.dispose)
}
