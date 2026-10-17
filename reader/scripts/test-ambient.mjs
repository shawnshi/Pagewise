// 背景音的纯函数契约: 噪声滤波器 / 稳定性 / 电平, 场景定义, 定时与淡出, 清单校验, 格式选择, 交叉淡化循环排程
// node --experimental-strip-types --test scripts/test-ambient.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { ambientDsp } from '../src/services/ambient/dsp.ts'
import { workletSource } from '../src/services/ambient/worklet.ts'
import {
  DEFAULT_DUCK_LEVEL,
  MASTER_MAX_GAIN,
  TIMER_FADE_MS,
  dbToGain,
  effectiveCrossfade,
  equalPowerCurve,
  formatBytes,
  gainToDb,
  loopSegments,
  minutesLeft,
  nextDrift,
  sliderToGain,
  timerGainAt,
  timerPlan,
} from '../src/services/ambient/math.ts'
import { SCENES, findScene, layerKey, layerParams, layerVolume, sceneItems } from '../src/services/ambient/scenes.ts'
import { ALLOWED_LICENSES, itemsBytes, pickFormat, resolveFileUrl, validateManifest } from '../src/services/ambient/pack.ts'
import { BUILTIN_MANIFEST } from '../src/services/ambient/manifest.ts'
import zh from '../src/i18n/zh.ts'
import en from '../src/i18n/en.ts'

const D = ambientDsp()
const FS = 48000
const rms = a => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length)
const db = x => 20 * Math.log10(x)

/** 复数频响 |H(e^jw)| (dB) */
function kelletDb(f, fs) {
  const w = (2 * Math.PI * f) / fs
  let re = D.KELLET.direct + D.KELLET.delayed * Math.cos(-w)
  let im = D.KELLET.delayed * Math.sin(-w)
  for (let i = 0; i < D.KELLET.poles.length; i++) {
    // g / (1 - p e^{-jw})
    const p = D.KELLET.poles[i]
    const dr = 1 - p * Math.cos(w)
    const di = p * Math.sin(w)
    const den = dr * dr + di * di
    re += (D.KELLET.gains[i] * dr) / den
    im += (-D.KELLET.gains[i] * di) / den
  }
  return 10 * Math.log10(re * re + im * im)
}

function biquadDb(c, f, fs) {
  const w = (2 * Math.PI * f) / fs
  const z = k => [Math.cos(-k * w), Math.sin(-k * w)]
  const [c1, s1] = z(1)
  const [c2, s2] = z(2)
  const nr = c.b0 + c.b1 * c1 + c.b2 * c2
  const ni = c.b1 * s1 + c.b2 * s2
  const dr = 1 + c.a1 * c1 + c.a2 * c2
  const di = c.a1 * s1 + c.a2 * s2
  return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di))
}

function renderSeconds(kind, seconds, params = {}, seed = 3) {
  const g = D.makeGenerator(kind, FS, seed, params)
  const n = Math.round(FS * seconds)
  const L = new Float32Array(n)
  const R = new Float32Array(n)
  for (let i = 0; i < n; i += 128) {
    const m = Math.min(128, n - i)
    g.render(L.subarray(i, i + m), R.subarray(i, i + m), m)
  }
  return { L, R }
}

// ---- DSP ----

test('DSP 工厂自包含: 源码可以脱离模块作用域执行 (AudioWorklet / Blob 的前提)', () => {
  const fresh = new Function(`return (${ambientDsp.toString()})()`)()
  const g = fresh.makeGenerator('rain', FS, 1, {})
  const L = new Float32Array(128)
  const R = new Float32Array(128)
  g.render(L, R, 128)
  assert.ok(L.some(x => x !== 0))
  const src = workletSource()
  assert.match(src, /registerProcessor\('lightread-ambient'/)
  assert.match(src, /extends AudioWorkletProcessor/)
  // 不能有 ES 模块语法 (Blob 模块里没有可解析的相对 import)
  assert.doesNotMatch(src, /^\s*import\s/m)
})

test('Worklet 源码在假的 AudioWorkletGlobalScope 里能注册并输出声音', () => {
  let Registered = null
  class FakeProcessor { constructor() { this.port = { onmessage: null } } }
  const scope = new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', workletSource())
  scope(FakeProcessor, (name, cls) => { Registered = { name, cls } }, FS)
  assert.equal(Registered.name, 'lightread-ambient')
  const p = new Registered.cls({ processorOptions: { kind: 'noise', seed: 9, params: { color: 'brown' } } })
  const out = [[new Float32Array(128), new Float32Array(128)]]
  assert.equal(p.process([], out), true)
  assert.ok(out[0][0].some(x => x !== 0))
  // 单声道输出也不出错
  const mono = [[new Float32Array(128)]]
  p.process([], mono)
  p.port.onmessage({ data: { type: 'stop' } })
  assert.equal(p.process([], out), false)
})

test('mulberry32 确定且分布在 [0,1)', () => {
  const a = D.mulberry32(42)
  const b = D.mulberry32(42)
  let sum = 0
  for (let i = 0; i < 10000; i++) {
    const x = a()
    assert.equal(x, b())
    assert.ok(x >= 0 && x < 1)
    sum += x
  }
  assert.ok(Math.abs(sum / 10000 - 0.5) < 0.02)
})

test('Kellet 粉噪滤波器: 极点在单位圆内, 100 Hz–10 kHz 斜率约 -3 dB/oct', () => {
  for (const p of D.KELLET.poles) assert.ok(Math.abs(p) < 1, `pole ${p}`)
  for (const fs of [44100, 48000]) {
    const ref = kelletDb(100, fs)
    for (let f = 200; f <= 10000; f *= 2) {
      const oct = Math.log2(f / 100)
      const dev = kelletDb(f, fs) - ref + 3.0103 * oct
      assert.ok(Math.abs(dev) < 0.6, `${fs} Hz 采样, ${f} Hz 偏离理想 1/f ${dev.toFixed(2)} dB`)
    }
  }
})

test('棕噪积分器有界 (泄漏), 白 / 粉 / 棕长时 RMS 归一到 -24 dBFS 附近', () => {
  assert.ok(D.BROWN_LEAK > 0)
  for (const color of ['white', 'pink', 'brown']) {
    const src = D.makeNoiseSource(color, D.mulberry32(5))
    const xs = new Float32Array(FS * 20)
    let peak = 0
    for (let i = 0; i < xs.length; i++) {
      xs[i] = src()
      peak = Math.max(peak, Math.abs(xs[i]))
    }
    const level = db(rms(xs))
    assert.ok(level > -27 && level < -21, `${color} RMS ${level.toFixed(1)} dBFS`)
    assert.ok(db(peak) < -3, `${color} 峰值 ${db(peak).toFixed(1)} dBFS`)
  }
})

test('棕噪频谱比粉噪更暗: 低频能量占比更高', () => {
  const energyRatio = color => {
    const src = D.makeNoiseSource(color, D.mulberry32(11))
    // 一阶差分近似高通: 差分能量 / 原能量 越小越暗
    let prev = 0, e = 0, de = 0
    for (let i = 0; i < FS * 5; i++) {
      const x = src()
      e += x * x
      de += (x - prev) ** 2
      prev = x
    }
    return de / e
  }
  const w = energyRatio('white')
  const p = energyRatio('pink')
  const b = energyRatio('brown')
  assert.ok(w > p && p > b, `white ${w.toFixed(3)} > pink ${p.toFixed(3)} > brown ${b.toFixed(5)}`)
})

test('RBJ 双二阶: 各类型稳定 (|极点|<1), 通带 / 阻带符合预期', () => {
  for (const type of ['lowpass', 'highpass', 'bandpass']) {
    for (const f of [40, 200, 1000, 5000, 18000, 30000]) {
      for (const q of [0.05, 0.5, 0.707, 3, 8]) {
        const c = D.biquadCoeffs(type, f, q, FS)
        // 二阶稳定三角: |a2| < 1 且 |a1| < 1 + a2
        assert.ok(Math.abs(c.a2) < 1 && Math.abs(c.a1) < 1 + c.a2, `${type} ${f}Hz Q${q} 不稳定`)
        for (const k of ['b0', 'b1', 'b2', 'a1', 'a2']) assert.ok(Number.isFinite(c[k]))
      }
    }
  }
  const lp = D.biquadCoeffs('lowpass', 1000, 0.707, FS)
  assert.ok(Math.abs(biquadDb(lp, 50, FS)) < 0.1)
  assert.ok(biquadDb(lp, 10000, FS) < -35)
  const hp = D.biquadCoeffs('highpass', 1000, 0.707, FS)
  assert.ok(biquadDb(hp, 50, FS) < -45)
  const bp = D.biquadCoeffs('bandpass', 1000, 2, FS)
  assert.ok(Math.abs(biquadDb(bp, 1000, FS)) < 0.1)
  assert.ok(biquadDb(bp, 100, FS) < -20)
})

test('随机漫步: 始终在 [min, max] 内并且会移动', () => {
  const w = D.makeWander(D.mulberry32(3), 200, 900, 2, FS)
  let lo = Infinity, hi = -Infinity
  for (let i = 0; i < FS * 30; i += 64) {
    const v = w.advance(64)
    lo = Math.min(lo, v)
    hi = Math.max(hi, v)
  }
  assert.ok(lo >= 200 && hi <= 900)
  assert.ok(hi - lo > 100, `只移动了 ${hi - lo}`)
})

test('和弦漫步: 不原地停留, 和弦池全在 C 五声音阶内', () => {
  const rand = D.mulberry32(8)
  let cur = 0
  const seen = new Set()
  for (let i = 0; i < 500; i++) {
    const next = D.nextChordIndex(rand, cur, D.PAD_CHORDS.length)
    assert.notEqual(next, cur)
    assert.ok(next >= 0 && next < D.PAD_CHORDS.length)
    seen.add(next)
    cur = next
  }
  assert.equal(seen.size, D.PAD_CHORDS.length)
  const penta = new Set([0, 2, 4, 7, 9])
  for (const chord of [...D.PAD_CHORDS, D.CHIME_NOTES]) for (const m of chord) assert.ok(penta.has(m % 12), `MIDI ${m} 不在五声音阶`)
  // 风铃周期两两互质
  const gcd = (a, b) => (b ? gcd(b, a % b) : a)
  for (const a of D.CHIME_PERIODS) for (const b of D.CHIME_PERIODS) if (a !== b) assert.equal(gcd(a, b), 1)
  assert.ok(Math.abs(D.midiToHz(69) - 440) < 1e-9)
})

test('各发声器: 输出有限、不削波、电平落在约定范围; 左右声道不完全相同', () => {
  const expect = { noise: [-28, -21], rain: [-28, -20], wind: [-30, -19], pad: [-32, -22], chimes: [-45, -28] }
  for (const [kind, [lo, hi]] of Object.entries(expect)) {
    const { L, R } = renderSeconds(kind, 40)
    let peak = 0
    let diff = 0
    for (let i = 0; i < L.length; i++) {
      assert.ok(Number.isFinite(L[i]) && Number.isFinite(R[i]), `${kind} 出现 NaN`)
      peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]))
      diff += Math.abs(L[i] - R[i])
    }
    const level = db(rms(L))
    assert.ok(level > lo && level < hi, `${kind} RMS ${level.toFixed(1)} dBFS`)
    assert.ok(db(peak) < -6, `${kind} 峰值 ${db(peak).toFixed(1)} dBFS`)
    assert.ok(diff > 0, `${kind} 是单声道`)
  }
})

test('set() 可以在播放中换噪声颜色与强度', () => {
  const g = D.makeGenerator('noise', FS, 2, { color: 'white' })
  const L = new Float32Array(FS)
  const R = new Float32Array(FS)
  g.render(L, R, FS)
  const white = rms(L)
  g.set({ color: 'brown' })
  g.render(L, R, FS)
  assert.ok(Number.isFinite(rms(L)) && rms(L) !== white)
  const rain = D.makeGenerator('rain', FS, 2, { intensity: 0.1 })
  rain.set({ intensity: 2 }) // 越界会被夹住
  rain.render(L, R, FS)
  assert.ok(L.every(Number.isFinite))
})

// ---- 场景 ----

test('场景定义: 4 个合成场景 + 7 个录音场景, id 唯一, 名字中英都有', () => {
  const ids = SCENES.map(s => s.id)
  assert.equal(new Set(ids).size, ids.length)
  assert.deepEqual(SCENES.filter(s => s.source === 'synth').map(s => s.id), ['rain-study', 'forest-wind', 'focus-noise', 'nocturne-pad'])
  assert.equal(SCENES.filter(s => s.source === 'recorded').length, 7)
  assert.equal(zh['ambient.scene.rainStudy'], '雨夜书房')
  assert.equal(zh['ambient.scene.forestWind'], '林间风声')
  assert.equal(zh['ambient.scene.focusNoise'], '专注噪音')
  assert.equal(zh['ambient.scene.nocturnePad'], '夜曲铺底')
  for (const s of SCENES) {
    for (const key of [s.nameKey, s.descKey, ...s.layers.map(l => l.labelKey)]) {
      assert.ok(zh[key], `zh 缺 ${key}`)
      assert.ok(en[key], `en 缺 ${key}`)
    }
    assert.ok(s.layers.length > 0)
    const layerIds = s.layers.map(l => l.id)
    assert.equal(new Set(layerIds).size, layerIds.length, `${s.id} 层 id 重复`)
    for (const l of s.layers) assert.ok(l.volume >= 0 && l.volume <= 1)
    if (s.source === 'synth') assert.deepEqual(sceneItems(s), [], `${s.id} 合成场景不应依赖下载`)
    else assert.ok(sceneItems(s).length > 0)
  }
})

test('面板与引擎用到的 ambient.* 文案中英都有', () => {
  const vue = readFileSync(new URL('../src/components/AmbientPanel.vue', import.meta.url), 'utf8')
  const ctl = readFileSync(new URL('../src/services/ambient/index.ts', import.meta.url), 'utf8')
  const keys = new Set([...(vue + ctl).matchAll(/'(ambient\.[A-Za-z.]+)'/g)].map(m => m[1]))
  assert.ok(keys.size > 15)
  for (const k of keys) {
    assert.ok(zh[k], `zh 缺 ${k}`)
    assert.ok(en[k], `en 缺 ${k}`)
  }
})

test('录音场景引用的素材都在内置清单里, 场景字段对得上', () => {
  for (const s of SCENES.filter(x => x.source === 'recorded')) {
    for (const id of sceneItems(s)) {
      const item = BUILTIN_MANIFEST.items.find(i => i.id === id)
      assert.ok(item, `${s.id} 引用了不存在的素材 ${id}`)
      assert.equal(item.scene, s.id)
    }
  }
  const piano = findScene('piano-nocturne')
  assert.equal(piano.layers[0].type, 'playlist')
})

test('层音量: 用户值优先并夹到 0..1; 噪声颜色只作用到噪声层', () => {
  const scene = findScene('rain-study')
  const rain = scene.layers[0]
  assert.equal(layerVolume({}, scene.id, rain), rain.volume)
  assert.equal(layerVolume({ [layerKey(scene.id, 'rain')]: 0.2 }, scene.id, rain), 0.2)
  assert.equal(layerVolume({ [layerKey(scene.id, 'rain')]: 7 }, scene.id, rain), 1)
  assert.equal(layerVolume({ [layerKey(scene.id, 'rain')]: NaN }, scene.id, rain), rain.volume)
  const noise = findScene('focus-noise').layers[0]
  assert.equal(layerParams(noise, 'brown').color, 'brown')
  assert.equal(layerParams(rain, 'brown').color, undefined)
})

// ---- 音量 / 闪避 / 定时 ----

test('音量曲线单调, 0 静音, 默认 30% 约 -8 dB (相对素材基准)', () => {
  assert.equal(sliderToGain(0), 0)
  assert.equal(sliderToGain(-1), 0)
  assert.equal(sliderToGain(1, MASTER_MAX_GAIN), MASTER_MAX_GAIN)
  let prev = -1
  for (let v = 0; v <= 1.0001; v += 0.01) {
    const g = sliderToGain(v)
    assert.ok(g >= prev)
    prev = g
  }
  const g30 = gainToDb(sliderToGain(0.3, MASTER_MAX_GAIN))
  assert.ok(g30 > -9.5 && g30 < -6.5, `${g30}`)
  assert.ok(Math.abs(gainToDb(DEFAULT_DUCK_LEVEL) + 12) < 0.1, '听书时压低 -12 dB')
  assert.ok(Math.abs(dbToGain(gainToDb(0.5)) - 0.5) < 1e-12)
})

test('定时: 结束前 30 s 开始淡出, 剩余不足 30 s 时立即淡出; 淡出增益线性到 0', () => {
  const now = 1_000_000
  const end = now + 15 * 60_000
  assert.deepEqual(timerPlan(now, end), { fadeStartIn: 15 * 60_000 - TIMER_FADE_MS, fadeMs: TIMER_FADE_MS, stopIn: 15 * 60_000 })
  assert.deepEqual(timerPlan(now, now + 10_000), { fadeStartIn: 0, fadeMs: 10_000, stopIn: 10_000 })
  assert.deepEqual(timerPlan(now, now - 5), { fadeStartIn: 0, fadeMs: 0, stopIn: 0 })
  assert.equal(timerGainAt(now, end), 1)
  assert.equal(timerGainAt(end - 15_000, end), 0.5)
  assert.equal(timerGainAt(end, end), 0)
  assert.equal(timerGainAt(end + 1, end), 0)
  assert.equal(minutesLeft(now, null), null)
  assert.equal(minutesLeft(now, now + 61_000), 2)
  assert.equal(minutesLeft(now, now - 1), 0)
})

test('音量漂移: 在 ±1.5 dB 内, 间隔 20–60 s', () => {
  const rand = D.mulberry32(77)
  for (let i = 0; i < 1000; i++) {
    const d = nextDrift(rand)
    const g = gainToDb(d.gain)
    assert.ok(g >= -1.5 - 1e-9 && g <= 1.5 + 1e-9)
    assert.ok(d.afterSec >= 20 && d.afterSec <= 60)
  }
})

// ---- 交叉淡化循环 ----

test('循环排程: 段与段重叠一个交叉淡化时长, 首段不淡入, 周期 = D − X', () => {
  const segs = loopSegments(60, 2.5, 10, 0, 4)
  assert.equal(segs.length, 4)
  assert.equal(segs[0].start, 10)
  assert.equal(segs[0].fadeInEnd, 10)
  for (let k = 1; k < segs.length; k++) {
    const a = segs[k - 1]
    const b = segs[k]
    assert.equal(b.start - a.start, 57.5)
    assert.equal(b.start, a.fadeOutStart)
    assert.ok(Math.abs(a.end - (b.start + 2.5)) < 1e-9, '上一段在下一段淡入结束时结束')
    assert.equal(b.fadeInEnd, b.start + 2.5)
  }
  // 从中间续排与一次排出的结果一致
  assert.deepEqual(loopSegments(60, 2.5, 10, 2, 2), segs.slice(2))
  // 交叉淡化最长为时长的 1/3
  assert.equal(effectiveCrossfade(6, 3), 2)
  assert.equal(effectiveCrossfade(60, -1), 0)
  const short = loopSegments(6, 3, 0, 0, 3)
  assert.equal(short[1].start, 4)
})

test('等功率曲线: 端点正确, 淡入淡出功率和恒为 1', () => {
  const up = equalPowerCurve(64, true)
  const down = equalPowerCurve(64, false)
  assert.equal(up[0], 0)
  assert.ok(Math.abs(up[63] - 1) < 1e-6)
  assert.ok(Math.abs(down[0] - 1) < 1e-6)
  assert.ok(Math.abs(down[63]) < 1e-6)
  for (let i = 0; i < 64; i++) assert.ok(Math.abs(up[i] ** 2 + down[i] ** 2 - 1) < 1e-6)
  assert.equal(equalPowerCurve(1, true).length, 2)
})

// ---- 录音包清单 / 格式 ----

const goodItem = () => ({
  id: 'rain-window',
  scene: 'rain-window',
  kind: 'loop',
  title: 'Rain',
  author: 'someone',
  license: 'CC0-1.0',
  licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
  sourceUrl: 'https://freesound.org/x',
  durationSec: 60,
  loudness: { integratedLufs: -27, truePeakDb: -7 },
  files: {
    opus: { url: 'rain.ogg', bytes: 500000, sha256: 'a'.repeat(64) },
    m4a: { url: 'rain.m4a', bytes: 700000 },
  },
})
const goodManifest = () => ({ version: 1, baseUrl: 'https://example.com/ambient/v1/', items: [goodItem()] })

test('清单校验: 内置清单有效、许可只有 CC0, 总体积 ≤ 20 MB', () => {
  const r = validateManifest(BUILTIN_MANIFEST)
  assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'))
  assert.equal(BUILTIN_MANIFEST.baseUrl, 'https://lightread-assets.jiangshu.ai/ambient/v1/')
  for (const it of BUILTIN_MANIFEST.items) {
    assert.equal(it.license, 'CC0-1.0')
    assert.ok(Math.abs(it.loudness.integratedLufs + 27) <= 2, `${it.id} 响度 ${it.loudness.integratedLufs}`)
    assert.ok(it.loudness.truePeakDb <= -6, `${it.id} 真峰值 ${it.loudness.truePeakDb}`)
    if (it.kind === 'loop') assert.ok(it.durationSec >= 45 && it.durationSec <= 90)
    assert.match(it.files.opus.url, /\.[0-9a-f]{8}\.ogg$/)
    assert.match(it.files.m4a.url, /\.[0-9a-f]{8}\.m4a$/)
  }
  const total = itemsBytes(BUILTIN_MANIFEST.items, 'opus') + itemsBytes(BUILTIN_MANIFEST.items, 'm4a')
  assert.ok(total <= 20_000_000, `总体积 ${total}`)
})

test('清单校验: 拒绝 NC / 未知许可、缺字段、重复 id、超长循环、非 https', () => {
  assert.ok(validateManifest(goodManifest()).ok)
  assert.ok(!validateManifest(null).ok)
  assert.ok(!validateManifest({ ...goodManifest(), version: 2 }).ok)
  assert.ok(!validateManifest({ ...goodManifest(), baseUrl: 'http://example.com/a/' }).ok)
  assert.ok(!validateManifest({ ...goodManifest(), baseUrl: 'https://example.com/a' }).ok)
  assert.ok(!validateManifest({ ...goodManifest(), items: [] }).ok)
  for (const license of ['CC-BY-NC-4.0', 'Pixabay', 'CC-BY-SA-4.0', '']) {
    const m = goodManifest()
    m.items[0].license = license
    assert.ok(!validateManifest(m).ok, license)
  }
  assert.ok(ALLOWED_LICENSES.includes('CC0-1.0'))
  const dup = goodManifest()
  dup.items.push(goodItem())
  const r = validateManifest(dup)
  assert.ok(!r.ok && r.errors.some(e => e.includes('重复')))
  const long = goodManifest()
  long.items[0].durationSec = 300
  assert.ok(!validateManifest(long).ok)
  const track = goodManifest()
  track.items[0].kind = 'track'
  track.items[0].durationSec = 300
  assert.ok(validateManifest(track).ok, '曲目不受循环时长限制')
  const noFile = goodManifest()
  delete noFile.items[0].files.m4a
  assert.ok(!validateManifest(noFile).ok)
  const badHash = goodManifest()
  badHash.items[0].files.opus.sha256 = 'xyz'
  assert.ok(!validateManifest(badHash).ok)
  const loud = goodManifest()
  loud.items[0].loudness.truePeakDb = 0
  assert.ok(!validateManifest(loud).ok)
})

test('格式选择: 支持 Ogg Opus 用 Opus, 否则 / 解码失败过用 m4a', () => {
  const chrome = m => (m.includes('opus') ? 'probably' : 'maybe')
  const oldSafari = m => (m.includes('ogg') ? '' : 'maybe')
  const firefoxMaybe = m => (m.includes('opus') ? 'maybe' : '')
  assert.equal(pickFormat(chrome), 'opus')
  assert.equal(pickFormat(firefoxMaybe), 'opus')
  assert.equal(pickFormat(oldSafari), 'm4a')
  assert.equal(pickFormat(() => ''), 'm4a')
  assert.equal(pickFormat(chrome, new Set(['opus'])), 'm4a')
})

test('文件 URL 解析与体积文案', () => {
  const m = { baseUrl: 'https://cdn.example/ambient/v1/' }
  assert.equal(resolveFileUrl(m, { url: 'rain.ab12cd34.ogg', bytes: 1 }), 'https://cdn.example/ambient/v1/rain.ab12cd34.ogg')
  assert.equal(resolveFileUrl(m, { url: '/rain.ogg', bytes: 1 }), 'https://cdn.example/ambient/v1/rain.ogg')
  assert.equal(resolveFileUrl(m, { url: 'https://other/x.ogg', bytes: 1 }), 'https://other/x.ogg')
  assert.equal(formatBytes(537107), '537 KB')
  assert.equal(formatBytes(8_954_428), '9.0 MB')
  assert.equal(formatBytes(0), '0 KB')
})
