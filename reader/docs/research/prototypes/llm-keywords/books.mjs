import { readFileSync } from 'node:fs'
const ROOT = (process.env.LLMKW_DIR ?? process.cwd()) + '/'
export const BOOKS = [
  { id: 'fiction', title: '阿Q正传', author: '鲁迅', kind: '中篇小说', famous: true },
  { id: 'science', title: '黑洞（维基百科条目）', author: '', kind: '科普文章', famous: true },
  { id: 'technical', title: '传输控制协议（维基百科条目）', author: '', kind: '技术文章', famous: true },
  { id: 'nahan', title: '呐喊', author: '鲁迅', kind: '短篇小说集', famous: true },
  { id: 'laocan', title: '老残游记', author: '刘鹗', kind: '晚清长篇小说', famous: true },
  { id: 'duanhong', title: '断鸿零雁记', author: '苏曼殊', kind: '民初文言中篇小说', famous: false },
]
/** 每行一段, `### 标题` 分章 */
export function loadText(id) {
  const paras = [], chapters = [], titles = []
  for (const raw of readFileSync(`${ROOT}texts/${id}.txt`, 'utf8').split('\n')) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('###')) { chapters.push(paras.length); titles.push(line.slice(3).trim()); continue }
    paras.push(line)
  }
  if (!chapters.length || chapters[0] !== 0) { chapters.unshift(0); titles.unshift('') }
  return { paras, chapters: [...new Set(chapters)], titles }
}
/** 按章切块, 每块 ≤ max 字, 段落完整 */
export function chunks(paras, chapters, max = 3000) {
  const out = []
  const bounds = [...chapters, paras.length]
  for (let c = 0; c + 1 < bounds.length; c++) {
    let cur = [], n = 0, start = bounds[c]
    for (let i = bounds[c]; i < bounds[c + 1]; i++) {
      if (n + paras[i].length > max && cur.length) { out.push({ chapter: c, from: start, text: cur.join('\n') }); cur = []; n = 0; start = i }
      cur.push(paras[i]); n += paras[i].length
    }
    if (cur.length) out.push({ chapter: c, from: start, text: cur.join('\n') })
  }
  return out
}
