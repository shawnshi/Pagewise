#!/usr/bin/env node
/**
 * 生成「书单推荐」里来自 Wikidata 的获奖书单 src/data/booklists/<id>.json, 并重写 index.json。
 *
 * 数据来源:
 *  - Wikidata (CC0): SPARQL 查询「获奖 (P166) = 某奖项」的作品, 再用 wbgetentities 取作品/作者的标签、
 *    作者 (P50)、出版日期 (P577)。年份 year 只取 P577; 获奖年份写在 note 里 (P166 的 P585 限定符)。
 *  - 中文标签依次取 zh-hans / zh / zh-cn / zh-hant 等, 统一经中文维基的繁简转换接口 (variant=zh-cn)
 *    转成简体, 只做字形转换, 不取任何条目内容。
 *  - Wikidata 缺漏的获奖条目在下面的 SUPPLEMENTS 里手工补充 (均已对照官方/权威公布名单核对),
 *    并尽量按「书名 + 作者」匹配回 Wikidata 条目以取得 Q 号与出版年。
 *
 * 手写的编辑书单 (哲学入门 / 古典名著 / 课标书目等) 不由本脚本生成, 也不会被改动;
 * index.json 中它们的顺序保持不变, 本脚本生成的书单排在其后。
 *
 * 用法: node scripts/build-booklists.mjs [--only <id>] [--dry-run] [--date YYYY-MM-DD]
 * 幂等: 书目内容不变时保留原文件的 updated 日期, 输出完全一致。
 * 礼貌访问: 所有请求串行, 间隔 ≥2 秒, 遇 429/5xx 按 Retry-After 退避重试。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(root, 'src/data/booklists')
const USER_AGENT = 'LightRead-booklists/1.0 (https://github.com/yzfly/LightRead)'
const MIN_INTERVAL = 2000
const args = process.argv.slice(2)
const ONLY = args.includes('--only') ? args[args.indexOf('--only') + 1] : null
const DRY = args.includes('--dry-run')
// 本地日期 (YYYY-MM-DD); 可用 --date 指定
const TODAY = args.includes('--date') ? args[args.indexOf('--date') + 1] : new Date().toLocaleDateString('sv-SE')

// ---------------------------------------------------------------- 书单定义
const CN_EDITIONS = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一']

/**
 * 茅盾文学奖: Wikidata 只有少数作品条目带 P166 (2026-10 时 5 部), 因此以中国作家协会历届公布名单为准
 * 逐届手工列出 (已对照中国作家网与中文维基「茅盾文学奖」导航模板核对), 再匹配 Wikidata 条目。
 * [书名, 作者, 备注?]; honor = 荣誉奖。
 */
const MAO_DUN = [
  { ed: 1, year: 1982, works: [['许茂和他的女儿们', '周克芹'], ['东方', '魏巍'], ['李自成', '姚雪垠', '获奖为第二卷'], ['将军吟', '莫应丰'], ['冬天里的春天', '李国文'], ['芙蓉镇', '古华']] },
  { ed: 2, year: 1985, works: [['黄河东流去', '李準'], ['沉重的翅膀', '张洁', '获奖为修订本'], ['钟鼓楼', '刘心武']] },
  { ed: 3, year: 1991, works: [['平凡的世界', '路遥'], ['少年天子', '凌力'], ['都市风流', '孙力、余小惠'], ['第二个太阳', '刘白羽'], ['穆斯林的葬礼', '霍达']] },
  { ed: 3, year: 1991, honor: true, works: [['金瓯缺', '徐兴业'], ['浴血罗霄', '萧克']] },
  { ed: 4, year: 1997, works: [['战争和人', '王火'], ['白鹿原', '陈忠实', '获奖为修订本'], ['白门柳', '刘斯奋', '获奖为第一、二部'], ['骚动之秋', '刘玉民']] },
  { ed: 5, year: 2000, works: [['抉择', '张平'], ['尘埃落定', '阿来'], ['长恨歌', '王安忆'], ['茶人三部曲', '王旭烽', '获奖为第一、二部']] },
  { ed: 6, year: 2005, works: [['张居正', '熊召政'], ['无字', '张洁'], ['历史的天空', '徐贵祥'], ['英雄时代', '柳建伟'], ['东藏记', '宗璞']] },
  { ed: 7, year: 2008, works: [['秦腔', '贾平凹'], ['暗算', '麦家'], ['湖光山色', '周大新'], ['额尔古纳河右岸', '迟子建']] },
  { ed: 8, year: 2011, works: [['你在高原', '张炜'], ['天行者', '刘醒龙'], ['蛙', '莫言'], ['推拿', '毕飞宇'], ['一句顶一万句', '刘震云']] },
  { ed: 9, year: 2015, works: [['江南三部曲', '格非'], ['这边风景', '王蒙'], ['生命册', '李佩甫'], ['繁花', '金宇澄'], ['黄雀记', '苏童']] },
  { ed: 10, year: 2019, works: [['人世间', '梁晓声'], ['牵风记', '徐怀中'], ['北上', '徐则臣'], ['主角', '陈彦'], ['应物兄', '李洱']] },
  { ed: 11, year: 2023, works: [['雪山大地', '杨志军'], ['宝水', '乔叶'], ['本巴', '刘亮程'], ['千里江山图', '孙甘露'], ['回响', '东西']] },
]

const LISTS = [
  {
    id: 'mao-dun-prize',
    award: 'Q451809',
    title: '茅盾文学奖获奖作品',
    description: '中国长篇小说最重要的奖项之一，1982 年首届至 2023 年第十一届的全部获奖作品，按届次排列。',
    en: { title: 'Mao Dun Literature Prize Winners', description: 'Every novel honoured by the Mao Dun Literature Prize, from the 1st (1982) to the 11th (2023) edition, in award order.' },
    tags: ['获奖', '中国当代文学', '长篇小说'],
    source: { name: 'Wikidata（多数条目据中国作家协会公布名单人工核对补充）', url: 'https://www.wikidata.org/wiki/Q451809', license: 'CC0-1.0' },
    mode: 'editions',
    editions: MAO_DUN,
  },
  {
    id: 'hugo-best-novel',
    award: 'Q255032',
    title: '雨果奖最佳长篇小说',
    description: '世界科幻大会读者投票选出的年度最佳长篇小说，1953 年至今的获奖作品，按获奖年份排列。',
    en: { title: 'Hugo Award for Best Novel', description: 'Novels voted best of the year by members of the World Science Fiction Convention, from 1953 to the present, in award order.' },
    tags: ['获奖', '科幻', '奇幻'],
    source: { name: 'Wikidata', url: 'https://www.wikidata.org/wiki/Q255032', license: 'CC0-1.0' },
    // 2011 年获奖的是两卷本 Blackout/All Clear, Wikidata 同时给两卷单独标了 P166, 只保留合集条目
    exclude: ['Q11681262', 'Q18366291'],
    overrides: { Q190192: { title: '沙丘' } },
    // 作者条目的中文标签有误 (Alix E. Harrow 被标成了另一位作家的名字), 改用英文名
    authorOverrides: { Q69802945: { zh: null } },
  },
  {
    id: 'booker-prize',
    award: 'Q160082',
    title: '布克奖获奖作品',
    description: '英语世界最受关注的小说奖之一，1969 年首届至今的获奖作品，按获奖年份排列。',
    en: { title: 'Booker Prize Winners', description: 'Winners of the Booker Prize for fiction since the first award in 1969, in award order.' },
    tags: ['获奖', '外国文学', '长篇小说'],
    source: { name: 'Wikidata（个别缺漏条目人工核对补充）', url: 'https://www.wikidata.org/wiki/Q160082', license: 'CC0-1.0' },
    // 《Troubles》是 2010 年「失落的布克奖」(为 1970 年补设) 得主, 不是当年的布克奖
    exclude: ['Q4000425'],
    supplements: [{ awardYear: 2025, title: 'Flesh', author: 'David Szalay', lang: 'en' }],
  },
]

// ---------------------------------------------------------------- 礼貌请求
let lastRequest = 0
async function politeFetch(url, init = {}) {
  for (let attempt = 0; ; attempt++) {
    const wait = lastRequest + MIN_INTERVAL - Date.now()
    if (wait > 0) await new Promise(r => setTimeout(r, wait))
    lastRequest = Date.now()
    let res
    try {
      res = await fetch(url, { ...init, headers: { 'user-agent': USER_AGENT, ...(init.headers ?? {}) } })
    } catch (e) {
      if (attempt >= 4) throw e
      await new Promise(r => setTimeout(r, 5000 * (attempt + 1)))
      continue
    }
    if (res.ok) return res
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      const ra = Number(res.headers.get('retry-after'))
      await new Promise(r => setTimeout(r, (Number.isFinite(ra) && ra > 0 ? ra : 10 * (attempt + 1)) * 1000))
      continue
    }
    throw new Error(`${res.status} ${url}\n${(await res.text()).slice(0, 500)}`)
  }
}

async function sparql(query) {
  const res = await politeFetch('https://query.wikidata.org/sparql', {
    method: 'POST',
    headers: { accept: 'application/sparql-results+json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ query }),
  })
  const json = await res.json()
  return json.results.bindings.map(b => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v.value])))
}

const qid = uri => uri.replace(/^https?:\/\/www\.wikidata\.org\/entity\//, '')

// zh-hans 与 zh 多为常用译名; zh-cn 标签有时是全名 (如「小弗兰克·帕特里克·赫伯特」), 排在其后
const LABEL_LANGS = ['zh-hans', 'zh', 'zh-cn', 'zh-sg', 'zh-hant', 'zh-tw', 'zh-hk', 'en', 'mul']
const entityCache = new Map()
async function getEntities(ids) {
  const missing = [...new Set(ids)].filter(id => !entityCache.has(id))
  for (let i = 0; i < missing.length; i += 50) {
    const batch = missing.slice(i, i + 50)
    const url = 'https://www.wikidata.org/w/api.php?' + new URLSearchParams({
      action: 'wbgetentities', ids: batch.join('|'), props: 'labels|claims', languages: LABEL_LANGS.join('|'), format: 'json', formatversion: '2',
    })
    const json = await (await politeFetch(url)).json()
    for (const id of batch) entityCache.set(id, json.entities?.[id] ?? null)
  }
  return ids.map(id => entityCache.get(id))
}

const claimValues = (entity, prop) => (entity?.claims?.[prop] ?? [])
  .filter(c => c.rank !== 'deprecated' && c.mainsnak?.datavalue)
  .map(c => c.mainsnak.datavalue.value)

function pubYear(entity) {
  const years = claimValues(entity, 'P577').map(v => parseInt(/^([+-]\d+)-/.exec(v.time)?.[1] ?? 'NaN', 10)).filter(Number.isFinite)
  return years.length ? Math.min(...years) : undefined
}

const label = (entity, langs) => {
  for (const l of langs) { const v = entity?.labels?.[l]?.value; if (v) return { value: v, lang: l } }
  return null
}

// ---------------------------------------------------------------- 中文: 繁简转换与清理
const HAN = /[㐀-鿿]/
/** 用中文维基的 LanguageConverter 把一批文本转成指定变体 (zh-cn / zh-tw)。只做字形转换。 */
async function convertZh(texts, variant) {
  const uniq = [...new Set(texts.filter(t => HAN.test(t)))]
  const map = new Map(texts.map(t => [t, t]))
  for (let i = 0; i < uniq.length; i += 80) {
    const batch = uniq.slice(i, i + 80)
    const res = await politeFetch('https://zh.wikipedia.org/w/api.php', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        action: 'parse', format: 'json', formatversion: '2', contentmodel: 'wikitext', prop: 'text',
        disablelimitreport: '1', variant, text: batch.join('\n'),
      }),
    })
    const html = (await res.json()).parse.text
    const lines = html.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
      .split('\n').map(s => s.trim()).filter(Boolean)
    if (lines.length !== batch.length) throw new Error(`zh conversion returned ${lines.length} lines for ${batch.length}`)
    batch.forEach((t, j) => map.set(t, lines[j]))
  }
  return map
}

function cleanTitle(s) {
  return s.trim()
    .replace(/^《(.*)》$/, '$1')
    .replace(/\s*[（(](?:小說|小说|長篇小說|长篇小说|小說系列|小说系列|novel)[)）]\s*$/i, '')
    .trim()
}

// ---------------------------------------------------------------- 输出格式
/** 顶层与 source/en 缩进 2 空格, books 每本一行, 末尾换行。 */
export function formatList(list) {
  const lines = ['{']
  const keys = Object.keys(list)
  keys.forEach((k, i) => {
    const comma = i < keys.length - 1 ? ',' : ''
    if (k === 'books') {
      lines.push('  "books": [')
      list.books.forEach((b, j) => lines.push('    ' + JSON.stringify(b) + (j < list.books.length - 1 ? ',' : '')))
      lines.push('  ]' + comma)
    } else {
      lines.push(`  ${JSON.stringify(k)}: ${JSON.stringify(list[k], null, 2).replace(/\n/g, '\n  ')}${comma}`)
    }
  })
  lines.push('}')
  return lines.join('\n') + '\n'
}

// ---------------------------------------------------------------- 构建
async function awardStatements(award) {
  const rows = await sparql(`SELECT ?work ?date WHERE {
    ?work p:P166 ?st . ?st ps:P166 wd:${award} ; wikibase:rank ?rank .
    FILTER(?rank != wikibase:DeprecatedRank)
    OPTIONAL { ?st pq:P585 ?date }
  }`)
  return rows.map(r => ({ id: qid(r.work), year: r.date ? parseInt(/^(-?\d+)-/.exec(r.date)[1], 10) : undefined }))
}

/** 按「书名 + 作者」在 Wikidata 找作品条目。titles: [{title, author, lang}] → Map(key → {id, entity}) */
async function lookupWorks(items) {
  if (!items.length) return new Map()
  const zhItems = items.filter(i => i.lang === 'zh')
  const tw = await convertZh(zhItems.flatMap(i => [i.title, i.author]), 'zh-tw')
  const values = new Set()
  for (const it of items) {
    const forms = it.lang === 'zh' ? [it.title, tw.get(it.title)] : [it.title]
    const langs = it.lang === 'zh' ? ['zh', 'zh-hans', 'zh-cn', 'zh-hant', 'zh-tw', 'zh-hk'] : ['en', 'mul']
    for (const f of new Set(forms)) for (const l of langs) values.add(`${JSON.stringify(f)}@${l}`)
  }
  const rows = await sparql(`SELECT DISTINCT ?w ?label WHERE {
    VALUES ?label { ${[...values].join(' ')} }
    ?w rdfs:label ?label ; wdt:P50 ?a .
  }`)
  const candidates = [...new Set(rows.map(r => qid(r.w)))]
  const ents = await getEntities(candidates)
  const authorIds = ents.flatMap(e => claimValues(e, 'P50').map(v => v.id))
  await getEntities(authorIds)
  const authorNames = new Set()
  for (const id of authorIds) for (const l of Object.values(entityCache.get(id)?.labels ?? {})) authorNames.add(l.value)
  const toCn = await convertZh([...authorNames], 'zh-cn')
  const found = new Map()
  for (const it of items) {
    const titleForms = new Set(it.lang === 'zh' ? [it.title, tw.get(it.title)] : [it.title])
    const wantAuthors = it.author.split(/[、,，&]| and /).map(s => s.trim()).filter(Boolean)
    const hits = rows.filter(r => titleForms.has(r.label)).map(r => qid(r.w)).filter((id, i, a) => a.indexOf(id) === i).filter(id => {
      const names = claimValues(entityCache.get(id), 'P50').flatMap(v => Object.values(entityCache.get(v.id)?.labels ?? {}).map(l => toCn.get(l.value) ?? l.value))
      return wantAuthors.some(a => names.some(n => n === a || n.replace(/[·・\s]/g, '') === a.replace(/[·・\s]/g, '')))
    })
    if (hits.length === 1) found.set(it.title + '|' + it.author, { id: hits[0], entity: entityCache.get(hits[0]) })
    else if (hits.length > 1) console.warn(`  ? 多个匹配, 未采用: ${it.title} / ${it.author}: ${hits.join(', ')}`)
  }
  return found
}

async function displayFor(entities, spec) {
  // 收集需要繁→简转换的标签
  const pending = []
  const pick = (entity, override) => {
    if (override !== undefined) return override
    const l = label(entity, LABEL_LANGS.slice(0, 7))
    if (!l) return null
    pending.push(l.value) // zh-cn/zh-hans 标签里也偶有繁体字, 一律过一遍转换 (对简体是恒等的)
    return l
  }
  const rows = entities.map(e => {
    const ov = spec.overrides?.[e.id] ?? {}
    const t = pick(e, ov.title !== undefined ? { value: ov.title, lang: 'zh-cn' } : undefined)
    const authors = [...new Map(claimValues(e, 'P50').map(v => [v.id, v])).values()].map(v => {
      const a = entityCache.get(v.id)
      const aov = spec.authorOverrides?.[v.id]
      return { zh: aov && 'zh' in aov ? (aov.zh ? { value: aov.zh, lang: 'zh-cn' } : null) : pick(a, undefined), en: label(a, ['en', 'mul'])?.value }
    })
    return { e, t, authors }
  })
  const cn = await convertZh(pending, 'zh-cn')
  const conv = l => (l ? cleanTitle(cn.get(l.value) ?? l.value) : null)
  return rows.map(({ e, t, authors }) => {
    const en = label(e, ['en', 'mul'])?.value ?? spec.overrides?.[e.id]?.en ?? null
    const zhTitle = conv(t)
    const authorZh = authors.map(a => conv(a.zh) ?? a.en).filter(Boolean)
    const authorEn = authors.map(a => a.en).filter(Boolean)
    return { id: e.id, zhTitle, enTitle: en, authorZh, authorEn, year: pubYear(e) }
  })
}

function bookFrom(d, note, fallback = {}) {
  const title = d?.zhTitle || d?.enTitle || fallback.title
  const author = (d?.authorZh?.length ? d.authorZh.join('、') : '') || fallback.author
  const book = { title, author }
  if (d?.year !== undefined) book.year = d.year
  if (note) book.note = note
  const origTitle = d?.enTitle ?? fallback.originalTitle
  const origAuthor = d?.authorEn?.length ? d.authorEn.join(', ') : fallback.originalAuthor
  // 书名或作者用了中文时, 附上英文/原文书名与作者, 便于匹配下载文件和换个语言搜索
  if (origTitle && (origTitle !== title || (origAuthor && origAuthor !== author))) book.original = { title: origTitle, author: origAuthor || author }
  if (d?.id) book.wikidata = d.id
  return book
}

async function buildList(spec) {
  console.log(`• ${spec.id} (${spec.award})`)
  const statements = (await awardStatements(spec.award)).filter(s => !spec.exclude?.includes(s.id))
  const ents = (await getEntities(statements.map(s => s.id))).filter(Boolean)
  // 只要作品, 不要获奖的人 (P31 = Q5)
  const works = ents.filter(e => !claimValues(e, 'P31').some(v => v.id === 'Q5'))
  await getEntities(works.flatMap(e => claimValues(e, 'P50').map(v => v.id)))
  const yearOf = new Map()
  for (const s of statements) if (s.year !== undefined && (!yearOf.has(s.id) || s.year < yearOf.get(s.id))) yearOf.set(s.id, s.year)
  const books = []

  if (spec.mode === 'editions') {
    const items = spec.editions.flatMap(ed => ed.works.map(([title, author, remark]) => ({ ed, title, author, remark, lang: 'zh' })))
    const displays = new Map((await displayFor(works, spec)).map(d => [d.id, d]))
    // 先用 P166 作品按书名匹配, 剩下的再按「书名 + 作者」查找
    const byTitle = new Map([...displays.values()].map(d => [d.zhTitle, d]))
    const unresolved = items.filter(it => !byTitle.has(it.title))
    const looked = await lookupWorks(unresolved)
    const lookedDisplays = new Map((await displayFor([...looked.values()].map(v => v.entity), spec)).map(d => [d.id, d]))
    const used = new Set()
    for (const it of items) {
      let d = byTitle.get(it.title)
      if (!d) { const hit = looked.get(it.title + '|' + it.author); d = hit ? lookedDisplays.get(hit.id) : undefined }
      if (d) used.add(d.id)
      const note = `第${CN_EDITIONS[it.ed.ed - 1]}届（${it.ed.year}）${it.ed.honor ? '荣誉奖' : '获奖'}${it.remark ? '，' + it.remark : ''}`
      // 书名、作者以公布名单为准, Wikidata 只提供 Q 号与出版年
      const book = { title: it.title, author: it.author }
      if (d?.year !== undefined) book.year = d.year
      book.note = note
      if (d) book.wikidata = d.id
      books.push(book)
    }
    for (const d of displays.values()) if (!used.has(d.id)) console.warn(`  ! Wikidata 有获奖作品未在名单中: ${d.id} ${d.zhTitle}`)
    const matched = books.filter(b => b.wikidata).length
    console.log(`  ${books.length} 部; 其中 ${matched} 部匹配到 Wikidata 条目 (P166 直接标注 ${works.length} 部)`)
  } else {
    const displays = await displayFor(works, spec)
    const entries = displays.map(d => ({ d, year: yearOf.get(d.id) }))
    for (const s of spec.supplements ?? []) {
      const hit = (await lookupWorks([s])).get(s.title + '|' + s.author)
      if (hit && entries.some(e => e.d.id === hit.id)) continue
      const d = hit ? (await displayFor([hit.entity], spec))[0] : null
      entries.push({ d, year: s.awardYear, fallback: { title: s.title, author: s.author, originalTitle: s.title, originalAuthor: s.author }, manual: true })
      console.log(`  + 人工补充 ${s.awardYear} ${s.title}${hit ? ' → ' + hit.id : ' (Wikidata 未匹配到条目)'}`)
    }
    const missingYear = entries.filter(e => e.year === undefined)
    for (const e of missingYear) console.warn(`  ! 缺少获奖年份 (P585), 跳过: ${e.d.id} ${e.d.zhTitle ?? e.d.enTitle}`)
    const valid = entries.filter(e => e.year !== undefined)
    valid.sort((a, b) => a.year - b.year || Number((a.d?.id ?? 'Q9e15').slice(1)) - Number((b.d?.id ?? 'Q9e15').slice(1)))
    const perYear = new Map()
    for (const e of valid) perYear.set(e.year, (perYear.get(e.year) ?? 0) + 1)
    for (const e of valid) {
      const note = `${e.year} 年获奖${perYear.get(e.year) > 1 ? '（并列）' : ''}`
      const book = bookFrom(e.d, note, e.fallback)
      if (!book.title || !book.author) { console.warn(`  ! 缺书名或作者, 跳过: ${e.d?.id}`); continue }
      books.push(book)
    }
    console.log(`  ${books.length} 部`)
  }

  const file = join(OUT_DIR, spec.id + '.json')
  const prev = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
  const list = {
    id: spec.id,
    title: spec.title,
    description: spec.description,
    en: spec.en,
    curator: '轻阅 · 据 Wikidata 整理',
    tags: spec.tags,
    updated: TODAY,
    source: spec.source,
    books,
  }
  const comparable = l => JSON.stringify({ ...l, updated: '' })
  if (prev && comparable(prev) === comparable(list)) list.updated = prev.updated
  const text = formatList(list)
  if (DRY) console.log(text.slice(0, 2000))
  else writeFileSync(file, text)
  return list
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  const specs = LISTS.filter(l => !ONLY || l.id === ONLY)
  for (const spec of specs) await buildList(spec)
  // index.json: 保留非本脚本生成的书单 (编辑书单 / 官方书目) 原有顺序, 生成的书单排在后面
  const indexFile = join(OUT_DIR, 'index.json')
  const prev = existsSync(indexFile) ? JSON.parse(readFileSync(indexFile, 'utf8')) : null
  const generated = LISTS.map(l => l.id)
  const kept = (prev?.lists ?? []).filter(id => !generated.includes(id) && existsSync(join(OUT_DIR, id + '.json')))
  const index = { version: 1, updated: TODAY, lists: [...kept, ...generated.filter(id => existsSync(join(OUT_DIR, id + '.json')))] }
  if (prev && JSON.stringify(prev.lists) === JSON.stringify(index.lists) && prev.version === index.version) {
    // 列表本身没变时, 若各书单也都没更新, 沿用原日期
    const newest = index.lists.map(id => JSON.parse(readFileSync(join(OUT_DIR, id + '.json'), 'utf8')).updated).sort().at(-1)
    index.updated = newest && newest <= prev.updated ? prev.updated : TODAY
  }
  const text = JSON.stringify(index, null, 2) + '\n'
  if (DRY) console.log(text)
  else writeFileSync(indexFile, text)
  console.log('done')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(e => { console.error(e); process.exit(1) })
}
