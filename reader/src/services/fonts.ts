/**
 * 字体管理:
 *  - 桌面端枚举系统已安装字体 (Rust fontdb)
 *  - 自定义字体文件: 复制到应用数据目录, 阅读时以 FontFace 注入各章节文档
 */
import { isTauri } from '../storage/types'
import { automaticFontFamily, BUNDLED_READER_FAMILIES, type TypographyProfile } from './readerTypographyProfiles.ts'

export interface CustomFont {
  /** 展示名与 CSS font-family 名 (取自文件名) */
  name: string
  /** 应用数据目录内的字体文件路径 */
  file: string
}

/** Probe only the app/calibration document; book documents use the non-mutating root-size path. */
export function measureTextScale(doc: Document, declaredRootFontSize?: number): number | null {
  const win = doc.defaultView
  if (!win) return null
  let probe: HTMLSpanElement | undefined
  try {
    let actual: number
    if (declaredRootFontSize && declaredRootFontSize > 0) actual = parseFloat(win.getComputedStyle(doc.documentElement).fontSize) / declaredRootFontSize
    else {
      if (!doc.body) return null
      probe = doc.createElement('span')
      probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;font-size:100px!important;line-height:1;'
      probe.textContent = 'M'
      doc.body.append(probe)
      actual = parseFloat(win.getComputedStyle(probe).fontSize) / 100
    }
    return Number.isFinite(actual) && actual >= 0.5 && actual <= 3 ? actual : null
  } finally { probe?.remove() }
}

let systemFontsCache: string[] | null = null

export async function listSystemFonts(): Promise<string[]> {
  if (!isTauri()) return []
  if (!systemFontsCache) {
    const { invoke } = await import('@tauri-apps/api/core')
    systemFontsCache = await invoke<string[]>('list_system_fonts')
  }
  return systemFontsCache
}

/** 弹文件选择框导入字体, 复制到 $APPDATA/fonts/; 取消返回 null */
export async function importFontFile(): Promise<CustomFont | null> {
  const { open } = await import('@tauri-apps/plugin-dialog')
  const picked = await open({
    title: '选择字体文件',
    filters: [{ name: 'Fonts', extensions: ['ttf', 'otf', 'woff', 'woff2', 'ttc'] }],
  })
  if (typeof picked !== 'string') return null
  const { readFile, writeFile, mkdir, exists } = await import('@tauri-apps/plugin-fs')
  const { appDataDir, join, basename } = await import('@tauri-apps/api/path')
  const data = await readFile(picked)
  const dir = await join(await appDataDir(), 'fonts')
  if (!(await exists(dir))) await mkdir(dir, { recursive: true })
  const base = await basename(picked)
  const dest = await join(dir, base)
  await writeFile(dest, data)
  return { name: base.replace(/\.(ttf|otf|woff2?|ttc)$/i, ''), file: dest }
}

const bytesCache = new Map<string, Promise<ArrayBuffer>>()

function loadFontBytes(file: string): Promise<ArrayBuffer> {
  if (!bytesCache.has(file)) {
    bytesCache.set(file, (async () => {
      const { readFile } = await import('@tauri-apps/plugin-fs')
      const data = await readFile(file)
      return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
    })())
  }
  return bytesCache.get(file)!
}

const documentFontLoads = new WeakMap<Document, Map<string, Promise<void>>>()

/** Register in the target document and expose completion/errors to the reader transaction. */
export function injectFontIntoDoc(doc: Document, font: CustomFont): Promise<void> {
  let loads = documentFontLoads.get(doc)
  if (!loads) { loads = new Map(); documentFontLoads.set(doc, loads) }
  if (!loads.has(font.file)) {
    const work = async () => {
      const win = doc.defaultView as (Window & { FontFace?: typeof FontFace }) | null
      if (!win?.FontFace) throw new Error('FontFace unavailable')
      const face = new win.FontFace(font.name, await loadFontBytes(font.file))
      await face.load()
      doc.fonts.add(face)
    }
    loads.set(font.file, work())
  }
  return loads.get(font.file)!
}

const bundledDocumentLoads = new WeakMap<Document, Promise<void>>()
const bundledStylesheetLoads = new Map<string, Promise<string>>()

function loadBundledFontCSS(href: string): Promise<string> {
  const prior = bundledStylesheetLoads.get(href)
  if (prior) return prior
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  const work = fetch(href, { signal: controller.signal }).then(async response => {
    if (!response.ok) throw new Error(`Bundled font stylesheet HTTP ${response.status}`)
    const css = await response.text()
    if (!css.includes('@font-face')) throw new Error('Invalid bundled font stylesheet')
    return css.replace(/url\(["']?\.\/([\w.-]+)["']?\)/g, (_match, file: string) => `url("${new URL(file, href).href}")`)
  }).finally(() => clearTimeout(timer))
  bundledStylesheetLoads.set(href, work)
  void work.catch(() => { if (bundledStylesheetLoads.get(href) === work) bundledStylesheetLoads.delete(href) })
  return work
}

/** Use absolute app asset URLs, never the EPUB's blob/relative asset base. */
export function injectBundledFontsIntoDoc(doc: Document): Promise<void> {
  const prior = bundledDocumentLoads.get(doc)
  if (prior) return prior
  const work = (async () => {
    const source = document.querySelector<HTMLLinkElement>('link[data-pw-bundled-fonts]')
    if (!source) throw new Error('Bundled font stylesheet unavailable')
    if (doc === document) return
    const css = await loadBundledFontCSS(source.href)
    // Inline the cached face declarations: repeated iframe navigation must not
    // depend on a cached <link>'s load event before pagination can settle.
    const style = doc.createElement('style')
    style.dataset.pwBundledFonts = ''
    style.textContent = css
    ;(doc.head || doc.documentElement).append(style)
  })()
  bundledDocumentLoads.set(doc, work)
  void work.catch(() => { if (bundledDocumentLoads.get(doc) === work) bundledDocumentLoads.delete(doc) })
  return work
}

/** Stored font value to a real family stack; unavailable custom faces retain a visible generic fallback. */
export function resolveFontFamily(value: string, opts: { profile?: TypographyProfile; language?: string } = {}): string {
  if (value === 'auto') return automaticFontFamily(opts.profile ?? 'zh', opts.language)
  if (Object.hasOwn(BUNDLED_READER_FAMILIES, value)) {
    const family = BUNDLED_READER_FAMILIES[value]
    if (family) return family
  }
  const m = value.match(/^custom:(.+)$/)
  return m ? `${JSON.stringify(m[1])}, serif` : value
}
