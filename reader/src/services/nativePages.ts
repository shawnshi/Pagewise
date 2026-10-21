/** Real Android Views own seven management routes; this module only brokers existing non-UI business services. */
import { invoke } from '@tauri-apps/api/core'
import type { Pinia } from 'pinia'
import type { Router } from 'vue-router'
import { getStorage } from '../storage'
import { useLibrary } from '../stores/library'
import { useSettings } from '../stores/settings'
import { createNativeManagementActions } from './nativeManagementActions'
import { createNativeBookTocActions } from './nativeBookTocAction'
import { createNativeLibraryActions } from './nativeLibraryActions'
import { createNativeStatsActions } from './nativeStatsActions'
import { createNativeSettingsActions } from './nativeSettingsEditing'
import { createNativePageVisibility, type NativeVisibilityResult } from './nativePageVisibility'
import { errorCode, getNativeState, hasNativeState, jsonClone, jsonObject, stateError, type JsonObject } from './nativeState'
export { applyNativeSettingsEdits as applyNativeUiSettingsPatches } from './nativeSettingsEditing'
import { toast } from './toast'

export function hasNativePages(): boolean {
  const host = typeof window === 'undefined' ? undefined : window as Window & { LightReadInsets?: { nativePagesVersion?: () => number } }
  return host?.LightReadInsets?.nativePagesVersion?.() === 1
}
const codeOf = (error: unknown) => (errorCode(error) ?? 'native_action_error').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80)
const safePath = (path: string) => path === '@back' || /^\/(?:library|reading|notes|stats|settings|manual)(?:\?[^#]*)?$/.test(path) || /^\/(?:book|read|read-pdf)\/[^/?#]+(?:\?[^#]*)?$/.test(path)

let installed = false
let visibility: ReturnType<typeof createNativePageVisibility> | undefined
export async function initializeNativePages(router: Router, pinia: Pinia): Promise<void> {
  if (!hasNativePages()) return
  if (!hasNativeState()) throw stateError('native_protocol_mismatch')
  if (installed) throw stateError('native_pages_already_initialized')
  await getStorage() // Retain the existing book schema/init, never invent a substitute native book DB.
  const settings = useSettings(pinia)
  const actions = { ...createNativeManagementActions(), ...createNativeSettingsActions(settings, getNativeState()), ...createNativeStatsActions(), ...createNativeLibraryActions(), ...createNativeBookTocActions() }
  const recover = async () => {
    const report = await settings.reloadNativeSettings()
    if (report.unsavedPaths.length || report.failedCommits.length) throw stateError('native_settings_unsaved')
  }
  const replies = new Map<string, { promise: Promise<JsonObject>; acknowledged: boolean }>()
  const deliver = async (requestId: string, result: JsonObject | null, error: string | null) => {
    // Reply delivery may retry the SAME nonce; it never repeats an import, restore, generation or mutation.
    for (let attempt = 0; attempt < 3; attempt++) {
      try { await invoke('native_page', { action: 'reply', payload: { requestId, result, error } }); return true }
      catch { /* No raw payload/key/error logging. Native host keeps its unknown-outcome fence. */ }
    }
    return false
  }
  const onAction = (event: Event) => {
    void (async () => {
      const detail = jsonObject((event as CustomEvent).detail)
      const requestId = detail.requestId, action = detail.action
      if (typeof requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(requestId) || typeof action !== 'string' || !Object.hasOwn(actions, action)) return
      let entry = replies.get(requestId)
      if (!entry) {
        for (const [id, previous] of replies) if (previous.acknowledged && replies.size >= 64) replies.delete(id)
        if (replies.size >= 64) { await deliver(requestId, null, 'resource_limit'); return }
        const payload = jsonClone(jsonObject(detail.payload))
        entry = { promise: Promise.resolve().then(() => actions[action]!(payload)).then(jsonObject), acknowledged: false }
        replies.set(requestId, entry)
      }
      try { entry.acknowledged = await deliver(requestId, await entry.promise, null) }
      catch (error) { entry.acknowledged = await deliver(requestId, null, codeOf(error)) }
    })().catch(() => { toast('原生操作消息未完成，请保留当前输入并核对。', 'error') })
  }
  const onStateChanged = () => { void recover().catch(() => toast('设置尚有未保存内容或提交结果未确认；请先核对，不能自动丢弃。', 'error', 12000)) }
  const onNavigate = (event: Event) => {
    void (async () => {
      const path = jsonObject((event as CustomEvent).detail).path
      if (typeof path !== 'string' || !safePath(path)) throw stateError('invalid_route')
      await recover()
      if (path === '@back') {
        const back = router.options.history.state.back
        if (typeof back === 'string' && safePath(back)) router.back()
        else await router.push('/library')
      } else {
        if (/^\/read(?:\/|-pdf\/)/.test(path)) await useLibrary(pinia).refresh()
        await router.push(path)
      }
    })().catch(() => toast('导航未完成；请先核对未保存设置或当前输入。', 'error'))
  }
  window.addEventListener('pagewise-native-action', onAction)
  window.addEventListener('pagewise-native-navigate', onNavigate)
  window.addEventListener('pagewise-native-state-changed', onStateChanged)
  try {
    const ready = jsonObject(await invoke('native_page', { action: 'ready', payload: { handlers: Object.keys(actions) } }))
    if (ready.ready !== true || ready.version !== 1 || typeof ready.session !== 'string' || ready.visibilityLeaseMs !== 30_000) throw stateError('invalid_native_receipt')
    visibility = createNativePageVisibility(ready.session, (action, payload) => invoke('native_page', { action, payload }))
    installed = true
  } catch (error) {
    window.removeEventListener('pagewise-native-action', onAction)
    window.removeEventListener('pagewise-native-navigate', onNavigate)
    window.removeEventListener('pagewise-native-state-changed', onStateChanged)
    throw error // Never mount legacy management/settings after a native initialization failure.
  }
}
export async function showNativePage(page: string, params: JsonObject, owner: string): Promise<NativeVisibilityResult> {
  if (!installed || !visibility) throw stateError('native_pages_not_ready')
  return visibility.show(owner, page, params)
}
export async function hideNativePage(owner: string): Promise<NativeVisibilityResult> {
  return visibility ? visibility.hide(owner) : { applied: false, obsolete: true }
}

