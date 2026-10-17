import { reactive } from 'vue'

export interface ToastAction {
  label: string
  run: () => void
}

export interface Toast {
  id: number
  message: string
  type: 'info' | 'success' | 'error'
  /** 可选的操作按钮 (如「打开」), 点击后执行并关闭提示 */
  action?: ToastAction
  dismiss: () => void
}

export const toasts = reactive<Toast[]>([])

let nextId = 1

/** 显示提示; 返回的函数可提前关闭 (如加载完成后撤下「正在加载」) */
export function toast(message: string, type: Toast['type'] = 'info', duration = 2600, action?: ToastAction): () => void {
  const id = nextId++
  const dismiss = () => {
    const i = toasts.findIndex(t => t.id === id)
    if (i >= 0) toasts.splice(i, 1)
  }
  toasts.push({ id, message, type, action, dismiss })
  setTimeout(dismiss, duration)
  return dismiss
}
