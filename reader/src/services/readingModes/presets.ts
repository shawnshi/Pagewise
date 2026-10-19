/**
 * 「显示」类模式的预设引擎 (纯函数, docs/research/reading-modes-landscape.md §5.1 §6)。
 *
 * 夜间、护眼、墨水屏、大字都不新增一套设置, 而是「预设开关」: 开启时记下被改动键的原值 (before),
 * 写入预设值 (applied); 关闭时把原值写回。键是设置路径字符串 ('reader.fontSize'、'typewriter.unit' …),
 * 读写由调用方 (useReadingModes) 负责, 这里只算该写什么, 便于 node --test。
 *
 * 叠加规则 (多个预设改同一个键):
 * - 后开的预设记下的 before 就是当时的值 (含先开预设的效果);
 * - 关闭一个预设时, 若上面还有别的预设改着同一个键, 不写回, 而是把自己的 before 交给上方最近的那个持有者;
 * - 自己是该键最上层的持有者时才写回 before; 若当前值已不是自己写入的值, 说明用户在模式里手动调过,
 *   把这个值作为「预设自己的值」返回 (custom), 下次开启时沿用 (大字模式的字号)。
 */

export type PresetValues = Record<string, unknown>

export interface PresetRecord {
  before: PresetValues
  applied: PresetValues
  /** 开启顺序 (越大越上层) */
  order: number
}

export type PresetRecords = Record<string, PresetRecord>

export type ReadValue = (key: string) => unknown

export function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-9
  return Object.is(a, b)
}

/**
 * 开启 (或以新值重新套用) 一个预设。返回新的记录表与要写入的值。
 * 重新套用时保留第一次开启时的 before (例如大字从「大」切到「特大」, 关闭后仍回到开启前)。
 */
export function engagePreset(
  records: PresetRecords,
  id: string,
  values: PresetValues,
  read: ReadValue,
): { records: PresetRecords; writes: PresetValues } {
  const prev = records[id]
  const maxOrder = Object.values(records).reduce((m, r) => Math.max(m, r.order), 0)
  const before: PresetValues = {}
  for (const key of Object.keys(values)) {
    before[key] = prev && key in prev.before ? prev.before[key] : read(key)
  }
  const next: PresetRecords = {}
  for (const [k, r] of Object.entries(records)) {
    next[k] = k === id ? r : { before: { ...r.before }, applied: { ...r.applied }, order: r.order }
  }
  const order = prev ? prev.order : maxOrder + 1
  /** 上方最近的同键持有者 (重新套用下层预设时, 上层仍管着这个键) */
  const aboveOf = (key: string): PresetRecord | null => {
    let above: PresetRecord | null = null
    for (const [k, r] of Object.entries(next)) {
      if (k !== id && r.order > order && key in r.applied && (!above || r.order < above.order)) above = r
    }
    return above
  }
  const writes: PresetValues = {}
  for (const [key, v] of Object.entries(values)) {
    const above = prev ? aboveOf(key) : null
    // 上层还管着: 不直接写, 改它的快照 (上层关闭时恢复到这个新值)
    if (above) above.before[key] = v
    else writes[key] = v
  }
  // 重新套用时不再改动的键: 原样写回开启前的值
  if (prev) {
    for (const key of Object.keys(prev.applied)) {
      if (key in values) continue
      const above = aboveOf(key)
      if (above) above.before[key] = prev.before[key]
      else if (sameValue(read(key), prev.applied[key])) writes[key] = prev.before[key]
    }
  }
  next[id] = { before, applied: { ...values }, order }
  return { records: next, writes }
}

/** 关闭预设: 返回新的记录表、要写回的值, 以及用户在模式里手动调过的键 (custom) */
export function releasePreset(
  records: PresetRecords,
  id: string,
  read: ReadValue,
): { records: PresetRecords; writes: PresetValues; custom: PresetValues } {
  const rec = records[id]
  const writes: PresetValues = {}
  const custom: PresetValues = {}
  if (!rec) return { records, writes, custom }
  const next: PresetRecords = {}
  for (const [k, r] of Object.entries(records)) {
    if (k !== id) next[k] = { before: { ...r.before }, applied: { ...r.applied }, order: r.order }
  }
  for (const key of Object.keys(rec.applied)) {
    // 上方最近的同键持有者
    let above: PresetRecord | null = null
    for (const r of Object.values(next)) {
      if (r.order > rec.order && key in r.applied && (!above || r.order < above.order)) above = r
    }
    if (above) {
      above.before[key] = rec.before[key]
      continue
    }
    const cur = read(key)
    if (!sameValue(cur, rec.applied[key])) {
      custom[key] = cur
      // 用户在模式里改过的键: 排版参数仍恢复快照 (改动记为预设自己的值); 其余 (主题、排版方式、粒度) 保留用户的选择
      if (!TYPOGRAPHY_KEYS.has(key)) continue
    }
    writes[key] = rec.before[key]
  }
  return { records: next, writes, custom }
}

const TYPOGRAPHY_KEYS = new Set(['reader.fontSize', 'reader.lineHeight', 'reader.letterSpacing', 'reader.gap', 'reader.fontFamily', 'reader.justify'])

/** 记录表里谁在管这个键 (最上层); 没有返回 null */
export function holderOf(records: PresetRecords, key: string): string | null {
  let best: string | null = null
  let order = -Infinity
  for (const [id, r] of Object.entries(records)) {
    if (key in r.applied && r.order > order) {
      best = id
      order = r.order
    }
  }
  return best
}

// ---- 具体预设 ----

/** 黑体 (低视力指南推荐无衬线、笔画清晰), 与 readerTheme.FONT_FAMILIES 的「黑体」一致 */
export const HEITI = '"PingFang SC", "Noto Sans SC", "Microsoft YaHei", sans-serif'

/** 大字 §6.4: 大 24px / 特大 30px, 行距 2.0, 字距 0.05em, 页边距 4% / 3%, 黑体, 关两端对齐; 单栏由 forceSingleColumn 保证 */
export function largeTextValues(size: 'large' | 'xlarge', custom: PresetValues = {}): PresetValues {
  const base: PresetValues = {
    'reader.fontSize': size === 'xlarge' ? 30 : 24,
    'reader.lineHeight': 2,
    'reader.letterSpacing': 0.05,
    'reader.gap': size === 'xlarge' ? 3 : 4,
    'reader.justify': false,
    'reader.fontFamily': HEITI,
  }
  for (const key of Object.keys(base)) if (key in custom && custom[key] != null) base[key] = custom[key]
  return base
}

/** 墨水屏 §6.3: 打字机最小粒度为逐句 (逐字在墨水屏上残影严重); 配色与字重在 readerTheme 里随 einkActive 生效 */
export function einkValues(read: ReadValue): PresetValues {
  return read('typewriter.unit') === 'char' ? { 'typewriter.unit': 'sentence' } : {}
}

export type ThemeName = 'auto' | 'light' | 'sepia' | 'green' | 'dark'

/** 夜间 = 正文主题解析为 dark (含 auto 跟随深色外观) */
export function isNightTheme(theme: ThemeName, appDark: boolean): boolean {
  return theme === 'dark' || (theme === 'auto' && appDark)
}

/** 护眼 = 暖色主题 (米黄 / 护眼绿) */
export function isEyeCareTheme(theme: ThemeName): boolean {
  return theme === 'sepia' || theme === 'green'
}

/** 关闭夜间 / 护眼时恢复的主题: 原值仍属于同一类 (如 auto 在深色外观下也是夜间) 时退回白色 */
export function themeAfterRelease(before: unknown, mode: 'night' | 'eyeCare', appDark: boolean): ThemeName {
  const b = (typeof before === 'string' ? before : 'auto') as ThemeName
  if (mode === 'night' && isNightTheme(b, appDark)) return 'light'
  if (mode === 'eyeCare' && isEyeCareTheme(b)) return appDark ? 'dark' : 'light'
  return b
}

// ---- 墨水屏设备识别 (启发式, 只用于「要开启墨水屏吗？」提示一次, 不自动开启) ----

const EINK_UA = [
  // Boox 的 UA 只带型号: NoteAir2P / TabUltraC / Nova3Color / Poke5 / Palma (华为 "nova 7" 带空格, 不会命中)
  /\bBOOX\b/i, /\bONYX\b/i, /\bNote\s?X3(?:\s?Pro)?\b/i, /\bNoteAir/i, /\bTabUltra/i, /\bTabX\b/i, /\bNova(?:\d?Air|Pro|\dColor|\dPlus|\d)\b/, /\bPoke[2-6]/i, /\bPalma\b/i,
  /\bHisense\s?A[5-9]\b/i, /\bHLTE\d{3}E\b/i, /\biReader\b/i, /\bZhangyue\b/i, /\bBigme\b/i, /\bMeebook\b/i, /\bBoyue\b/i,
  /\bLikebook\b/i, /\bKindle\b/i, /\bKobo\b/i, /\bPocketBook\b/i, /\bTolino\b/i, /\breMarkable\b/i, /\bHanvon\b/i, /\bDasung\b/i,
]

/**
 * 是否像墨水屏设备: UA 命中常见厂商 / 型号, 或媒体查询报告慢刷新 / 单色屏。
 * update: 'slow' | 'fast' | 'none' (CSS `(update: slow)`), monochrome: `(monochrome)` 是否匹配。
 */
export function looksLikeEinkDevice(ua: string, media: { update?: string; monochrome?: boolean } = {}): boolean {
  if (media.monochrome) return true
  if (media.update === 'slow') return true
  return EINK_UA.some(re => re.test(ua || ''))
}
