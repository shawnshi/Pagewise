// 音色目录契约: Kokoro 离线音色 (sid 0–102) 与 Edge 在线音色
// 运行: node --experimental-strip-types --test scripts/test-voice-catalog.mjs
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

import { KOKORO_VOICES, DEFAULT_KOKORO_SID, kokoroVoiceLabel } from '../src/services/kokoroVoices.ts'

// edgeTts.ts 引用 '../storage/types' (无扩展名, Node 无法直接解析), 这里替换成桩
const edgeUrl = new URL('../src/services/edgeTts.ts', import.meta.url).href
const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === edgeUrl && specifier === '../storage/types') {
      return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent('export const isTauri = () => false')}` }
    }
    return nextResolve(specifier, context)
  },
})
const { EDGE_VOICES, DEFAULT_EDGE_VOICE } = await import(edgeUrl)
hook.deregister()

test('Kokoro: 103 个音色, sid 0..102 唯一且按序', () => {
  assert.equal(KOKORO_VOICES.length, 103)
  assert.deepEqual(KOKORO_VOICES.map(v => v.sid), Array.from({ length: 103 }, (_, i) => i))
  assert.equal(new Set(KOKORO_VOICES.map(v => v.name)).size, 103)
})

test('Kokoro: 名称前缀与性别/语言一致, 分段与 sherpa 文档一致', () => {
  for (const v of KOKORO_VOICES) {
    assert.match(v.name, /^(af|bf|zf|zm)_[a-z0-9]+$/)
    assert.equal(v.gender, v.name[1] === 'm' ? 'male' : 'female', v.name)
    assert.equal(v.lang, v.name[0] === 'z' ? 'zh' : 'en', v.name)
  }
  const count = prefix => KOKORO_VOICES.filter(v => v.name.startsWith(prefix)).length
  assert.deepEqual([count('af'), count('bf'), count('zf'), count('zm')], [2, 1, 55, 45])
  assert.equal(KOKORO_VOICES[0].name, 'af_maple')
  assert.equal(KOKORO_VOICES[3].name, 'zf_001')
  assert.equal(KOKORO_VOICES[57].name, 'zf_099')
  assert.equal(KOKORO_VOICES[58].name, 'zm_009')
  assert.equal(KOKORO_VOICES[102].name, 'zm_100')
})

test('Kokoro: 默认音色是中文音色', () => {
  const v = KOKORO_VOICES[DEFAULT_KOKORO_SID]
  assert.equal(v.sid, DEFAULT_KOKORO_SID)
  assert.equal(v.lang, 'zh')
  assert.equal(v.name, 'zf_086')
})

test('Kokoro: 标签非空, 推荐只给中文音色', () => {
  for (const v of KOKORO_VOICES) {
    for (const lang of ['zh', 'en']) {
      const label = kokoroVoiceLabel(v, lang)
      assert.ok(label.trim().length > 0)
      assert.ok(label.includes(v.name), label)
    }
    if (v.recommended) assert.equal(v.lang, 'zh', v.name)
  }
  assert.equal(kokoroVoiceLabel(KOKORO_VOICES[3], 'zh'), '中文女声 · zf_001 · 推荐')
  assert.equal(kokoroVoiceLabel(KOKORO_VOICES[3], 'en'), 'Chinese female · zf_001 · recommended')
  assert.equal(kokoroVoiceLabel(KOKORO_VOICES[DEFAULT_KOKORO_SID], 'zh'), '中文女声 · zf_086')
  assert.equal(kokoroVoiceLabel(KOKORO_VOICES[2], 'en'), 'British English female · bf_vale')
})

// 改动前的音色列表: 用户设置里可能存了这些 id, 不能删
const LEGACY_EDGE_IDS = [
  'zh-CN-XiaoxiaoNeural', 'zh-CN-YunxiNeural', 'zh-CN-YunjianNeural', 'zh-CN-XiaoyiNeural',
  'zh-CN-YunyangNeural', 'zh-CN-YunxiaNeural', 'zh-CN-liaoning-XiaobeiNeural', 'zh-CN-shaanxi-XiaoniNeural',
  'zh-TW-HsiaoChenNeural', 'zh-HK-HiuMaanNeural', 'en-US-AriaNeural', 'en-US-AndrewNeural', 'ja-JP-NanamiNeural',
]

test('Edge: id 唯一, 默认音色存在, 旧 id 全部保留', () => {
  const ids = EDGE_VOICES.map(v => v.id)
  assert.equal(new Set(ids).size, ids.length)
  assert.equal(DEFAULT_EDGE_VOICE, 'zh-TW-HsiaoChenNeural')
  assert.ok(ids.includes(DEFAULT_EDGE_VOICE))
  for (const id of LEGACY_EDGE_IDS) assert.ok(ids.includes(id), `missing legacy voice ${id}`)
})

test('Edge: 字段合法, 中文音色在前', () => {
  for (const v of EDGE_VOICES) {
    assert.match(v.id, /^[a-z]{2}-[A-Z]{2}(-[a-z]+)?-[A-Za-z]+Neural$/)
    assert.ok(v.label.trim().length > 0, v.id)
    if (v.gender) assert.ok(['female', 'male'].includes(v.gender), v.id)
    if (v.group) assert.ok(['mandarin', 'dialect', 'foreign'].includes(v.group), v.id)
    assert.equal(v.group === 'foreign', !v.id.startsWith('zh-'), v.id)
  }
  const firstForeign = EDGE_VOICES.findIndex(v => !v.id.startsWith('zh-'))
  assert.ok(EDGE_VOICES.slice(firstForeign).every(v => !v.id.startsWith('zh-')))
  assert.ok(EDGE_VOICES.find(v => v.id === DEFAULT_EDGE_VOICE).recommended)
})
