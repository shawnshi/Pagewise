// 点睛阅读的纯函数契约: 提示词 / NDJSON 流式解析 / 编号映射 / 术语锚定 / 密度过滤 / 缓存键 / 体裁识别 / 额度换算 / relay 与客户端提示词同源
// node --experimental-strip-types --test scripts/test-dianjing.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  buildChatBody,
  buildMessages,
  chargeChars,
  CNY_TO_UNITS,
  costUnits,
  DAILY_BUDGET_CNY,
  DEVICE_DAILY_CHARS,
  DJ_MODEL,
  estimateTokens,
  LEGACY_PROMPT_VERSIONS,
  MAX_TOKENS,
  needsTranslation,
  PROMPT_VERSION,
  sanitizeRequest,
  validateRequest,
} from '../src/services/dianjing/prompt.ts'
import { chunkSection, hashText, numberBlocks, requestOrder, resolveSentence, chunkIndexForBlock } from '../src/services/dianjing/chunker.ts'
import { chunkPlainText, findTermSpan, keyWordsUsable, NdjsonParser, resolveItem, selectKeys, selectTerms, SseDeltaParser, wantsKeyWords } from '../src/services/dianjing/protocol.ts'
import { decideFiction, fictionFromMeta, fictionFromText } from '../src/services/dianjing/fiction.ts'
import { bookRange, cacheKey, createMemoryCache, feedbackKey, sectionKey } from '../src/services/dianjing/cache.ts'
import { dianjingCSS, djColors, djThemeName, DJ_PRIORITY } from '../src/services/dianjing/theme.ts'
import { splitSentences } from '../src/services/readAloud.ts'
import { applyDjAction, dianjingOn, effectiveLevels, migrateLevel, normalizeLevel, smartOnFor } from '../src/services/dianjing/level.ts'
import { CHAT_MODEL, LEGACY_MODELS, quotaDay, rateLimited, sseToNdjson } from '../relay/src/lib.js'

const sentences = (text, lang = 'zh') => splitSentences(text, lang).map(s => text.slice(s.start, s.end))
const blocksOf = (paras, lang) => paras.map((p, i) => ({ block: i, sentences: sentences(p, lang) }))

const PARAS = [
  '经济学研究的是社会如何管理自己的稀缺资源。在大多数社会中，资源是通过千百万家庭和企业的共同行动来配置的。',
  '人们面临权衡取舍。你可能听过一句老话：“天下没有免费的午餐。”为了得到一件东西，通常就不得不放弃另一件东西。',
  '某种东西的成本是为了得到它所放弃的东西。经济学家用机会成本这个术语来指为了得到某种东西所必须放弃的东西。',
]

// ---- 提示词 ----

test('提示词: 系统提示含规则, 用户消息含书名章名与编号正文', () => {
  const text = numberBlocks(blocksOf(PARAS))
  const msgs = buildMessages({ promptVersion: PROMPT_VERSION, mode: 'mark', lang: 'zh', book: { title: '经济学原理', author: '曼昆' }, chapter: '第一章', text, knownTerms: ['稀缺'] })
  assert.equal(msgs.length, 2)
  assert.equal(msgs[0].role, 'system')
  assert.match(msgs[0].content, /NDJSON/)
  assert.match(msgs[0].content, /一字不差/)
  assert.match(msgs[0].content, /简体中文/)
  assert.doesNotMatch(msgs[0].content, /\{LANG\}/)
  assert.match(msgs[1].content, /《经济学原理》 曼昆/)
  assert.match(msgs[1].content, /章：第一章/)
  assert.match(msgs[1].content, /已解释过的概念.*稀缺/)
  assert.match(msgs[1].content, /\[1\.1\] 经济学研究的是/)
})

test('提示词: 叙事类加防剧透, 首块问体裁, 外语书加译文, 英文界面用英文模板', () => {
  const base = { promptVersion: PROMPT_VERSION, mode: 'mark', book: {}, text: '[1.1] x' }
  assert.match(buildMessages({ ...base, lang: 'zh', fiction: true })[0].content, /不得提及、暗示或推测本段之后的情节/)
  assert.match(buildMessages({ ...base, lang: 'zh', askGenre: true })[0].content, /"t":"meta"/)
  assert.match(buildMessages({ ...base, lang: 'zh', bookLang: 'en-US' })[0].content, /"t":"tr"/)
  assert.doesNotMatch(buildMessages({ ...base, lang: 'zh', bookLang: 'zh-CN' })[0].content, /"t":"tr"/)
  const en = buildMessages({ ...base, lang: 'en', fiction: true })[0].content
  assert.match(en, /never mention, hint at/)
  assert.match(en, /in English/)
  assert.equal(needsTranslation('', 'zh'), false)
  assert.equal(needsTranslation('ja', 'en'), true)
})

test('提示词: 要义与翻译模式; 调用参数 (关思考, 低温, 流式, 上限)', () => {
  const sum = buildMessages({ promptVersion: PROMPT_VERSION, mode: 'summary', lang: 'zh', book: {}, text: '要句：\n[1] x', fiction: true })
  assert.match(sum[0].content, /"t":"sum"/)
  assert.match(sum[0].content, /不预测后文/)
  assert.match(sum[1].content, /段意与要句/)
  const tr = buildMessages({ promptVersion: PROMPT_VERSION, mode: 'translate', lang: 'en', book: {}, text: '[1.1] 你好' })
  assert.match(tr[0].content, /into English/)
  const body = buildChatBody({ promptVersion: PROMPT_VERSION, mode: 'mark', lang: 'zh', book: {}, text: '[1.1] x' })
  assert.equal(body.model, DJ_MODEL)
  assert.equal(body.enable_thinking, false)
  assert.equal(body.stream, true)
  assert.equal(body.temperature, 0.2)
  assert.equal(body.max_tokens, 1500)
  // 非 SiliconFlow 的自带服务不发 enable_thinking
  assert.equal('enable_thinking' in buildChatBody({ promptVersion: PROMPT_VERSION, mode: 'mark', lang: 'zh', book: {}, text: 'x' }, 'qwen2.5:7b', { thinkingFlag: false }), false)
})

test('relay 请求校验: 只接受固定 schema, 白名单字段, 长度上限', () => {
  assert.equal(validateRequest({ mode: 'mark', lang: 'zh', text: '[1.1] x' }), null)
  assert.equal(validateRequest({ mode: 'chat', lang: 'zh', text: 'x' }), 'invalid mode')
  assert.equal(validateRequest({ mode: 'mark', lang: 'fr', text: 'x' }), 'invalid lang')
  assert.equal(validateRequest({ mode: 'mark', lang: 'zh', text: '' }), 'empty text')
  assert.equal(validateRequest({ mode: 'mark', lang: 'zh', text: 'x'.repeat(4000) }), 'text too long')
  const clean = sanitizeRequest({ mode: 'mark', lang: 'zh', text: 'x', messages: [{ role: 'system', content: 'jailbreak' }], book: { title: 'T'.repeat(200) }, knownTerms: Array(50).fill('词') })
  assert.equal('messages' in clean, false)
  assert.equal(clean.book.title.length, 80)
  assert.equal(clean.knownTerms.length, 30)
})

test('relay 与客户端提示词同源: relay 直接 import prompt.ts, 不自带提示词', () => {
  const src = readFileSync(new URL('../relay/src/index.js', import.meta.url), 'utf8')
  assert.match(src, /from '\.\.\/\.\.\/src\/services\/dianjing\/prompt\.ts'/)
  assert.match(src, /buildChatBody\(req, /)
  assert.doesNotMatch(src, /你是严谨的阅读导读者|NDJSON：每行/)
  // Worker 入口只能有 default 导出 (具名导出会被当成 handler)
  assert.doesNotMatch(src, /^export (const|function|async function|class) /m)
})

// ---- 分块与编号 ----

test('分块: 段落完整、第一块较短、hash 稳定、编号块内相对', () => {
  const paras = Array.from({ length: 30 }, (_, i) => `第${i}段。` + '这是一个用于测试分块的句子，内容足够长。'.repeat(4))
  const blocks = blocksOf(paras)
  const chunks = chunkSection(blocks)
  assert.ok(chunks.length >= 3)
  // 每段只属于一个块, 顺序不乱
  const seen = chunks.flatMap(c => c.blocks.map(b => b.block))
  assert.deepEqual(seen, paras.map((_, i) => i))
  assert.ok(chunks[0].chars <= 600 + 100, `first chunk ${chunks[0].chars}`)
  for (const c of chunks) assert.ok(c.chars <= 1500, `chunk ${c.index} ${c.chars}`)
  assert.equal(chunkSection(blocks)[1].hash, chunks[1].hash)
  assert.match(chunks[0].hash, /^[0-9a-f]{16}$/)
  assert.match(chunks[1].text, /^\[1\.1\] 第/)
  // 内容一字之差, hash 不同
  assert.notEqual(hashText('甲乙丙'), hashText('甲乙丁'))
})

test('分块: 单段超长按句切开, 编号映射回原段的句序号', () => {
  const long = Array.from({ length: 150 }, (_, i) => `第${i}句话写得比较长一些以便超出上限。`).join('')
  const blocks = [{ block: 0, sentences: ['开头。'] }, { block: 1, sentences: sentences(long) }]
  const chunks = chunkSection(blocks)
  assert.ok(chunks.length >= 2)
  // 找到包含第 1 段后半的块: 块内第一段的 1 号句应映射到原段中间
  const later = chunks.find(c => c.blocks[0].block === 1 && (c.blocks[0].offset ?? 0) > 0)
  assert.ok(later)
  const pos = resolveSentence(later, '1.1')
  assert.equal(pos.block, 1)
  assert.equal(pos.sentence, later.blocks[0].offset)
  assert.equal(resolveSentence(later, '9.9'), null)
  assert.equal(resolveSentence(later, 'x'), null)
})

test('编号映射与请求顺序', () => {
  const chunks = chunkSection(blocksOf(PARAS), { first: 50, target: 50, max: 80 })
  assert.equal(chunks.length, 3)
  assert.deepEqual(resolveSentence(chunks[1], '1.2'), { block: 1, sentence: 1 })
  assert.equal(chunkIndexForBlock(chunks, 2), 2)
  assert.deepEqual(requestOrder(10, 4, 2, 1), [4, 5, 6, 3])
  assert.deepEqual(requestOrder(3, 2, 2, 0), [2])
})

// ---- NDJSON ----

test('NDJSON: 任意切片流式解析, 容忍围栏 / 列表符 / 尾逗号, 坏行计数', () => {
  const stream = '```json\n{"t":"key","s":"1.1","r":3,"why":"核心定义"}\n- {"t":"term","s":"3.2","q":"机会成本","def":"放弃的东西"},\nnot json\n{"t":"gist","p":2,"text":"权衡"}'
  const p = new NdjsonParser()
  const out = []
  for (let i = 0; i < stream.length; i += 7) out.push(...p.feed(stream.slice(i, i + 7)))
  out.push(...p.flush())
  assert.deepEqual(out.map(o => o.t), ['key', 'term', 'gist'])
  assert.equal(p.good, 3)
  assert.equal(p.bad, 1)
})

test('SSE 增量: 自带密钥直连时抽出 delta.content', () => {
  const sse = new SseDeltaParser()
  const ev = c => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n`
  let text = ''
  const raw = ev('{"t":"key",') + ev('"s":"1.1"}\n') + ': ping\n' + 'data: [DONE]\n'
  for (let i = 0; i < raw.length; i += 5) text += sse.feed(raw.slice(i, i + 5))
  assert.equal(text, '{"t":"key","s":"1.1"}\n')
  assert.equal(sse.done, true)
})

test('relay SSE → NDJSON 转换: 只转发 JSON 对象行, 返回累计输出', async () => {
  const ev = c => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`
  const body = ev('```\n{"t":"key","s"') + ev(':"1.1"}\n{"t":"gi') + ev('st","p":1,"text":"x"}') + 'data: [DONE]\n\n'
  const enc = new TextEncoder()
  const readable = new ReadableStream({ start(c) { for (let i = 0; i < body.length; i += 9) c.enqueue(enc.encode(body.slice(i, i + 9))); c.close() } })
  const lines = []
  const output = await sseToNdjson(readable, s => lines.push(s))
  assert.deepEqual(lines, ['{"t":"key","s":"1.1"}\n', '{"t":"gist","p":1,"text":"x"}\n'])
  assert.match(output, /^```/)
})

// ---- 锚定 ----

test('术语锚定: 精确 → NFKC/全半角/空白折叠 → 编辑距离 1; 找不到返回 null', () => {
  const s = '经济学家用机会成本这个术语来指为了得到某种东西所必须放弃的东西。'
  assert.deepEqual(findTermSpan(s, '机会成本'), [5, 9])
  const en = 'The  Invisible Hand guides markets.'
  const span = findTermSpan(en, 'invisible hand')
  assert.equal(en.slice(...span), 'Invisible Hand')
  // 全角字母
  assert.equal(findTermSpan('使用ＡＰＩ接口', 'API').length, 2)
  // 4 字以上允许 1 处差异 (模型抄错一个字)
  const fuzzy = findTermSpan(s, '机会成木这个')
  assert.ok(fuzzy)
  assert.equal(s.slice(...fuzzy), '机会成本这个')
  assert.equal(findTermSpan(s, '边际效用'), null)
  assert.equal(findTermSpan(s, '成木'), null) // 短词不做模糊
})

test('条目校验: 编号不存在丢弃, 术语回退到同段其他句, 截断超长字段, id 稳定', () => {
  const chunks = chunkSection(blocksOf(PARAS), { first: 10000, target: 10000 })
  const c = chunks[0]
  const stats = { dropped: 0 }
  const key = resolveItem({ t: 'key', s: '3.2', r: 5, why: '定义机会成本'.repeat(20) }, c, stats)
  assert.equal(key.t, 'key')
  assert.equal(key.block, 2)
  assert.equal(key.sentence, 1)
  assert.equal(key.r, 3)
  assert.ok(key.why.length <= 60)
  assert.equal(resolveItem({ t: 'key', s: '3.2' }, c).id, key.id)
  // 术语写错句号: 在同段找到
  const term = resolveItem({ t: 'term', s: '3.1', q: '机会成本', def: '为得到某物放弃的东西' }, c, stats)
  assert.equal(term.sentence, 1)
  assert.equal(c.blocks[2].sentences[1].slice(term.start, term.end), '机会成本')
  assert.equal(resolveItem({ t: 'term', s: '3.1', q: '不存在的词', def: 'x' }, c, stats), null)
  assert.equal(resolveItem({ t: 'key', s: '9.1' }, c, stats), null)
  assert.equal(resolveItem({ t: 'term', s: '3.2', q: '机会成本' }, c, stats), null) // 没有释义
  assert.equal(resolveItem({ t: 'bogus', s: '1.1' }, c, stats), null)
  assert.equal(stats.dropped, 4)
  assert.deepEqual(resolveItem({ t: 'meta', fiction: true }, c), { t: 'meta', fiction: true })
  const gist = resolveItem({ t: 'gist', p: 2, text: '人们面临权衡' }, c)
  assert.equal(gist.block, 1)
  const note = resolveItem({ t: 'note', s: '2.2', q: '天下没有免费的午餐', text: '俗语', k: 'culture' }, c)
  assert.equal(note.t, 'note')
})

// ---- 密度 ----

test('密度: 一次生成三档可用, 重要度优先, 每段最多 2 句, 至少 1 句', () => {
  const mk = (id, block, sentence, r) => ({ t: 'key', id, block, sentence, r, why: '' })
  const keys = [mk('a', 0, 0, 1), mk('b', 0, 1, 3), mk('c', 0, 2, 2), mk('d', 1, 0, 2), mk('e', 2, 0, 3), mk('f', 2, 1, 1)]
  const len = () => 40
  const low = selectKeys(keys, len, 1000, 'low') // 预算 50 字 → 1 句
  const normal = selectKeys(keys, len, 1000, 'normal') // 80 → 2 句
  const high = selectKeys(keys, len, 1000, 'high') // 150 → 3 句
  assert.deepEqual([...low], ['b'])
  assert.deepEqual([...normal], ['b', 'e'])
  assert.deepEqual([...high], ['b', 'e', 'c'])
  // 每段最多 2 句
  const many = selectKeys(keys, len, 100000, 'high')
  assert.equal([...many].filter(id => ['a', 'b', 'c'].includes(id)).length, 2)
  // 预算再小也至少保留 1 句
  assert.equal(selectKeys(keys, () => 500, 100, 'low').size, 1)
  const terms = [{ r: 1 }, { r: 2 }, { r: 3 }].map((x, i) => ({ t: 'term', id: String(i), ...x }))
  assert.equal(selectTerms(terms, 'low').length, 1)
  assert.equal(selectTerms(terms, 'normal').length, 2)
  assert.equal(selectTerms(terms, 'high').length, 3)
})

// ---- 缓存 ----

test('缓存键: 书 + 节 + 块 hash + 模型 + 提示词版本; 按书前缀列出与清除', async () => {
  const k = cacheKey('book1', 3, 'abcd', DJ_MODEL, PROMPT_VERSION)
  assert.equal(k, `book1:3:abcd:${DJ_MODEL}:${PROMPT_VERSION}`)
  assert.notEqual(k, cacheKey('book1', 3, 'abcd', 'other', PROMPT_VERSION))
  assert.equal(sectionKey('b', 2, 'dj1'), 'b:s2:dj1')
  assert.equal(feedbackKey('b', 'x:key:1.2'), 'b:x:key:1.2')
  const [a, z] = bookRange('book1')
  assert.ok(k >= a && k <= z)
  assert.ok(!(cacheKey('book10', 0, 'h', 'm', 'v') >= a && cacheKey('book10', 0, 'h', 'm', 'v') <= z), 'book10 不应落在 book1 的前缀区间')
  const c = createMemoryCache()
  await c.put('chunks', { key: k, v: 1 })
  await c.put('chunks', { key: cacheKey('book2', 0, 'h', 'm', 'v'), v: 2 })
  assert.equal((await c.listBook('chunks', 'book1')).length, 1)
  await c.clearBook('book1')
  assert.equal(await c.get('chunks', k), undefined)
  assert.equal((await c.listBook('chunks', 'book2')).length, 1)
})

// ---- 体裁 ----

test('体裁识别: 元数据 > 正文启发式 > 模型; 用户设置优先', () => {
  assert.equal(fictionFromMeta({ subjects: ['Fiction', 'Science fiction'] }), 'fiction')
  assert.equal(fictionFromMeta({ subjects: ['Economics', 'History'] }), 'nonfiction')
  assert.equal(fictionFromMeta({ tags: ['武侠小说'] }), 'fiction')
  assert.equal(fictionFromMeta({ subjects: ['Nonfiction'] }), 'nonfiction')
  assert.equal(fictionFromMeta({}), 'unknown')
  const novel = '“你来了？”她笑道。他点点头，忽然看见窗外有人影一闪。“是谁？”他喊道。只见那人翻身上墙，便不见了。她叹道：“又是他。”他说：“我去追。”'.repeat(4)
  const essay = '经济学研究稀缺资源的配置。首先，我们定义机会成本的概念。其次，理论表明，理性人考虑边际量。因此，研究需要数据。例如，价格反映了供求关系。总之，市场是组织经济活动的好方法。'.repeat(4)
  assert.equal(fictionFromText(novel), 'fiction')
  assert.equal(fictionFromText(essay), 'nonfiction')
  assert.deepEqual(decideFiction({ override: 'nonfiction', meta: 'fiction' }), { fiction: false, source: 'user' })
  assert.deepEqual(decideFiction({ meta: 'fiction', text: 'nonfiction' }), { fiction: true, source: 'meta' })
  assert.deepEqual(decideFiction({ meta: 'unknown', text: 'unknown', model: true }), { fiction: true, source: 'model' })
  assert.deepEqual(decideFiction({}), { fiction: false, source: 'default' })
})

// ---- 额度与成本 ----

test('额度换算: 字数计费只算正文, token 估算, 成本单位, 每日预算', () => {
  assert.equal(chargeChars('[1.1] 你好。 [1.2] 世界。\n[2.1] abc'), 9)
  assert.equal(estimateTokens('你好'), 2) // 2 × 0.6 → 1.2 → 向上取整
  assert.equal(estimateTokens('a'.repeat(10)), 3)
  // 1000 字中文块: 输入约 (1000 + 提示词 700) 字 → ~1020 token; 输出 ~400 字 → 240 token
  const units = costUnits(estimateTokens('中'.repeat(1700)), estimateTokens('中'.repeat(400)))
  assert.equal(units, Math.ceil((1020 * 3 + 240 * 9) / 100))
  // 20 万字的书 (200 块) 约 ¥1 量级 (保守估算, 不计缓存命中)
  const book = (units * 200) / CNY_TO_UNITS
  assert.ok(book > 0.5 && book < 2, `book cost ¥${book}`)
  assert.equal(DEVICE_DAILY_CHARS, 100_000)
  assert.equal(DAILY_BUDGET_CNY, 50)
})

test('relay 工具: 计数日按北京时间, 内存限流窗口', () => {
  assert.equal(quotaDay(Date.UTC(2026, 9, 4, 16, 30)), '2026-10-05') // UTC 16:30 = 北京 0:30
  assert.equal(quotaDay(Date.UTC(2026, 9, 4, 15, 30)), '2026-10-04')
  const now = 1_000_000
  for (let i = 0; i < 3; i++) assert.equal(rateLimited('test-key', 3, now + i), false)
  assert.equal(rateLimited('test-key', 3, now + 10), true)
  assert.equal(rateLimited('test-key', 3, now + 61_000), false)
  assert.equal(CHAT_MODEL, 'deepseek-ai/DeepSeek-V4-Flash')
  assert.ok(LEGACY_MODELS.has('glm-4.7-flash'))
})

// ---- 主题 ----

test('主题取值: 四种正文主题 + 墨水屏; 样式只用颜色与 text-decoration', () => {
  for (const name of ['light', 'sepia', 'green', 'dark']) {
    const css = dianjingCSS(name)
    assert.match(css, /::highlight\(lr-dj-key\)/)
    assert.match(css, new RegExp(djColors(name).key))
    assert.doesNotMatch(css, /font-weight|font-style/)
  }
  assert.equal(djColors('unknown').key, djColors('light').key)
  assert.equal(djThemeName('dark', true), 'eink-dark')
  assert.equal(djThemeName('sepia', true), 'eink')
  assert.match(dianjingCSS('eink'), /dotted #000000/)
  assert.doesNotMatch(dianjingCSS('eink'), /background-color: rgba/)
  // 优先级低于打字机隐藏层 (100) 与墨迹 (50)
  assert.ok(Math.max(...Object.values(DJ_PRIORITY)) < 20)
})

// ---- 两个版本: 基础 (按词分色, 不联网) / 智能 (AI) ----

const sw = (over = {}) => ({ level: 'basic', basicOn: false, perBook: {}, consentAll: false, enabled: false, ...over })
const isOnFor = (st, book) => dianjingOn({ level: st.level, basicOn: st.basicOn, smartOn: smartOnFor(st, book) })

test('版本: 未知值归为基础版; 同一时间至多一个版本生效', () => {
  assert.equal(normalizeLevel(undefined), 'basic')
  assert.equal(normalizeLevel('bionic'), 'basic')
  assert.equal(normalizeLevel('smart'), 'smart')
  assert.deepEqual(effectiveLevels({ level: 'basic', basicOn: true, smartOn: true }), { basic: true, smart: false })
  assert.deepEqual(effectiveLevels({ level: 'smart', basicOn: true, smartOn: true }), { basic: false, smart: true })
  assert.deepEqual(effectiveLevels({ level: 'smart', basicOn: true, smartOn: false }), { basic: false, smart: false })
  assert.equal(smartOnFor({ consentAll: true, enabled: true, perBook: { a: false } }, 'a'), false)
  assert.equal(smartOnFor({ consentAll: true, enabled: true, perBook: {} }, 'b'), true)
  assert.equal(smartOnFor({ consentAll: false, enabled: true, perBook: {} }, 'b'), false)
})

test('迁移 (v14): 在用按词着色 → 开着 + 基础版; 点睛对所有书开着 → 智能版; 两者都开 → 智能版; 新用户 → 关 + 基础版', () => {
  assert.deepEqual(migrateLevel({}), { level: 'basic', wordGuideEnabled: false })
  assert.deepEqual(migrateLevel({ readingMode: { wordGuide: { enabled: true } } }), { level: 'basic', wordGuideEnabled: true })
  assert.deepEqual(migrateLevel({ dianjing: { consentAll: true, enabled: true, perBook: {} } }), { level: 'smart', wordGuideEnabled: false })
  assert.deepEqual(
    migrateLevel({ dianjing: { consentAll: true, enabled: true }, readingMode: { wordGuide: { enabled: true } } }),
    { level: 'smart', wordGuideEnabled: false },
  )
  // 只给个别书开过点睛: 智能版 (那几本书照旧); 同时开着按词着色也是智能版 (两者都用 → 智能)
  assert.deepEqual(migrateLevel({ dianjing: { perBook: { a: true } } }), { level: 'smart', wordGuideEnabled: false })
  assert.deepEqual(migrateLevel({ dianjing: { perBook: { a: true } }, readingMode: { wordGuide: { enabled: true } } }), { level: 'smart', wordGuideEnabled: false })
  // 同意过但都关了: 仍是新用户的默认
  assert.deepEqual(migrateLevel({ dianjing: { consentAll: true, enabled: false, perBook: { a: false } } }), { level: 'basic', wordGuideEnabled: false })
  assert.deepEqual(migrateLevel({ dianjing: 'garbage' }), { level: 'basic', wordGuideEnabled: false })
})

test('总开关: 默认基础版一步打开、不需要同意; 再按一次关掉', () => {
  let r = applyDjAction(sw(), 'a', { kind: 'toggle' })
  assert.equal(r.needConsent, false)
  assert.equal(r.state.basicOn, true)
  assert.ok(isOnFor(r.state, 'a'))
  r = applyDjAction(r.state, 'a', { kind: 'toggle' })
  assert.equal(r.state.basicOn, false)
  assert.ok(!isOnFor(r.state, 'a'))
})

test('总开关: 上次选了智能版 → 按智能版开; 本书没同意过时先弹同意说明, 状态不变', () => {
  const s = sw({ level: 'smart' })
  let r = applyDjAction(s, 'a', { kind: 'toggle' })
  assert.equal(r.needConsent, true)
  assert.equal(r.state, s)
  r = applyDjAction(s, 'a', { kind: 'consent', scope: 'book' })
  assert.equal(r.state.level, 'smart')
  assert.equal(r.state.perBook.a, true)
  assert.ok(isOnFor(r.state, 'a'))
  assert.ok(!isOnFor(r.state, 'b'), '仅本书: 别的书不开')
  // 关掉后再开不用再同意
  r = applyDjAction(r.state, 'a', { kind: 'toggle' })
  assert.equal(r.state.perBook.a, false)
  r = applyDjAction(r.state, 'a', { kind: 'toggle' })
  assert.equal(r.needConsent, false)
  assert.ok(isOnFor(r.state, 'a'))
})

test('选版本: 开着时把「开」带到新版本; 关着时只记住选择', () => {
  // 基础开着 → 智能 (已同意): 基础关、智能开
  let r = applyDjAction(sw({ basicOn: true, perBook: { a: false } }), 'a', { kind: 'setLevel', level: 'smart' })
  assert.deepEqual([r.state.level, r.state.basicOn, r.state.perBook.a], ['smart', false, true])
  // 智能开着 → 基础: 智能本书关、基础开
  r = applyDjAction(r.state, 'a', { kind: 'setLevel', level: 'basic' })
  assert.deepEqual([r.state.level, r.state.basicOn, r.state.perBook.a], ['basic', true, false])
  assert.ok(isOnFor(r.state, 'a'))
  // 基础开着 → 智能 (没同意过): 先弹同意说明, 基础版继续开着
  const s = sw({ basicOn: true })
  r = applyDjAction(s, 'b', { kind: 'setLevel', level: 'smart' })
  assert.equal(r.needConsent, true)
  assert.equal(r.state.basicOn, true)
  assert.equal(r.state.level, 'basic')
  // 关着: 只改版本, 不打开
  r = applyDjAction(sw(), 'a', { kind: 'setLevel', level: 'smart' })
  assert.deepEqual([r.needConsent, r.state.level, isOnFor(r.state, 'a')], [false, 'smart', false])
})

test('先用基础版: 智能版用不了或不想联网时一步换成基础版并开着; 同意说明里点它不算同意', () => {
  let r = applyDjAction(sw({ level: 'smart', perBook: { a: true } }), 'a', { kind: 'switchToBasic' })
  assert.deepEqual([r.state.level, r.state.basicOn, r.state.perBook.a], ['basic', true, false])
  r = applyDjAction(sw({ level: 'smart' }), 'b', { kind: 'switchToBasic' })
  assert.deepEqual([r.state.level, r.state.basicOn], ['basic', true])
  assert.ok(!('b' in r.state.perBook), '没有记成已同意')
})

test('同意「所有书开启」: 智能版对其他书也开着; 在某本书换回基础版只影响这本书的智能版', () => {
  let r = applyDjAction(sw({ level: 'smart' }), 'a', { kind: 'consent', scope: 'all' })
  assert.ok(r.state.consentAll && r.state.enabled)
  assert.ok(isOnFor(r.state, 'b'))
  r = applyDjAction(r.state, 'a', { kind: 'setLevel', level: 'basic' })
  assert.ok(isOnFor(r.state, 'a') && r.state.level === 'basic')
  // 基础版是全局的: 其他书也是基础版开着
  assert.ok(isOnFor(r.state, 'b'))
  assert.deepEqual(effectiveLevels({ level: r.state.level, basicOn: r.state.basicOn, smartOn: smartOnFor(r.state, 'b') }), { basic: true, smart: false })
})

// ---- 重点词 (dj2) ----

test('重点词: 提示词版本升到 dj2 (旧版 dj1 的缓存仍可用于要句); 只有 keywords 时才加 kw 行要求', () => {
  assert.equal(PROMPT_VERSION, 'dj2')
  assert.deepEqual([...LEGACY_PROMPT_VERSIONS], ['dj1'])
  const base = { promptVersion: PROMPT_VERSION, mode: 'mark', book: {}, text: '[1.1] 阿Q走进未庄。' }
  assert.doesNotMatch(buildMessages({ ...base, lang: 'zh' })[0].content, /"t":"kw"/)
  const zh = buildMessages({ ...base, lang: 'zh', keywords: true })[0].content
  assert.match(zh, /\{"t":"kw","q":"词","r":2\}/)
  assert.match(zh, /一字不差的 2–8 字词/)
  assert.match(zh, /全部行输出完后/)
  const en = buildMessages({ ...base, lang: 'en', keywords: true })[0].content
  assert.match(en, /"t":"kw"/)
  // relay: 只有 mark 模式且显式 true 才保留 (旧客户端不带, 输出不变, 不会触发旧客户端的坏行重试)
  assert.equal(sanitizeRequest({ mode: 'mark', lang: 'zh', text: 'x', keywords: true }).keywords, true)
  assert.equal(sanitizeRequest({ mode: 'mark', lang: 'zh', text: 'x', keywords: 'yes' }).keywords, false)
  assert.equal(sanitizeRequest({ mode: 'summary', lang: 'zh', text: 'x', keywords: true }).keywords, false)
  assert.equal(sanitizeRequest({ mode: 'mark', lang: 'zh', text: 'x' }).keywords, false)
  // 输出上限: 每块 ≤ 1500 字, 加上重点词 (约每百字 1 个) 仍远低于 max_tokens
  assert.ok(MAX_TOKENS >= 1200)
  assert.equal(buildChatBody({ ...base, lang: 'zh', keywords: true }).max_tokens, MAX_TOKENS)
})

test('重点词: 只对中文正文请求; 解析时在整块里定位, 找不到计数但不算坏行; 可用性判定', () => {
  assert.equal(wantsKeyWords('zh-CN', '[1.1] 阿Q走进未庄，看见赵太爷在门口，心里很不平。人们都笑了起来，说他又在胡闹。'), true)
  assert.equal(wantsKeyWords('', '[1.1] 阿Q走进未庄，看见赵太爷在门口，心里很不平。人们都笑了起来，说他又在胡闹。'), true)
  assert.equal(wantsKeyWords('en', '[1.1] The quick brown fox jumps over the lazy dog. It was a bright cold day in April.'), false)
  assert.equal(wantsKeyWords('ja', '[1.1] 吾輩は猫である。名前はまだ無い。どこで生れたかとんと見当がつかぬ。'), false)
  const c = chunkSection(blocksOf(PARAS), { first: 10000, target: 10000 })[0]
  assert.ok(chunkPlainText(c).includes('机会成本'))
  const stats = { dropped: 0 }
  const kw = resolveItem({ t: 'kw', q: '机会成本', r: 3 }, c, stats)
  assert.deepEqual({ t: kw.t, q: kw.q, r: kw.r }, { t: 'kw', q: '机会成本', r: 3 })
  assert.equal(resolveItem({ t: 'kw', q: ' 机会 成本 ' }, c, stats)?.q, '机会成本')
  assert.equal(resolveItem({ t: 'kw', q: '《稀缺资源》', r: 9 }, c, stats)?.r, 3)
  assert.equal(resolveItem({ t: 'kw', q: '精神胜利法' }, c, stats), null)
  assert.equal(resolveItem({ t: 'kw', q: 12 }, c, stats), null)
  assert.equal(stats.dropped, 0, '找不到的重点词不计入坏行')
  assert.equal(stats.kwLines, 5)
  assert.equal(stats.kwMissing, 2)
  assert.equal(resolveItem({ t: 'kw', q: '机会成本' }, c).id, kw.id, 'id 稳定 (去重用)')
  // 可用性: 没有 → 不可用 (模型没理会); 一半以上找不到 → 不可用; 多得离谱 (重复循环) → 不可用
  assert.equal(keyWordsUsable(0, 0, 1000), false)
  assert.equal(keyWordsUsable(8, 1, 1000), true)
  assert.equal(keyWordsUsable(3, 4, 1000), false)
  assert.equal(keyWordsUsable(2, 2, 1000), true)
  assert.equal(keyWordsUsable(60, 0, 1000), false)
  assert.equal(keyWordsUsable(40, 0, 1000), true)
})
