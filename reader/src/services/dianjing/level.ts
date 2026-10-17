/**
 * 点睛阅读的两个版本 (docs/manual/05-点睛阅读.md):
 *   基础版 (basic): 按词分色, 不联网 —— 全局开关, 即 settings.readingMode.wordGuide.enabled;
 *   智能版 (smart): AI 先读一遍点出概念与要句 —— 沿用原点睛阅读的按书开关 (perBook / consentAll + enabled)。
 * settings.dianjing.level 记住读者选的版本 (随同步); 「点睛阅读开着」= 所选版本开着。
 * 两个版本不会同时生效: 未选中的那个即使底层开关还是 true 也不画。
 */
export type DjLevel = 'basic' | 'smart'

export const DJ_LEVELS: readonly DjLevel[] = ['basic', 'smart']
export const DJ_LEVEL_DEFAULT: DjLevel = 'basic'

export function normalizeLevel(v: unknown): DjLevel {
  return v === 'smart' || v === 'basic' ? v : DJ_LEVEL_DEFAULT
}

interface SmartPrefs {
  enabled?: boolean
  consentAll?: boolean
  perBook?: Record<string, boolean>
}

/** 智能版在这本书上是否开着 (不看所选版本) */
export function smartOnFor(prefs: SmartPrefs | undefined, bookId: string): boolean {
  const per = prefs?.perBook?.[bookId]
  return per ?? (!!prefs?.consentAll && !!prefs?.enabled)
}

/** 两个版本各自是否生效 (同一时间至多一个) */
export function effectiveLevels(s: { level: DjLevel; basicOn: boolean; smartOn: boolean }): { basic: boolean; smart: boolean } {
  return { basic: s.level === 'basic' && s.basicOn, smart: s.level === 'smart' && s.smartOn }
}

/** 点睛阅读是否开着 (按所选版本) */
export function dianjingOn(s: { level: DjLevel; basicOn: boolean; smartOn: boolean }): boolean {
  const e = effectiveLevels(s)
  return e.basic || e.smart
}

/**
 * v14 迁移: 旧存档没有 level。按读者原来在用的功能选版本, 不让人觉得功能「没了」 (产品负责人定):
 *   - 用过点睛阅读 (对所有书开着, 或给某些书开着) → 智能版; 两者都开着时也是智能版 (原来就是点睛优先);
 *   - 否则开着按词着色 → 基础版并开着 (它原本对所有书生效);
 *   - 都没开 → 关着, 预选基础版 (打开即用)。
 * 选了智能版时把按词着色的旧开关关掉, 免得两份状态互相打架。
 */
export function migrateLevel(saved: any): { level: DjLevel; wordGuideEnabled: boolean } {
  const dj = saved?.dianjing && typeof saved.dianjing === 'object' ? saved.dianjing : {}
  const wordGuide = !!saved?.readingMode?.wordGuide?.enabled
  const smartAll = !!dj.consentAll && !!dj.enabled
  const smartSome = !!dj.perBook && typeof dj.perBook === 'object' && Object.values(dj.perBook).some(v => v === true)
  if (smartAll || smartSome) return { level: 'smart', wordGuideEnabled: false }
  if (wordGuide) return { level: 'basic', wordGuideEnabled: true }
  return { level: 'basic', wordGuideEnabled: false }
}

/** 基础版标什么: 词与词 (交替着色) / 重点词 (离线挑出要紧的词) */
export type BasicMark = 'boundary' | 'keywords'
/** 新安装的默认 */
export const BASIC_MARK_DEFAULT: BasicMark = 'keywords'

/**
 * 已有存档里的「标什么」: 这个字段是 v1.15 新加的, 老用户存档里没有 → 保持原来的词与词 (不升 SETTINGS_VERSION)。
 * 新安装没有存档, 直接用默认 (重点词)。
 */
export function savedBasicMark(v: unknown): BasicMark {
  return v === 'keywords' || v === 'boundary' ? v : 'boundary'
}

/** 开关相关的全部状态 (基础版开关 + 智能版的按书开关与「所有书」) */
export interface DjSwitchState {
  level: DjLevel
  /** 基础版开关 (readingMode.wordGuide.enabled) */
  basicOn: boolean
  perBook: Record<string, boolean>
  consentAll: boolean
  enabled: boolean
}

export type DjAction =
  /** 总开关 (面板开关、D 键): 按上次选的版本开 / 关 */
  | { kind: 'toggle' }
  /** 面板里的「基础 / 智能」: 开着时把「开」带到新版本, 关着时只记住选择 */
  | { kind: 'setLevel'; level: DjLevel }
  /** 「先用基础版」: 换成基础版并开着 */
  | { kind: 'switchToBasic' }
  /** 智能版的同意说明: 仅本书 / 所有书 */
  | { kind: 'consent'; scope: 'book' | 'all' }

/**
 * 点睛阅读的开关状态机 (纯函数, useDianjing 照它写回设置)。
 * needConsent: 要打开智能版但这本书还没同意过——先弹同意说明, 状态不变 (基础版开着就继续开着)。
 */
export function applyDjAction(s: DjSwitchState, bookId: string, a: DjAction): { state: DjSwitchState; needConsent: boolean } {
  const st: DjSwitchState = { ...s, perBook: { ...s.perBook } }
  const hasConsent = st.consentAll || bookId in st.perBook
  const isOn = dianjingOn({ level: st.level, basicOn: st.basicOn, smartOn: smartOnFor(st, bookId) })
  const done = () => ({ state: st, needConsent: false })
  const startSmart = () => {
    if (!hasConsent) return { state: s, needConsent: true }
    st.basicOn = false
    st.level = 'smart'
    st.perBook[bookId] = true
    return done()
  }
  switch (a.kind) {
    case 'toggle':
      if (isOn) {
        if (st.level === 'smart') st.perBook[bookId] = false
        else st.basicOn = false
        return done()
      }
      if (st.level === 'smart') return startSmart()
      st.basicOn = true
      return done()
    case 'setLevel':
      if (a.level === st.level) return done()
      if (!isOn) {
        st.level = a.level
        return done()
      }
      if (a.level === 'smart') return startSmart()
      st.perBook[bookId] = false
      st.level = 'basic'
      st.basicOn = true
      return done()
    case 'switchToBasic':
      if (st.level === 'smart' && smartOnFor(st, bookId)) st.perBook[bookId] = false
      st.level = 'basic'
      st.basicOn = true
      return done()
    case 'consent':
      if (a.scope === 'all') {
        st.consentAll = true
        st.enabled = true
      }
      st.basicOn = false
      st.level = 'smart'
      st.perBook[bookId] = true
      return done()
  }
}
