#!/usr/bin/env node
/**
 * 生成仿生阅读用的中文词表 (可复现)。调研与选词依据见 docs/research/zh-segmentation-for-word-guide.md §4、§5.1。
 *
 *   node scripts/build-zh-lexicon.mjs [--cache <dir>] [--offline] [--tiers 24] [--out <txt>] [--out-merge <ts>]
 *
 * 输入 (下载到仓库外的缓存目录, 默认 ~/.cache/lightread/zh-lexicon, 按 SHA-256 校验):
 *   - jieba 词典 dict.txt (MIT, Copyright (c) 2013 Sun Junyi), 固定在 v0.42.1
 *   - DeepSeek-R1 的 tokenizer.json (MIT, Copyright (c) 2023 DeepSeek), 固定在一个提交; 先试 huggingface.co, 再试 hf-mirror.com
 * 输出:
 *   - src/data/zh-lexicon.txt                      约 6.6 万词, 只有词、没有词频, 分档 + 前缀压缩 (格式见 zhSegment.ts parseZhLexicon)
 *   - src/services/readingModes/zhMergeWords.ts     约 2,600 个三四字常用词: 词表下载完之前给 ICU 分词做合并
 *
 * 选词: jieba 词典里同时是 DeepSeek 词元的多字词 (约 1.8 万, 当作「现代常用」的信号) 优先,
 *       再按 jieba 词频补足到 6 万个多字词, 加上前 5,000 条四字成语 (jieba 词性 i) 和前 3,000 个单字,
 *       最后整体按 jieba 词频排序 (分词只用名次)。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const N_MULTI = 60000
const N_IDIOM = 5000
const N_SINGLE = 3000
/**
 * 分档数: 档界按名次等比划分 (常用词档小、生僻词档大), 档内名次相同。
 * 24 档时切分结果与存精确名次一致 (PKU / MSR 错切率不变), 比 16 档多约 11 KB (gzip)。
 */
const TIERS = Number(arg('--tiers') ?? 24)

const DEEPSEEK_REV = '56d4cbbb4d29f4355bab4b9a39ccb717a14ad5ad'
const SOURCES = {
  jieba: {
    file: 'jieba-v0.42.1-dict.txt',
    sha256: '7197c3211ddd98962b036cdf40324d1ea2bfaa12bd028e68faa70111a88e12a8',
    urls: [
      'https://raw.githubusercontent.com/fxsjy/jieba/v0.42.1/jieba/dict.txt',
      'https://cdn.jsdelivr.net/gh/fxsjy/jieba@v0.42.1/jieba/dict.txt',
    ],
  },
  deepseek: {
    file: `deepseek-r1-${DEEPSEEK_REV.slice(0, 12)}-tokenizer.json`,
    sha256: 'ecb6f9fc369894346f0511f4074ca75cee5cd5f3b06d02f1ba35fcd39f8e121d',
    urls: [
      `https://huggingface.co/deepseek-ai/DeepSeek-R1/resolve/${DEEPSEEK_REV}/tokenizer.json`,
      `https://hf-mirror.com/deepseek-ai/DeepSeek-R1/resolve/${DEEPSEEK_REV}/tokenizer.json`,
    ],
  },
}

function arg(name) {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}
const offline = process.argv.includes('--offline')
const cacheDir = arg('--cache') ?? process.env.ZH_LEXICON_CACHE
  ?? join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'lightread', 'zh-lexicon')
const outLexicon = arg('--out') ?? join(ROOT, 'src/data/zh-lexicon.txt')
const outMerge = arg('--out-merge') ?? join(ROOT, 'src/services/readingModes/zhMergeWords.ts')

const sha256 = buf => createHash('sha256').update(buf).digest('hex')

async function fetchSource({ file, sha256: want, urls }) {
  const path = join(cacheDir, file)
  if (existsSync(path)) {
    const buf = readFileSync(path)
    if (sha256(buf) === want) return buf
    console.warn(`cache ${file}: checksum mismatch, downloading again`)
  }
  if (offline) throw new Error(`${file} is not in ${cacheDir} (--offline)`)
  mkdirSync(cacheDir, { recursive: true })
  for (const url of urls) {
    try {
      console.log(`download ${url}`)
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(180_000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const buf = Buffer.from(await res.arrayBuffer())
      const got = sha256(buf)
      if (got !== want) throw new Error(`checksum ${got} != ${want}`)
      writeFileSync(path, buf)
      return buf
    } catch (e) {
      console.warn(`  failed: ${e.message}`)
    }
  }
  throw new Error(`could not download ${file}`)
}

/** GPT-2 的字节 <-> Unicode 映射 (byte-level BPE 词元还原成 UTF-8 字节) */
function unicodeToBytes() {
  const bs = []
  for (let b = 33; b <= 126; b++) bs.push(b)
  for (let b = 161; b <= 172; b++) bs.push(b)
  for (let b = 174; b <= 255; b++) bs.push(b)
  const cs = bs.slice()
  let n = 0
  for (let b = 0; b < 256; b++) if (!bs.includes(b)) { bs.push(b); cs.push(256 + n++) }
  const map = new Map()
  bs.forEach((b, i) => map.set(String.fromCharCode(cs[i]), b))
  return map
}

const HAN = /^[一-鿿]+$/
const utf8 = new TextDecoder('utf-8', { fatal: true })

function deepseekHanTokens(buf) {
  const u2b = unicodeToBytes()
  const vocab = JSON.parse(buf.toString('utf8')).model.vocab
  const out = new Set()
  for (const tok of Object.keys(vocab)) {
    const bytes = []
    let ok = true
    for (const ch of tok) {
      const b = u2b.get(ch)
      if (b === undefined) { ok = false; break }
      bytes.push(b)
    }
    if (!ok) continue
    let s
    try { s = utf8.decode(Uint8Array.from(bytes)) } catch { continue } // 半个汉字的字节片段
    if (s.length >= 2 && HAN.test(s)) out.add(s)
  }
  return out
}

function readJieba(buf) {
  const words = []
  const idioms = []
  for (const line of buf.toString('utf8').split('\n')) {
    const p = line.trim().split(/\s+/)
    if (p.length < 2 || !HAN.test(p[0])) continue
    const f = Number(p[1])
    words.push([p[0], f])
    if (p[2] === 'i' && p[0].length === 4) idioms.push([p[0], f])
  }
  // 词频相同时保持词典原有顺序 (Array.prototype.sort 是稳定的), 结果可复现
  words.sort((a, b) => b[1] - a[1])
  idioms.sort((a, b) => b[1] - a[1])
  return { words, idioms }
}

/** 名次 -> 档: 档界按等比划分, 每档至少 1 个词 */
function tierBounds(total, tiers) {
  const bounds = []
  let prev = 0
  for (let t = 1; t <= tiers; t++) {
    const end = t === tiers ? total : Math.max(prev + 1, Math.round(Math.pow(total, t / tiers)))
    if (end > prev) bounds.push(end)
    prev = end
    if (end >= total) break
  }
  return bounds
}

function encodeLexicon(ranked, tiers) {
  const bounds = tierBounds(ranked.length, tiers)
  const lines = [
    '# LightRead zh-lexicon v1: Chinese words for the word guide, most common first (tiers separated by "-";',
    '# each line = length of prefix shared with the previous line + rest). Built by scripts/build-zh-lexicon.mjs.',
    '# Derived from jieba dict.txt (MIT, Copyright (c) 2013 Sun Junyi) and the DeepSeek-R1 tokenizer vocabulary',
    '# (MIT, Copyright (c) 2023 DeepSeek). Licence texts: src/data/zh-lexicon.README.md',
  ]
  let start = 0
  bounds.forEach((end, t) => {
    if (t > 0) lines.push('-')
    const tier = ranked.slice(start, end).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    let prev = ''
    for (const w of tier) {
      let k = 0
      const lim = Math.min(9, prev.length, w.length)
      while (k < lim && prev[k] === w[k]) k++
      lines.push(k + w.slice(k))
      prev = w
    }
    start = end
  })
  return lines.join('\n') + '\n'
}

function encodeMerge(words) {
  // 每行约 40 个词, 空格分隔: 源文件可读, 打包后是一个字符串字面量
  const rows = []
  for (let i = 0; i < words.length; i += 40) rows.push(`  '${words.slice(i, i + 40).join(' ')}',`)
  return `/**
 * 自动生成, 不要手改: node scripts/build-zh-lexicon.mjs
 *
 * 三、四字常用词 (${words.length} 个, 按 jieba 词频降序): jieba 词典里同时是 DeepSeek-R1 词元的三四字词。
 * 仿生阅读的词表下载完之前, 给 Intl.Segmenter 的切分结果做合并 (「图书|馆」→「图书馆」)。
 * 来源: jieba dict.txt (MIT, Copyright (c) 2013 Sun Junyi); DeepSeek-R1 tokenizer (MIT, Copyright (c) 2023 DeepSeek)。
 * 许可全文见 src/data/zh-lexicon.README.md。
 */
export const ZH_MERGE_LIST: string = [
${rows.join('\n')}
].join(' ')
`
}

async function main() {
  const [jiebaBuf, dsBuf] = [await fetchSource(SOURCES.jieba), await fetchSource(SOURCES.deepseek)]
  const ds = deepseekHanTokens(dsBuf)
  const { words, idioms } = readJieba(jiebaBuf)

  const multi = words.filter(([w]) => w.length >= 2)
  const sel = multi.filter(([w]) => ds.has(w))
  const fromDs = sel.length
  const have = new Set(sel.map(([w]) => w))
  for (const e of multi) {
    if (sel.length >= N_MULTI) break
    if (!have.has(e[0])) { sel.push(e); have.add(e[0]) }
  }
  let nIdiom = 0
  for (const e of idioms.slice(0, N_IDIOM)) if (!have.has(e[0])) { sel.push(e); have.add(e[0]); nIdiom++ }
  const singles = words.filter(([w]) => w.length === 1).slice(0, N_SINGLE)
  sel.push(...singles)
  // 稳定排序: 先按词频降序, 同频按上面的加入顺序
  const ranked = sel.map((e, i) => [e[0], e[1], i]).sort((a, b) => b[1] - a[1] || a[2] - b[2]).map(e => e[0])

  const lexicon = encodeLexicon(ranked, TIERS)
  const merge = words.filter(([w]) => (w.length === 3 || w.length === 4) && ds.has(w)).map(([w]) => w)
  const mergeTs = encodeMerge(merge)

  mkdirSync(dirname(outLexicon), { recursive: true })
  writeFileSync(outLexicon, lexicon)
  writeFileSync(outMerge, mergeTs)

  const kb = n => `${(n / 1024).toFixed(1)} KB`
  const lexBytes = Buffer.byteLength(lexicon)
  console.log(`DeepSeek multi-char Han tokens: ${ds.size}; jieba ∩ DeepSeek: ${fromDs}`)
  console.log(`lexicon: ${ranked.length} words (${fromDs} from jieba∩DeepSeek, ${N_MULTI - fromDs} topped up by frequency, ${nIdiom} idioms, ${singles.length} single chars)`)
  console.log(`  ${outLexicon}: ${kb(lexBytes)} raw, ${kb(gzipSync(lexicon, { level: 9 }).length)} gzip`)
  console.log(`merge table: ${merge.length} words`)
  console.log(`  ${outMerge}: ${kb(Buffer.byteLength(mergeTs))} raw, ${kb(gzipSync(mergeTs, { level: 9 }).length)} gzip`)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
