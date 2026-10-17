/**
 * 旧 WebView 兼容的构建期处理 (vite.config.ts 使用, scripts/test-compat.mjs 覆盖)。
 *
 * BROWSER_TARGET 依据:
 *  - mupdf.js 使用顶层 await, 无法降级 → 下限为 Chrome/Edge 89、Firefox 89、Safari/iOS 15。
 *  - Android minSdk 24 (7.0) 的系统 WebView 可经应用商店独立更新 (华为无 GMS 机型走华为 WebView),
 *    实际内核多为 Chromium 9x–1xx, 但缺 Object.groupBy (117)、structuredClone (98)、.at (92) 等
 *    新 API 很常见 (GitHub #9)。低于 Chrome 89 的 WebView 需要 @vitejs/plugin-legacy 整套
 *    SystemJS 产物, 不在支持范围。
 *  - macOS 10.15 的 WKWebView 最高为 Safari 15.x (Tauri 2 的最低 macOS 版本)。
 * 语法由 Oxc 降级到这些目标 (类静态块、`#x in obj` 等); 运行时 API 由 src/polyfills.ts 补齐。
 */
import type { Plugin } from 'vite'

export const BROWSER_TARGET = ['chrome89', 'edge89', 'firefox89', 'safari15', 'ios15']

/**
 * 正则后行断言 `(?<=…)` / `(?<!…)` 在 Safari < 16.4 是语法错误, 构建工具不会降级;
 * 一旦出现在模块里, 整个 chunk 都无法解析。这里把第三方依赖里已知的写法改成等价形式,
 * 依赖升级后改写失配则构建失败, 防止静默回归。顺带用同一机制给 foliate 的两处卸载/换章竞态加守卫。
 * 注: 现在打包的是 src/vendor/foliate/paginator.js 这个 fork (vite.config.ts), 下面三条 paginator 改写
 * 已直接写进 fork; 上游 paginator.js 不再被打包, 这些规则只在上游文件重新被引用时生效。
 */
const LOOKBEHIND_REWRITES: { file: RegExp; from: string; to: string }[] = [
  {
    // foliate-js 去掉 -epub- 前缀: 前一个字符被捕获后原样放回, 结果与后行断言一致。
    file: /[\\/]foliate-js[\\/]paginator\.js$/,
    from: String.raw`.replace(/(?<=[{\s;])-epub-/gi, '')`,
    to: String.raw`.replace(/([{\s;])-epub-/gi, '$1')`,
  },
  {
    // 不是正则问题, 借同一机制修 foliate 的竞态: iframe 换章/卸载时 ResizeObserver 仍会触发 render,
    // 此刻 document 还在但 documentElement/body 为空, setStylesImportant 解构 null 抛错。
    file: /[\\/]foliate-js[\\/]paginator\.js$/,
    from: 'if (!layout || !this.document) return',
    to: 'if (!layout || !this.document?.documentElement || !this.document.body) return',
  },
  {
    // 同一竞态的另一处: 滚动结束回调里取可见范围, body 为空时 createTreeWalker 抛错; 跳过这次定位即可
    file: /[\\/]foliate-js[\\/]paginator\.js$/,
    from: '    #afterScroll(reason) {\n        const range = this.#getVisibleRange()',
    to: '    #afterScroll(reason) {\n        if (!this.#view?.document?.body) return\n        const range = this.#getVisibleRange()',
  },
]

export function legacyRegexRewrite(): Plugin {
  return {
    name: 'lightread:legacy-regex-rewrite',
    enforce: 'pre',
    transform(code, id) {
      const path = id.split('?')[0]!
      let out = code
      for (const rule of LOOKBEHIND_REWRITES) {
        if (!rule.file.test(path)) continue
        if (!out.includes(rule.from)) {
          this.error(`legacy-regex-rewrite: pattern not found in ${path}; re-check lookbehind usage after the dependency upgrade`)
        }
        out = out.split(rule.from).join(rule.to)
      }
      return out === code ? null : { code: out, map: null }
    },
  }
}

// ---- CSS: color-mix() / dvh 回退 ----
// color-mix() 需要 Chrome 111 / Safari 16.2, dvh 需要 Chrome 108 / Safari 15.4。旧内核会丢弃整条
// 声明; 对 background/border 这类属性, 会让半透明工具栏变成透明、卡片边框消失。这里在每条
// 含 color-mix()/dvh 的声明前插入一条旧内核能理解的回退声明 (新内核按层叠取后一条):
//  - color-mix(in srgb, A p%, B) → 占比多的一方 (A 若 p ≥ 50 否则 B); 若选中的是 transparent 而另一方是
//    品牌/状态色令牌, 用对应的 --x-soft 令牌 (其本身在 main.css 里有 @supports 回退)
//  - Nvh 单位: dvh/svh/lvh → vh
// 自定义属性 (--x: color-mix(...)) 不能这样回退 (后声明总是生效), 由 main.css 的 @supports 处理。

const SOFT_TOKENS = new Set(['--brand', '--danger', '--success', '--warning'])

function splitTopLevel(input: string, sep = ','): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (ch === sep && depth === 0) {
      parts.push(input.slice(start, i).trim())
      start = i + 1
    }
  }
  parts.push(input.slice(start).trim())
  return parts
}

function tokenOf(color: string) {
  return /^var\(\s*(--[\w-]+)/.exec(color)?.[1]
}

function colorMixFallback(args: string): string | null {
  const parts = splitTopLevel(args)
  if (parts.length !== 3 || !/^in\s+/i.test(parts[0]!)) return null
  const parse = (part: string) => {
    const m = /^(.*?)(?:\s+(\d+(?:\.\d+)?)%)?$/s.exec(part.trim())
    return { color: m![1]!.trim(), pct: m![2] === undefined ? undefined : Number(m![2]) }
  }
  const a = parse(parts[1]!)
  const b = parse(parts[2]!)
  const pa = a.pct ?? (b.pct === undefined ? 50 : 100 - b.pct)
  const [chosen, other] = pa >= 50 ? [a.color, b.color] : [b.color, a.color]
  if (chosen.includes('color-mix(') || other.includes('color-mix(')) return null
  if (chosen === 'transparent') {
    const token = tokenOf(other)
    if (token && SOFT_TOKENS.has(token)) return `var(${token}-soft)`
  }
  return chosen
}

export function legacyCssValue(value: string): string | null {
  let out = value
  for (let guard = 0; guard < 50; guard++) {
    const start = out.indexOf('color-mix(')
    if (start < 0) break
    let depth = 0
    let end = -1
    for (let i = start + 'color-mix'.length; i < out.length; i++) {
      if (out[i] === '(') depth++
      else if (out[i] === ')' && --depth === 0) { end = i; break }
    }
    if (end < 0) return null
    const replacement = colorMixFallback(out.slice(start + 'color-mix('.length, end))
    if (replacement === null) return null
    out = out.slice(0, start) + replacement + out.slice(end + 1)
  }
  if (out.includes('color-mix(')) return null
  out = out.replace(/(\d)(?:d|s|l)vh\b/g, '$1vh')
  return out === value ? null : out
}

interface Decl {
  prop: string
  value: string
  important?: boolean
  prev(): { type: string; prop?: string } | undefined
  cloneBefore(overrides: { value: string }): unknown
}

export function legacyCssFallbacks() {
  return {
    postcssPlugin: 'lightread-legacy-css-fallbacks',
    Declaration(decl: Decl) {
      if (decl.prop.startsWith('--')) return
      if (!decl.value.includes('color-mix(') && !/\d(?:d|s|l)vh\b/.test(decl.value)) return
      const prev = decl.prev()
      // 已有手写回退 (同属性的上一条声明) 时不重复插入
      if (prev?.type === 'decl' && prev.prop === decl.prop) return
      const fallback = legacyCssValue(decl.value)
      if (fallback) decl.cloneBefore({ value: fallback })
    },
  }
}
