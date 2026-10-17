/**
 * 运行时 polyfill: 补齐旧版 Android/HarmonyOS WebView 和 WKWebView 缺失的标准特性。
 *
 * 构建目标见 vite.config.ts (chrome89 / safari15 …): 语法由构建降级, 这里只补
 * 构建无法降级、且项目或打包依赖确实用到的运行时 API。全部「特性检测 + 不可枚举
 * defineProperty」, 原生实现存在时不覆盖。此模块被拆成独立 chunk 并作为入口的第一个
 * import 执行 (vite.config.ts 的 codeSplitting 分组), 先于任何其它模块求值。
 *
 * ReadableStream 异步迭代器 — 系统 WKWebView 缺少 Symbol.asyncIterator,
 * 任何依赖 `for await (const v of readableStream)` 的库都会抛
 * "undefined is not a function" (曾导致 pdf.js 时代论文段落提取整页失败)。
 * 保留以兜底第三方依赖。
 */

function define(target: object, name: PropertyKey, value: unknown) {
  Object.defineProperty(target, name, { configurable: true, writable: true, enumerable: false, value })
}

function toLength(value: unknown) {
  const n = Math.trunc(Number(value)) || 0
  return n <= 0 ? 0 : Math.min(n, Number.MAX_SAFE_INTEGER)
}

function toObject(value: unknown, method: string): any {
  if (value == null) throw new TypeError(`${method} called on null or undefined`)
  return Object(value)
}

// %TypedArray%.prototype: 所有 Uint8Array/Float32Array… 的共同原型
const typedArrayProto: object | null = typeof Int8Array !== 'undefined' ? Object.getPrototypeOf(Int8Array.prototype) : null

// ---- Array/String/TypedArray.prototype.at (Chrome 92 / Safari 15.4) — foliate-js epub/epubcfi, 论文阅读器 ----
function at(this: unknown, index: number) {
  const o = toObject(this, 'at')
  const len = toLength(o.length)
  let k = Math.trunc(Number(index)) || 0
  if (k < 0) k += len
  return k < 0 || k >= len ? undefined : o[k]
}
for (const proto of [Array.prototype, typedArrayProto]) {
  if (proto && typeof (proto as any).at !== 'function') define(proto, 'at', at)
}
if (typeof (String.prototype as any).at !== 'function') {
  define(String.prototype, 'at', function (this: unknown, index: number) {
    return at.call(String(toObject(this, 'String.prototype.at')), index)
  })
}

// ---- findLast / findLastIndex (Chrome 97 / Safari 15.4) — foliate-js paginator ----
function findLastIndex(this: unknown, predicate: (v: unknown, i: number, o: unknown) => unknown, thisArg?: unknown) {
  const o = toObject(this, 'findLastIndex')
  if (typeof predicate !== 'function') throw new TypeError('findLastIndex predicate must be a function')
  for (let i = toLength(o.length) - 1; i >= 0; i--) {
    if (predicate.call(thisArg, o[i], i, o)) return i
  }
  return -1
}
function findLast(this: unknown, predicate: (v: unknown, i: number, o: unknown) => unknown, thisArg?: unknown) {
  const o = toObject(this, 'findLast')
  if (typeof predicate !== 'function') throw new TypeError('findLast predicate must be a function')
  for (let i = toLength(o.length) - 1; i >= 0; i--) {
    const value = o[i]
    if (predicate.call(thisArg, value, i, o)) return value
  }
  return undefined
}
for (const proto of [Array.prototype, typedArrayProto]) {
  if (!proto) continue
  if (typeof (proto as any).findLast !== 'function') define(proto, 'findLast', findLast)
  if (typeof (proto as any).findLastIndex !== 'function') define(proto, 'findLastIndex', findLastIndex)
}

// ---- structuredClone (Chrome 98 / Safari 15.4) — 设置默认值、多端同步合并 ----
// 覆盖项目用到的结构化数据: 原始值、普通对象/数组、Date、RegExp、Map、Set、
// ArrayBuffer/TypedArray/DataView、Blob/File (不可变, 共享引用)、Error, 支持循环引用。
// 函数 / Symbol / DOM 节点按规范抛 DataCloneError。
function dataCloneError(message: string) {
  return typeof DOMException === 'function' ? new DOMException(message, 'DataCloneError') : new TypeError(message)
}
function cloneStructured(value: unknown, seen: Map<object, unknown>): unknown {
  if (typeof value === 'function' || typeof value === 'symbol') throw dataCloneError(`${String(value)} could not be cloned.`)
  if (typeof value !== 'object' || value === null) return value
  if (seen.has(value)) return seen.get(value)
  const tag = Object.prototype.toString.call(value)
  let out: any
  switch (tag) {
    case '[object Date]':
      out = new Date((value as Date).getTime())
      break
    case '[object RegExp]':
      out = new RegExp((value as RegExp).source, (value as RegExp).flags)
      break
    case '[object Boolean]':
    case '[object Number]':
    case '[object String]':
    case '[object BigInt]':
      out = Object((value as any).valueOf())
      break
    case '[object ArrayBuffer]':
      out = (value as ArrayBuffer).slice(0)
      break
    case '[object Map]': {
      out = new Map()
      seen.set(value, out)
      for (const [k, v] of value as Map<unknown, unknown>) out.set(cloneStructured(k, seen), cloneStructured(v, seen))
      return out
    }
    case '[object Set]': {
      out = new Set()
      seen.set(value, out)
      for (const v of value as Set<unknown>) out.add(cloneStructured(v, seen))
      return out
    }
    case '[object Blob]':
    case '[object File]':
    case '[object FileList]':
    case '[object ImageBitmap]':
      out = value
      break
    case '[object Error]': {
      const err = value as Error
      const Ctor = ({ EvalError, RangeError, ReferenceError, SyntaxError, TypeError, URIError } as Record<string, ErrorConstructor>)[err.name] ?? Error
      out = new Ctor(err.message)
      if (typeof err.stack === 'string') define(out, 'stack', err.stack)
      break
    }
    default:
      if (ArrayBuffer.isView(value)) {
        const view = value as ArrayBufferView & { length?: number }
        const buffer = cloneStructured(view.buffer, seen) as ArrayBuffer
        const Ctor = (value as any).constructor
        out = tag === '[object DataView]'
          ? new DataView(buffer, view.byteOffset, view.byteLength)
          : new Ctor(buffer, view.byteOffset, view.length)
        break
      }
      if (typeof Node !== 'undefined' && value instanceof Node) throw dataCloneError(`${tag} object could not be cloned.`)
      out = Array.isArray(value) ? new Array(value.length) : {}
      seen.set(value, out)
      for (const key of Object.keys(value)) out[key] = cloneStructured((value as any)[key], seen)
      return out
  }
  seen.set(value, out)
  return out
}
if (typeof (globalThis as any).structuredClone !== 'function') {
  define(globalThis, 'structuredClone', function structuredClone(value: unknown, options?: { transfer?: unknown[] }) {
    if (options?.transfer?.length) throw dataCloneError('structuredClone transfer is not supported by this WebView.')
    return cloneStructured(value, new Map())
  })
}

// ---- AbortSignal.timeout (Chrome 103 / Safari 16) — 账号同步请求超时 ----
if (typeof AbortSignal !== 'undefined' && typeof AbortController === 'function' && typeof (AbortSignal as any).timeout !== 'function') {
  define(AbortSignal, 'timeout', function timeout(ms: number) {
    const delay = Number(ms)
    if (!Number.isFinite(delay) || delay < 0) throw new TypeError('AbortSignal.timeout expects a non-negative number')
    const controller = new AbortController()
    setTimeout(() => {
      const reason = typeof DOMException === 'function' ? new DOMException('signal timed out', 'TimeoutError') : undefined
      // 旧实现的 abort() 忽略 reason 参数, signal.reason 为 undefined; fetch 仍以 AbortError 结束。
      ;(controller.abort as (reason?: unknown) => void)(reason)
    }, delay)
    return controller.signal
  })
}

// ---- crypto.randomUUID (Chrome 92 / Safari 15.4, 且仅安全上下文) — 书籍/标注 id、设备 id ----
// 旧 WebView、http:// 局域网访问的网页版都没有它; getRandomValues 在非安全上下文同样可用。
{
  const c = (globalThis as any).crypto as Crypto | undefined
  if (c && typeof c.getRandomValues === 'function' && typeof (c as any).randomUUID !== 'function') {
    const hex: string[] = []
    for (let i = 0; i < 256; i++) hex.push((i + 0x100).toString(16).slice(1))
    define(c, 'randomUUID', function randomUUID() {
      const b = c.getRandomValues(new Uint8Array(16))
      b[6] = (b[6]! & 0x0f) | 0x40
      b[8] = (b[8]! & 0x3f) | 0x80
      let s = ''
      for (let i = 0; i < 16; i++) s += (i === 4 || i === 6 || i === 8 || i === 10 ? '-' : '') + hex[b[i]!]
      return s
    })
  }
}

// ---- navigator.clipboard.writeText — 非安全上下文 (http:// 网页、部分旧 WebView) 下不存在 ----
// 回退到 execCommand('copy'); 调用方仍按 Promise 处理成功/失败。
if (typeof navigator !== 'undefined' && typeof document !== 'undefined' && !(navigator as any).clipboard) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    enumerable: false,
    value: {
      writeText(text: string): Promise<void> {
        return new Promise((resolve, reject) => {
          const area = document.createElement('textarea')
          area.value = String(text)
          area.setAttribute('readonly', '')
          area.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none'
          const selection = document.getSelection()
          const previous = selection && selection.rangeCount ? selection.getRangeAt(0) : null
          const active = document.activeElement as HTMLElement | null
          document.body.appendChild(area)
          area.select()
          let ok = false
          try { ok = document.execCommand('copy') } catch { ok = false }
          area.remove()
          if (previous && selection) { selection.removeAllRanges(); selection.addRange(previous) }
          active?.focus?.()
          if (ok) resolve()
          else reject(typeof DOMException === 'function' ? new DOMException('Clipboard is not available', 'NotAllowedError') : new Error('Clipboard is not available'))
        })
      },
    },
  })
}

// ---- 可构造样式表 new CSSStyleSheet() + adoptedStyleSheets (Chrome 73 / Safari 16.4) ----
// foliate-js 的 fixed-layout 渲染器 (固定版式 EPUB、CBZ 漫画) 在构造函数里给 closed 影子根
// 设置样式。它自带的 construct-style-sheets-polyfill 对 closed 影子根不生效 (样式丢失, 页面
// 不居中/不铺满)。这里先装一个更小的实现: 样式表文本写进影子根里的 <style>, 被
// replaceChildren() 清掉后由 MutationObserver 补回; 同时定义 Document 上的属性, 使
// 那个依赖检测到 `'adoptedStyleSheets' in document` 后不再覆盖。
{
  const canConstruct = () => {
    try { return !!new CSSStyleSheet() && 'adoptedStyleSheets' in ShadowRoot.prototype && 'adoptedStyleSheets' in Document.prototype } catch { return false }
  }
  if (typeof document !== 'undefined' && typeof ShadowRoot !== 'undefined' && typeof CSSStyleSheet === 'function'
    && typeof MutationObserver === 'function' && !canConstruct()) {
    const Native = CSSStyleSheet
    const texts = new WeakMap<object, string>()
    const nodes = new WeakMap<object, Set<HTMLStyleElement>>()
    const adopted = new WeakMap<Document | ShadowRoot, { sheets: object[]; styles: HTMLStyleElement[] }>()
    const notAllowed = (message: string) => typeof DOMException === 'function'
      ? new DOMException(message, 'NotAllowedError')
      : new TypeError(message)
    const LegacySheet = function CSSStyleSheet(this: unknown) {
      if (!new.target) throw new TypeError("Failed to construct 'CSSStyleSheet': Please use the 'new' operator")
      const sheet = Object.create(Native.prototype)
      texts.set(sheet, '')
      nodes.set(sheet, new Set())
      return sheet
    } as unknown as typeof CSSStyleSheet
    LegacySheet.prototype = Native.prototype
    Object.defineProperty(LegacySheet, 'name', { configurable: true, value: 'CSSStyleSheet' })
    const replaceSync = function replaceSync(this: object, text: string) {
      if (!texts.has(this)) throw notAllowed('Can only replace constructed stylesheets')
      const css = String(text)
      texts.set(this, css)
      for (const style of nodes.get(this)!) style.textContent = css
    }
    define(Native.prototype, 'replaceSync', replaceSync)
    define(Native.prototype, 'replace', function replace(this: object, text: string) {
      try { replaceSync.call(this, text); return Promise.resolve(this) } catch (e) { return Promise.reject(e) }
    })
    const container = (owner: Document | ShadowRoot): ParentNode => (owner instanceof Document ? owner.head ?? owner.documentElement : owner)
    const descriptor: PropertyDescriptor = {
      configurable: true,
      enumerable: false,
      get(this: Document | ShadowRoot) {
        return adopted.get(this)?.sheets.slice() ?? []
      },
      set(this: Document | ShadowRoot, value: Iterable<object>) {
        const sheets = Array.from(value)
        for (const sheet of sheets) if (!texts.has(sheet)) throw notAllowed("Can't adopt non-constructed stylesheets")
        const owner = this
        let state = adopted.get(owner)
        if (!state) {
          state = { sheets: [], styles: [] }
          adopted.set(owner, state)
          // 渲染器会 replaceChildren() 清空影子根; 被移除的 <style> 补回到末尾 (与原生「层叠在最后」一致)
          new MutationObserver(() => {
            const current = adopted.get(owner)
            const parent = container(owner)
            if (current?.styles.some(style => style.parentNode !== parent)) parent.append(...current.styles)
          }).observe(container(owner), { childList: true })
        }
        state.sheets.forEach((sheet, i) => nodes.get(sheet)?.delete(state!.styles[i]!))
        state.styles.forEach(style => style.remove())
        state.sheets = sheets
        state.styles = sheets.map(sheet => {
          const style = document.createElement('style')
          style.textContent = texts.get(sheet)!
          nodes.get(sheet)!.add(style)
          return style
        })
        container(owner).append(...state.styles)
      },
    }
    Object.defineProperty(ShadowRoot.prototype, 'adoptedStyleSheets', descriptor)
    Object.defineProperty(Document.prototype, 'adoptedStyleSheets', descriptor)
    define(globalThis, 'CSSStyleSheet', LegacySheet)
  }
}

// foliate-js 的 EPUB 元数据解析使用 ES2024 分组 API。Vite 转译语法不会补齐这些 API。
if (!('groupBy' in Object) || typeof Object.groupBy !== 'function') {
  Object.defineProperty(Object, 'groupBy', {
    configurable: true,
    writable: true,
    value: function groupBy<T>(items: Iterable<T>, callback: (item: T, index: number) => PropertyKey) {
      if (typeof callback !== 'function') throw new TypeError('Object.groupBy callback must be a function')
      const groups: Record<PropertyKey, T[]> = Object.create(null)
      let index = 0
      for (const item of items) {
        // Computed keys perform ToPropertyKey once, including objects yielding a Symbol.
        const key = Reflect.ownKeys({ [callback(item, index++)]: null })[0]!
        if (Object.prototype.hasOwnProperty.call(groups, key)) groups[key]!.push(item)
        else groups[key] = [item]
      }
      return groups
    },
  })
}

if (!('groupBy' in Map) || typeof Map.groupBy !== 'function') {
  Object.defineProperty(Map, 'groupBy', {
    configurable: true,
    writable: true,
    value: function groupBy<T, K>(items: Iterable<T>, callback: (item: T, index: number) => K) {
      if (typeof callback !== 'function') throw new TypeError('Map.groupBy callback must be a function')
      const groups = new Map<K, T[]>()
      let index = 0
      for (const item of items) {
        const key = callback(item, index++)
        const group = groups.get(key)
        if (group) group.push(item)
        else groups.set(key, [item])
      }
      return groups
    },
  })
}

const rs = typeof ReadableStream !== 'undefined' ? (ReadableStream.prototype as any) : null

if (rs && !rs[Symbol.asyncIterator]) {
  if (!rs.values) {
    rs.values = function (this: ReadableStream, { preventCancel = false } = {}) {
      const reader = this.getReader()
      return {
        async next() {
          try {
            const result = await reader.read()
            if (result.done) reader.releaseLock()
            return result
          } catch (e) {
            reader.releaseLock()
            throw e
          }
        },
        async return(value?: unknown) {
          if (preventCancel) {
            reader.releaseLock()
          } else {
            const cancel = reader.cancel(value)
            reader.releaseLock()
            await cancel
          }
          return { done: true as const, value }
        },
        [Symbol.asyncIterator]() {
          return this
        },
      }
    }
  }
  rs[Symbol.asyncIterator] = function () {
    return this.values()
  }
}
