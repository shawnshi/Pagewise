/** Editing policy, deliberately separate from permissive historical migration normalization. */
import { AI_PROVIDERS, isSelectableAiProvider } from './aiProviders.ts'
import { errorCode, jsonClone, jsonObject, stateError, type JsonObject, type NativeStateClient } from './nativeState.ts'
import type { NativeSettingsRecovery } from '../stores/settings.ts'
import { calibrationStatus, measureTypographyCalibration } from './readerTypographyProfiles.ts'
import type { NativeManagementHandler } from './nativeManagementActions.ts'

export interface NativeSettingField {
  path: string[]; label: string; labelEn: string; group: string
  kind: 'string' | 'number' | 'boolean' | 'enum'
  options?: readonly (string | number)[]; min?: number; max?: number; integer?: boolean; maxLength?: number; secret?: boolean
}
const field = (name: string, label: string, labelEn: string, group: string, kind: NativeSettingField['kind'], extra: Partial<NativeSettingField> = {}): NativeSettingField => ({ path: name.split('.'), label, labelEn, group, kind, ...extra })
export const NATIVE_SETTINGS_FIELDS: readonly NativeSettingField[] = Object.freeze([
  field('language', '界面语言', 'Language', 'general', 'enum', { options: ['zh', 'en'] }),
  field('appearance', '界面外观', 'Appearance', 'general', 'enum', { options: ['system', 'light', 'dark'] }),
  field('dailyGoalMinutes', '每日目标（分钟）', 'Daily goal (minutes)', 'general', 'number', { min: 0, max: 1440, integer: true }),
  field('pdf.renderer', 'PDF 渲染器', 'PDF renderer', 'reading', 'enum', { options: ['mupdf', 'pdfium'] }),
  field('reader.fontSize', '字号', 'Font size', 'reading', 'number', { min: 8, max: 64, integer: true }),
  field('reader.lineHeight', '行高', 'Line height', 'reading', 'number', { min: 1, max: 3 }),
  field('reader.gap', '页边距', 'Page margin', 'reading', 'number', { min: 2, max: 20, integer: true }),
  field('reader.theme', '阅读主题', 'Reader theme', 'reading', 'enum', { options: ['auto', 'light', 'sepia', 'green', 'dark'] }),
  field('reader.flow', '翻页方式', 'Reading flow', 'reading', 'enum', { options: ['paginated', 'scrolled'] }),
  field('reader.maxColumnCount', '栏数', 'Columns', 'reading', 'enum', { options: [1, 2] }),
  field('reader.continuousScroll', '跨章连续滚动', 'Continuous chapter scroll', 'reading', 'boolean'),
  field('reader.portraitScroll', '竖屏单栏滚动', 'Portrait single-column scroll', 'reading', 'boolean'),
  field('reader.justify', '两端对齐', 'Justify', 'reading', 'boolean'),
  field('reader.letterSpacing', '字距', 'Letter spacing', 'reading', 'number', { min: 0, max: 0.5 }),
  field('reader.fontFamily', '正文字体', 'Reader font', 'reading', 'string', { maxLength: 1024 }),
  field('reader.progressDisplay', '进度显示', 'Progress display', 'reading', 'enum', { options: ['both', 'page', 'percent'] }),
  field('pdf.mode', 'PDF 翻页方式', 'PDF flow', 'reading', 'enum', { options: ['paged', 'scroll'] }),
  field('pdf.fit', 'PDF 适配', 'PDF fit', 'reading', 'enum', { options: ['fitH', 'fitW'] }),
  field('pdf.spreadMode', 'PDF 布局', 'PDF layout', 'reading', 'enum', { options: ['single', 'facing', 'book'] }),
  field('autoReadSeconds', '自动阅读秒数/屏', 'Auto reading seconds/screen', 'reading', 'number', { min: 3, max: 300 }),
  field('ttsEngine', '朗读引擎', 'Speech engine', 'reading', 'enum', { options: ['edge', 'local', 'system'] }),
  field('ttsRate', '朗读语速', 'Speech rate', 'reading', 'number', { min: 0.5, max: 2 }),
  field('ttsVoice', '系统音色', 'System voice', 'reading', 'string', { maxLength: 1024 }),
  field('edgeVoice', '在线音色', 'Online voice', 'reading', 'string', { maxLength: 1024 }),
  field('localVoiceId', '本地音色编号', 'Local voice', 'reading', 'number', { min: 0, max: 102, integer: true }),
  field('aiBaseUrl', 'API 地址', 'API base URL', 'ai', 'string', { maxLength: 4096 }),
  field('aiApiKey', 'API Key', 'API Key', 'ai', 'string', { maxLength: 16384, secret: true }),
  field('aiModel', '模型', 'Model', 'ai', 'string', { maxLength: 1024 }),
  field('httpProxy', '网络代理', 'Network proxy', 'network', 'string', { maxLength: 4096, secret: true }),
  field('corsProxy', '跨域代理模板', 'CORS proxy template', 'network', 'string', { maxLength: 4096 }),
])

export function nativeSettingOptionLabel(value: unknown, language: 'zh' | 'en', path: readonly string[] = []): string {
  if (path.join('.') === 'reader.maxColumnCount') return String(value) === '1' ? (language === 'en' ? 'Single column' : '单栏') : String(value) === '2' ? (language === 'en' ? 'Two columns' : '双栏') : String(value)
  if (path.join('.') === 'ttsEngine' && value === 'system') return language === 'en' ? 'System speech' : '系统朗读'
  const options: Record<string, readonly [string, string]> = {
    true: ['开启', 'On'], false: ['关闭', 'Off'], zh: ['简体中文', 'Simplified Chinese'], en: ['English', 'English'],
    system: ['跟随系统', 'System'], light: ['浅色', 'Light'], dark: ['深色', 'Dark'], auto: ['自动', 'Automatic'],
    sepia: ['米色', 'Sepia'], green: ['绿色', 'Green'], paginated: ['分页', 'Paginated'], scrolled: ['滚动', 'Scrolled'],
    paged: ['分页', 'Paged'], scroll: ['连续滚动', 'Continuous scroll'], fitH: ['适合高度', 'Fit height'], fitW: ['适合宽度', 'Fit width'],
    single: ['单页', 'Single page'], facing: ['对页', 'Facing pages'], book: ['书籍对页', 'Book spread'],
    both: ['页码与百分比', 'Page and percentage'], page: ['页码', 'Page'], percent: ['百分比', 'Percentage'],
    edge: ['在线朗读', 'Online speech'], local: ['本地朗读', 'Local speech'], mupdf: ['MuPDF', 'MuPDF'], pdfium: ['PDFium', 'PDFium'],
  }
  const pair = options[String(value)]
  return pair ? pair[language === 'en' ? 1 : 0] : String(value)
}

function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => same(v, b[i]))
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const x = jsonObject(a), y = jsonObject(b), keys = Object.keys(x)
    return keys.length === Object.keys(y).length && keys.every(k => Object.hasOwn(y, k) && same(x[k], y[k]))
  }
  return false
}
function validateValue(rule: NativeSettingField, value: unknown): void {
  if (rule.kind === 'enum') { if (!rule.options?.some(option => Object.is(option, value))) throw stateError('invalid_setting_value'); return }
  if (rule.kind === 'boolean') { if (typeof value !== 'boolean') throw stateError('invalid_setting_value'); return }
  if (rule.kind === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value) || (rule.integer && !Number.isSafeInteger(value)) || value < rule.min! || value > rule.max!) throw stateError('invalid_setting_value')
    return
  }
  if (typeof value !== 'string' || value.length > (rule.maxLength ?? 4096) || value.includes('\0')) throw stateError('invalid_setting_value')
  const key = rule.path[0]
  if (value && ['aiBaseUrl', 'httpProxy', 'corsProxy'].includes(key!)) {
    let url: URL
    try { url = new URL(value.replace('{url}', 'https://example.invalid/')) } catch { throw stateError('invalid_setting_value') }
    const protocols = key === 'httpProxy' ? ['http:', 'https:', 'socks4:', 'socks5:'] : ['http:', 'https:']
    if (!protocols.includes(url.protocol)) throw stateError('invalid_setting_value')
  }
}
export function applyNativeSettingsEdits(root: JsonObject, input: unknown): JsonObject {
  if (!Array.isArray(input) || !input.length || input.length > 512) throw stateError('invalid_payload')
  const result = jsonClone(root), seen: string[][] = []
  for (const raw of input) {
    const patch = jsonObject(raw), path = patch.path
    if (!Array.isArray(path) || !path.length || path.some(key => typeof key !== 'string' || !key || key.length > 256 || ['__proto__', 'constructor', 'prototype'].includes(key))) throw stateError('invalid_payload')
    const keys = path as string[]
    const rule = NATIVE_SETTINGS_FIELDS.find(f => f.path.length === keys.length && f.path.every((key, i) => key === keys[i]))
    if (!rule) throw stateError('protected_setting')
    if (seen.some(p => p.slice(0, keys.length).every((key, i) => key === keys[i]) || keys.slice(0, p.length).every((key, i) => key === p[i]))) throw stateError('invalid_payload')
    seen.push(keys)
    const before = jsonObject(patch.before), after = jsonObject(patch.after)
    if (typeof before.present !== 'boolean' || after.present !== true || !Object.hasOwn(after, 'value')) throw stateError('invalid_payload')
    let object = result
    for (const key of keys.slice(0, -1)) object = jsonObject(object[key])
    const key = keys.at(-1)!
    if (Object.hasOwn(object, key) !== before.present || (before.present && !same(object[key], before.value))) throw stateError('settings_conflict')
    validateValue(rule, after.value)
    object[key] = jsonClone(after.value)
  }
  return result
}
export interface NativeSettingsOwner {
  flushNativeSettings(): Promise<void>
  reloadNativeSettings(): Promise<NativeSettingsRecovery>
  resolveNativeSettingsRecovery(token: string, choice: 'retry' | 'discard', metrics?: NativeCalibrationMetrics): Promise<void>
  commitNativeSettingsEdits(next: JsonObject): Promise<void>
  selectAiProvider(id: string): void
  resetReader(): void
  setTypographyCalibration(value: unknown): void | Promise<void>
}
export interface NativeCalibrationMetrics { dpr: number; textScale: number }
export interface NativeSettingsProbes { ai(signal: AbortSignal): Promise<void>; proxy(signal: AbortSignal): Promise<void> }
const defaultProbes: NativeSettingsProbes = {
  async ai(signal) {
    const { aiConfigured, chatStream } = await import('./ai.ts')
    if (!aiConfigured()) throw stateError('ai_not_configured')
    let got = ''
    for await (const delta of chatStream([{ role: 'user', content: '请回复: OK' }], signal)) { got = (got + delta.slice(0, 512)).slice(-512); if (got.trim().length >= 2) break }
    if (!got.trim()) throw stateError('ai_empty_reply')
  },
  async proxy(signal) {
    const { fetchRemote } = await import('./net.ts')
    const response = await fetchRemote('https://www.google.com/generate_204', undefined, { signal })
    await response.body?.cancel()
  },
}
export function createNativeSettingsActions(owner: NativeSettingsOwner,
  client: Pick<NativeStateClient, 'settings' | 'patchSettings' | 'settingsSnapshot'>,
  metrics: () => Promise<NativeCalibrationMetrics> = async () => {
    const { measureTextScale } = await import('./fonts.ts')
    const textScale = measureTextScale(document), dpr = globalThis.devicePixelRatio
    if (textScale === null || !Number.isFinite(dpr)) throw stateError('calibration_context_unavailable')
    return { dpr, textScale }
  }, probes: NativeSettingsProbes = defaultProbes): Record<string, NativeManagementHandler> {
  let measurement: { token: string; dpr: number; textScale: number } | null = null
  let activeProbe: Promise<void> | null = null
  const barrier = async () => {
    await owner.flushNativeSettings()
    const recovery = await owner.reloadNativeSettings()
    if (recovery.unsavedPaths.length || recovery.failedCommits.length) throw stateError('native_settings_unsaved')
  }
  const done = async () => { await owner.reloadNativeSettings(); return { ok: true, ...client.settingsSnapshot() } }
  const probe = async (kind: keyof NativeSettingsProbes, payload: JsonObject) => {
    if (payload.confirm !== true) throw stateError('confirmation_required')
    if (activeProbe) throw stateError('native_probe_in_progress')
    await barrier()
    if (activeProbe) throw stateError('native_probe_in_progress')
    const control = new AbortController(), started = performance.now()
    // A UI timeout is not proof that the remote request stopped. Keep one live probe until it physically settles.
    const work = Promise.resolve().then(() => probes[kind](control.signal)).finally(() => { if (activeProbe === work) activeProbe = null })
    activeProbe = work
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { const error = stateError('native_probe_timeout'); control.abort(error); reject(error) }, 20_000) })
    try { await Promise.race([work, deadline]); control.signal.throwIfAborted(); return { ok: true, elapsedMs: Math.round(performance.now() - started) } }
    catch (error) { if (control.signal.aborted) throw stateError('native_probe_timeout'); throw error }
    finally { clearTimeout(timer) }
  }
  let needsCalibration = false
  const inspect = async () => {
    try {
      const report = await owner.reloadNativeSettings()
      const dirty = report.unsavedPaths.length > 0 || report.failedCommits.length > 0
      needsCalibration = report.failedCommits.some(d => d.paths?.some(p => p[0] === 'typographyCalibration'))
      return { ok: true, state: dirty ? 'decision_required' : 'clean', ...report }
    } catch (error) {
      // Transport errors may contain credentials; only fixed state and paths/counts cross this boundary.
      const unresolved = ['native_mutation_unresolved', 'native_mutation_pending', 'commit_outcome_unknown', 'unavailable'].includes(errorCode(error) ?? '')
      return { ok: true, state: unresolved ? 'unresolved' : 'unavailable', unsavedPaths: [], failedCommits: [] }
    }
  }
  const actions: Record<string, NativeManagementHandler> = {
    settingsRecoveryInspect: () => inspect(),
    settingsRecoveryDecide: async p => {
      if (typeof p.token !== 'string' || !['retry', 'discard'].includes(String(p.choice)) || p.confirm !== true) throw stateError('invalid_recovery_decision')
      await owner.resolveNativeSettingsRecovery(p.token, p.choice === 'retry' ? 'retry' : 'discard', p.choice === 'retry' && needsCalibration ? await metrics() : undefined)
      measurement = null
      return inspect()
    },
    settingsTestAi: p => probe('ai', p),
    settingsTestProxy: p => probe('proxy', p),
    settingsSchema: async () => ({
      ok: true, version: 1,
      fields: jsonClone(NATIVE_SETTINGS_FIELDS.map(rule => {
        const choices = rule.kind === 'boolean' ? [false, true] : rule.options
        return {
          ...rule,
          ...(choices ? {
            optionLabels: choices.map(value => nativeSettingOptionLabel(value, 'zh', rule.path)),
            optionLabelsEn: choices.map(value => nativeSettingOptionLabel(value, 'en', rule.path)),
          } : {}),
        }
      })),
      providers: AI_PROVIDERS.map(p => ({ id: p.id, label: p.label, models: p.models, docsUrl: p.docsUrl })),
    }),
    settingsPatch: async p => { await barrier(); const next = applyNativeSettingsEdits(client.settings(), p.patches); await owner.commitNativeSettingsEdits(next); return done() },
    selectAiProvider: async p => {
      if (typeof p.provider !== 'string' || !isSelectableAiProvider(p.provider)) throw stateError('invalid_provider')
      await barrier(); owner.selectAiProvider(p.provider); await owner.flushNativeSettings(); return done()
    },
    settingsResetReader: async p => {
      if (p.confirm !== true) throw stateError('confirmation_required')
      await barrier(); owner.resetReader(); await owner.flushNativeSettings(); return done()
    },
    settingsCalibrationInfo: async () => {
      await barrier(); const value = await metrics()
      if (!(value.dpr >= 0.5 && value.dpr <= 8 && value.textScale >= 0.5 && value.textScale <= 3)) throw stateError('calibration_context_unavailable')
      measurement = { ...value, token: crypto.randomUUID() }
      return { ok: true, ...measurement, status: calibrationStatus(client.settings().typographyCalibration, value.dpr, value.textScale) }
    },
    settingsCalibrationCommit: async p => {
      if (!measurement || p.token !== measurement.token) throw stateError('calibration_context_changed')
      await barrier(); const current = await metrics()
      if (!(current.dpr >= 0.5 && current.dpr <= 8 && current.textScale >= 0.5 && current.textScale <= 3) || Math.abs(current.dpr - measurement.dpr) > 0.02 || Math.abs(current.textScale - measurement.textScale) > 0.01) throw stateError('calibration_context_changed')
      if (typeof p.widthCss !== 'number' || typeof p.measuredMm !== 'number') throw stateError('invalid_payload')
      const calibration = measureTypographyCalibration(p.widthCss, p.measuredMm, measurement.dpr, measurement.textScale)
      await owner.setTypographyCalibration(calibration); measurement = null; return done()
    },
    settingsCalibrationClear: async p => { if (p.confirm !== true) throw stateError('confirmation_required'); await barrier(); await owner.setTypographyCalibration(null); measurement = null; return done() },
  }
  let activeAction = false
  return Object.fromEntries(Object.entries(actions).map(([name, action]) => [name, async (payload: JsonObject) => {
    if (activeAction || (name !== 'settingsSchema' && activeProbe)) throw stateError(activeProbe ? 'native_probe_in_progress' : 'native_settings_busy')
    activeAction = true
    try { return await action(payload) } finally { activeAction = false }
  }]))
}
