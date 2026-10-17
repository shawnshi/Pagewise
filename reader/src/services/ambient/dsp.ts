/**
 * 背景音的实时合成内核 (docs/research/reading-ambient-audio.md §4)。
 *
 * 整个内核是一个**自包含**的工厂函数 `ambientDsp()`: 函数体内不引用任何外部标识符,
 * 这样同一份代码可以:
 *   1. 经 `ambientDsp.toString()` 拼进 AudioWorklet 模块 (Blob URL, 见 worklet.ts) 在音频线程运行;
 *   2. 在没有 AudioWorklet 的旧 WebView 里由 ScriptProcessor 回退在主线程直接调用;
 *   3. 在 node 单测里直接调用 (scripts/test-ambient.mjs)。
 * 约束: 函数体内只写普通函数 / 闭包 / 对象字面量, 不写 class 字段、`**`、可选链等可能被构建工具
 * 降级成外部 helper 的语法 (DjVu.js 的 Worker 也是这样拼源码的)。单测会用 `new Function` 校验自包含。
 *
 * 发声器 (Generator) 统一接口: render(L, R, n) 向左右声道写 n 个采样 (覆盖写), set(params) 调参。
 * 输出电平约定: 长时 RMS ≈ -24 dBFS, 峰值 < -6 dBFS; 录音素材统一为 -27 LUFS, 两者听感接近。
 */

export type SynthKind = 'noise' | 'rain' | 'wind' | 'pad' | 'chimes'
export type NoiseColor = 'white' | 'pink' | 'brown'

export interface SynthParams {
  /** 噪声颜色 (noise) */
  color?: NoiseColor
  /** 强度 0..1 (雨势 / 风势), 默认 0.6 */
  intensity?: number
  /** 明暗 0..1 (noise 的低通上限), 默认 0.6 */
  brightness?: number
}

export interface Generator {
  render(L: Float32Array, R: Float32Array, n: number): void
  set(params: SynthParams): void
}

export interface BiquadCoeffs {
  b0: number
  b1: number
  b2: number
  a1: number
  a2: number
}

export interface AmbientDsp {
  mulberry32(seed: number): () => number
  /** Paul Kellet 精化版粉噪声滤波器: 6 个一阶低通的加权和 + 直通 + 一拍延迟项 (44.1 kHz 设计) */
  KELLET: { poles: number[]; gains: number[]; direct: number; delayed: number }
  /** 棕噪声带泄漏积分器: y = (y + k·w) / (1 + k) */
  BROWN_LEAK: number
  /** 各颜色噪声的输出增益 (把长时 RMS 归一到约 -24 dBFS) */
  NOISE_GAIN: { white: number; pink: number; brown: number }
  /** RBJ Audio EQ Cookbook 双二阶系数 (已按 a0 归一) */
  biquadCoeffs(type: 'lowpass' | 'highpass' | 'bandpass', freq: number, q: number, fs: number): BiquadCoeffs
  /** 平滑随机漫步: 每隔 period×(0.5–1.5) 秒换一个目标, 一阶平滑逼近 */
  makeWander(rand: () => number, min: number, max: number, periodSec: number, fs: number): { advance(n: number): number; value(): number }
  makeNoiseSource(color: NoiseColor, rand: () => number): () => number
  /** 和弦池 (C 大调五声音阶内, MIDI 音高); 任意两个和弦相接都协和 */
  PAD_CHORDS: number[][]
  CHIME_NOTES: number[]
  /** 互质的风铃循环周期 (秒), Eno《Music for Airports》式, 组合几乎不重复 */
  CHIME_PERIODS: number[]
  nextChordIndex(rand: () => number, current: number, size: number): number
  midiToHz(m: number): number
  makeGenerator(kind: SynthKind, fs: number, seed: number, params: SynthParams): Generator
}

export function ambientDsp(): AmbientDsp {
  function mulberry32(seed: number): () => number {
    let a = seed >>> 0
    return function () {
      a = (a + 0x6d2b79f5) >>> 0
      let t = a
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  const KELLET = {
    poles: [0.99886, 0.99332, 0.969, 0.8665, 0.55, -0.7616],
    gains: [0.0555179, 0.0750759, 0.153852, 0.3104856, 0.5329522, -0.016898],
    direct: 0.5362,
    delayed: 0.115926,
  }
  const BROWN_LEAK = 0.02
  const NOISE_GAIN = { white: 0.109, pink: 0.0358, brown: 1.09 }

  function clamp(v: number, lo: number, hi: number): number {
    return v < lo ? lo : v > hi ? hi : v
  }

  function biquadCoeffs(type: 'lowpass' | 'highpass' | 'bandpass', freq: number, q: number, fs: number): BiquadCoeffs {
    const f = clamp(freq, 10, fs * 0.45)
    const w0 = (2 * Math.PI * f) / fs
    const cos = Math.cos(w0)
    const alpha = Math.sin(w0) / (2 * Math.max(0.05, q))
    const a0 = 1 + alpha
    let b0: number
    let b1: number
    let b2: number
    if (type === 'lowpass') {
      b0 = (1 - cos) / 2
      b1 = 1 - cos
      b2 = (1 - cos) / 2
    } else if (type === 'highpass') {
      b0 = (1 + cos) / 2
      b1 = -(1 + cos)
      b2 = (1 + cos) / 2
    } else {
      // 带通 (0 dB 峰值增益)
      b0 = alpha
      b1 = 0
      b2 = -alpha
    }
    return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: (-2 * cos) / a0, a2: (1 - alpha) / a0 }
  }

  /** 直接 II 型转置双二阶滤波器, 系数可随时替换 (逐块调制) */
  function makeBiquad(c: BiquadCoeffs) {
    let z1 = 0
    let z2 = 0
    let k = c
    return {
      set(next: BiquadCoeffs) { k = next },
      process(x: number): number {
        const y = k.b0 * x + z1
        z1 = k.b1 * x - k.a1 * y + z2
        z2 = k.b2 * x - k.a2 * y
        return y
      },
    }
  }

  /** 一阶低通 (cutoff Hz) */
  function onePoleCoeff(cutoff: number, fs: number): number {
    return 1 - Math.exp((-2 * Math.PI * cutoff) / fs)
  }

  function makeWander(rand: () => number, min: number, max: number, periodSec: number, fs: number) {
    let cur = min + (max - min) * rand()
    let target = min + (max - min) * rand()
    let left = Math.round(periodSec * fs * (0.5 + rand()))
    const coef = onePoleCoeff(1 / Math.max(0.1, periodSec * 0.35 * 2 * Math.PI), fs)
    return {
      advance(n: number): number {
        left -= n
        if (left <= 0) {
          target = min + (max - min) * rand()
          left = Math.round(periodSec * fs * (0.5 + rand()))
        }
        // n 个采样的一阶平滑等效为 1-(1-c)^n
        const c = 1 - Math.pow(1 - coef, n)
        cur += (target - cur) * c
        return cur
      },
      value(): number { return cur },
    }
  }

  function makeNoiseSource(color: NoiseColor, rand: () => number): () => number {
    if (color === 'white') {
      return function () { return (rand() * 2 - 1) * NOISE_GAIN.white }
    }
    if (color === 'brown') {
      let y = 0
      return function () {
        y = (y + BROWN_LEAK * (rand() * 2 - 1)) / (1 + BROWN_LEAK)
        return y * NOISE_GAIN.brown
      }
    }
    const p = KELLET.poles
    const g = KELLET.gains
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0
    return function () {
      const w = rand() * 2 - 1
      b0 = p[0] * b0 + w * g[0]
      b1 = p[1] * b1 + w * g[1]
      b2 = p[2] * b2 + w * g[2]
      b3 = p[3] * b3 + w * g[3]
      b4 = p[4] * b4 + w * g[4]
      b5 = p[5] * b5 + w * g[5]
      const out = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * KELLET.direct
      b6 = w * KELLET.delayed
      return out * NOISE_GAIN.pink
    }
  }

  function midiToHz(m: number): number {
    return 440 * Math.pow(2, (m - 69) / 12)
  }

  // C D E G A: 五声音阶里任意组合都不会出现小二度 / 三全音
  const PAD_CHORDS = [
    [48, 55, 62, 64], // C G D E
    [45, 52, 60, 64], // A E C E
    [43, 50, 57, 62], // G D A D
    [50, 57, 60, 64], // D A C E
    [52, 55, 62, 67], // E G D G
    [45, 55, 60, 62], // A G C D
  ]
  const CHIME_NOTES = [72, 74, 76, 79, 81, 84]
  const CHIME_PERIODS = [17, 23, 29, 31, 37]

  function nextChordIndex(rand: () => number, current: number, size: number): number {
    if (size <= 1) return 0
    // 随机漫步: 优先相邻和弦 (±1), 偶尔跳 ±2, 不原地停留
    const r = rand()
    const step = r < 0.7 ? 1 : 2
    const dir = rand() < 0.5 ? -1 : 1
    let next = (current + dir * step) % size
    if (next < 0) next += size
    if (next === current) next = (current + 1) % size
    return next
  }

  /** 轻量 Freeverb: 4 梳状 + 2 全通 / 声道, 给 pad 和风铃一点空间感; 不需要 IR 文件 */
  function makeSpace(fs: number, feedback: number, damp: number) {
    const scale = fs / 44100
    const combL = [1116, 1188, 1277, 1356].map(n => Math.round(n * scale))
    const combR = combL.map(n => n + Math.round(23 * scale))
    const apL = [556, 441].map(n => Math.round(n * scale))
    const apR = apL.map(n => n + Math.round(23 * scale))
    function comb(len: number) {
      const buf = new Float32Array(len)
      let i = 0
      let store = 0
      return function (x: number): number {
        const y = buf[i]
        store = y * (1 - damp) + store * damp
        buf[i] = x + store * feedback
        i = i + 1 === len ? 0 : i + 1
        return y
      }
    }
    function allpass(len: number) {
      const buf = new Float32Array(len)
      let i = 0
      return function (x: number): number {
        const b = buf[i]
        const y = b - x
        buf[i] = x + b * 0.5
        i = i + 1 === len ? 0 : i + 1
        return y
      }
    }
    const cl = combL.map(comb)
    const cr = combR.map(comb)
    const al = apL.map(allpass)
    const ar = apR.map(allpass)
    return {
      /** 输入单声道, 输出 [L, R] 湿声 (写进 out) */
      process(x: number, out: number[]): void {
        const inp = x * 0.1
        let l = cl[0](inp) + cl[1](inp) + cl[2](inp) + cl[3](inp)
        let r = cr[0](inp) + cr[1](inp) + cr[2](inp) + cr[3](inp)
        l = al[1](al[0](l))
        r = ar[1](ar[0](r))
        out[0] = l
        out[1] = r
      },
    }
  }

  const BLOCK = 64

  function noiseGenerator(fs: number, rand: () => number, params: SynthParams): Generator {
    let color: NoiseColor = params.color || 'pink'
    let brightness = params.brightness == null ? 0.6 : params.brightness
    let srcL = makeNoiseSource(color, rand)
    let srcR = makeNoiseSource(color, rand)
    // 明暗: 一阶低通 1.2k–16k, 再叠一个缓慢漂移 (myNoise 的 Animate), 避免听觉疲劳
    const drift = makeWander(rand, -0.12, 0.12, 25, fs)
    let lpL = 0
    let lpR = 0
    let coef = 1
    function cutoffFor(b: number): number {
      return 1200 * Math.pow(16000 / 1200, clamp(b, 0, 1))
    }
    return {
      set(p: SynthParams) {
        if (p.color && p.color !== color) {
          color = p.color
          srcL = makeNoiseSource(color, rand)
          srcR = makeNoiseSource(color, rand)
        }
        if (p.brightness != null) brightness = p.brightness
      },
      render(L: Float32Array, R: Float32Array, n: number) {
        for (let i = 0; i < n; i++) {
          if (i % BLOCK === 0) {
            const b = brightness + drift.advance(BLOCK)
            coef = color === 'brown' ? 1 : onePoleCoeff(cutoffFor(b), fs)
          }
          const l = srcL()
          const r = srcR()
          lpL += (l - lpL) * coef
          lpR += (r - lpR) * coef
          L[i] = lpL
          R[i] = lpR
        }
      },
    }
  }

  interface Grain { left: number; len: number; amp: number; pl: number; pr: number; hp: number }
  interface Drop { t: number; len: number; f0: number; rise: number; amp: number; pl: number; pr: number; ph: number }

  function rainGenerator(fs: number, rand: () => number, params: SynthParams): Generator {
    let intensity = params.intensity == null ? 0.6 : params.intensity
    // ① 远处雨幕: 粉噪 → 高通 400 Hz → 低通 (2.4–6.5 kHz 缓慢起伏)
    const bedL = makeNoiseSource('pink', rand)
    const bedR = makeNoiseSource('pink', rand)
    const hpL = makeBiquad(biquadCoeffs('highpass', 400, 0.7, fs))
    const hpR = makeBiquad(biquadCoeffs('highpass', 400, 0.7, fs))
    const lpL = makeBiquad(biquadCoeffs('lowpass', 4000, 0.6, fs))
    const lpR = makeBiquad(biquadCoeffs('lowpass', 4000, 0.6, fs))
    const sway = makeWander(rand, 0, 1, 14, fs)
    // ② 近处密集雨点: 泊松触发的 1–5 ms 高通噪声颗粒
    const grains: Grain[] = []
    // ③ 个别清晰水滴: 5–20 ms 正弦, 频率指数上扬 (Minnaert 气泡共振)
    const drops: Drop[] = []
    const hpCoef = onePoleCoeff(1800, fs)
    let patterHpL = 0
    let patterHpR = 0
    let level = 1
    return {
      set(p: SynthParams) {
        if (p.intensity != null) intensity = clamp(p.intensity, 0, 1)
      },
      render(L: Float32Array, R: Float32Array, n: number) {
        for (let i = 0; i < n; i++) {
          if (i % BLOCK === 0) {
            const s = sway.advance(BLOCK)
            const cut = 2400 + 4100 * (0.35 * intensity + 0.65 * s)
            const c = biquadCoeffs('lowpass', cut, 0.6, fs)
            lpL.set(c)
            lpR.set(c)
            level = 0.75 + 0.35 * s
          }
          let l = lpL.process(hpL.process(bedL())) * 2.2 * level
          let r = lpR.process(hpR.process(bedR())) * 2.2 * level

          const grainRate = (40 + 260 * intensity) / fs
          if (rand() < grainRate && grains.length < 48) {
            const pan = rand()
            grains.push({
              left: Math.round(fs * (0.001 + 0.004 * rand())),
              len: 0,
              amp: (0.015 + 0.05 * rand() * rand()) * (0.6 + intensity * 0.6),
              pl: Math.cos(pan * Math.PI / 2),
              pr: Math.sin(pan * Math.PI / 2),
              hp: 0,
            })
            grains[grains.length - 1].len = grains[grains.length - 1].left
          }
          let gl = 0
          let gr = 0
          for (let g = grains.length - 1; g >= 0; g--) {
            const gr0 = grains[g]
            const env = gr0.left / gr0.len
            const v = (rand() * 2 - 1) * gr0.amp * env * env
            gl += v * gr0.pl
            gr += v * gr0.pr
            if (--gr0.left <= 0) grains.splice(g, 1)
          }
          // 一阶高通: x - lowpass(x)
          patterHpL += (gl - patterHpL) * hpCoef
          patterHpR += (gr - patterHpR) * hpCoef
          l += gl - patterHpL
          r += gr - patterHpR

          const dropRate = (0.6 + 3 * intensity) / fs
          if (rand() < dropRate && drops.length < 8) {
            const pan = 0.15 + 0.7 * rand()
            const len = Math.round(fs * (0.005 + 0.015 * rand()))
            drops.push({
              t: 0,
              len,
              f0: 1000 + 2400 * rand(),
              rise: Math.log(1.3 + 0.8 * rand()) / len,
              amp: 0.012 + 0.03 * rand() * rand(),
              pl: Math.cos(pan * Math.PI / 2),
              pr: Math.sin(pan * Math.PI / 2),
              ph: 0,
            })
          }
          for (let d = drops.length - 1; d >= 0; d--) {
            const dr = drops[d]
            const f = dr.f0 * Math.exp(dr.rise * dr.t)
            dr.ph += (2 * Math.PI * f) / fs
            const attack = dr.t < 48 ? dr.t / 48 : 1
            const env = attack * Math.exp((-4 * dr.t) / dr.len)
            const v = Math.sin(dr.ph) * dr.amp * env
            l += v * dr.pl
            r += v * dr.pr
            if (++dr.t >= dr.len) drops.splice(d, 1)
          }
          L[i] = l
          R[i] = r
        }
      },
    }
  }

  function windGenerator(fs: number, rand: () => number, params: SynthParams): Generator {
    let intensity = params.intensity == null ? 0.6 : params.intensity
    const srcA = makeNoiseSource('brown', rand)
    const srcB = makeNoiseSource('brown', rand)
    const srcC = makeNoiseSource('pink', rand)
    const bpL = makeBiquad(biquadCoeffs('bandpass', 500, 1, fs))
    const bpR = makeBiquad(biquadCoeffs('bandpass', 500, 1, fs))
    const whistle = makeBiquad(biquadCoeffs('bandpass', 1800, 6, fs))
    const center = makeWander(rand, 0, 1, 9, fs)
    const qWalk = makeWander(rand, 0.7, 2.4, 13, fs)
    const gust = makeWander(rand, 0.25, 1, 7, fs)
    const whistleF = makeWander(rand, 1300, 2600, 11, fs)
    const whistleG = makeWander(rand, 0, 1, 17, fs)
    const width = makeWander(rand, 0.85, 1.15, 6, fs)
    let g = 0.5
    let wg = 0
    let w = 1
    return {
      set(p: SynthParams) {
        if (p.intensity != null) intensity = clamp(p.intensity, 0, 1)
      },
      render(L: Float32Array, R: Float32Array, n: number) {
        for (let i = 0; i < n; i++) {
          if (i % BLOCK === 0) {
            const c = center.advance(BLOCK)
            const q = qWalk.advance(BLOCK)
            const fc = 220 * Math.pow(4.5, c * (0.6 + 0.4 * intensity))
            w = width.advance(BLOCK)
            bpL.set(biquadCoeffs('bandpass', fc * w, q, fs))
            bpR.set(biquadCoeffs('bandpass', fc / w, q, fs))
            whistle.set(biquadCoeffs('bandpass', whistleF.advance(BLOCK), 7, fs))
            g = gust.advance(BLOCK) * (0.55 + 0.6 * intensity)
            const wv = whistleG.advance(BLOCK)
            wg = wv > 0.7 ? (wv - 0.7) * 0.5 * intensity : 0
          }
          const a = srcA()
          const b = srcB()
          const shared = (a + b) * 0.5
          const wh = whistle.process(srcC()) * wg
          L[i] = bpL.process(shared * 0.7 + a * 0.3) * 7.2 * g + wh
          R[i] = bpR.process(shared * 0.7 + b * 0.3) * 7.2 * g + wh
        }
      },
    }
  }

  interface PadVoice { note: number; next: number; phA: number; phB: number; env: number; stage: number; wait: number; pan: number }

  function padGenerator(fs: number, rand: () => number): Generator {
    let chord = Math.floor(rand() * PAD_CHORDS.length)
    let hold = Math.round(fs * (10 + 10 * rand()))
    const pans = [-0.55, -0.18, 0.18, 0.55]
    const voices: PadVoice[] = PAD_CHORDS[chord].map((note, i) => ({
      // 起始包络 0.35: 一开播就听得到, 其余部分慢慢长出来
      note, next: note, phA: rand() * 6.28, phB: rand() * 6.28, env: 0.35, stage: 2, wait: Math.round(fs * i * 0.6), pan: pans[i],
    }))
    const attackStep = 1 / (fs * 5)
    const releaseStep = 1 / (fs * 3)
    const detune = Math.pow(2, 4 / 1200)
    const lpCoef = onePoleCoeff(1400, fs)
    const space = makeSpace(fs, 0.84, 0.35)
    const wet = [0, 0]
    let lpL = 0
    let lpR = 0
    return {
      set() {},
      render(L: Float32Array, R: Float32Array, n: number) {
        for (let i = 0; i < n; i++) {
          if (--hold <= 0) {
            chord = nextChordIndex(rand, chord, PAD_CHORDS.length)
            hold = Math.round(fs * (10 + 10 * rand()))
            const notes = PAD_CHORDS[chord]
            for (let v = 0; v < voices.length; v++) {
              const vo = voices[v]
              if (notes[v] === vo.note) continue
              vo.next = notes[v]
              vo.stage = 1 // 释放 → 换音 → 起音
              vo.wait = Math.round(fs * (v * (0.8 + 1.7 * rand())))
            }
          }
          let sl = 0
          let sr = 0
          for (let v = 0; v < voices.length; v++) {
            const vo = voices[v]
            if (vo.wait > 0) vo.wait--
            else if (vo.stage === 1) {
              vo.env -= releaseStep
              if (vo.env <= 0) { vo.env = 0; vo.note = vo.next; vo.stage = 2 }
            } else if (vo.stage === 2) {
              vo.env += attackStep
              if (vo.env >= 1) { vo.env = 1; vo.stage = 0 }
            }
            if (vo.env <= 0) continue
            const f = midiToHz(vo.note)
            vo.phA += (2 * Math.PI * f * detune) / fs
            vo.phB += (2 * Math.PI * f / detune) / fs
            if (vo.phA > 6.283185307179586) vo.phA -= 6.283185307179586
            if (vo.phB > 6.283185307179586) vo.phB -= 6.283185307179586
            // 正弦为主 + 少量三角波 (柔和的泛音)
            const triA = 1 - 2 * Math.abs(vo.phA / Math.PI - 1)
            const s = 0.42 * (Math.sin(vo.phA) + Math.sin(vo.phB)) + 0.08 * triA
            const e = vo.env * vo.env * (3 - 2 * vo.env) // smoothstep
            const amp = s * e * 0.1
            const p = (vo.pan + 1) * Math.PI / 4
            sl += amp * Math.cos(p)
            sr += amp * Math.sin(p)
          }
          lpL += (sl - lpL) * lpCoef
          lpR += (sr - lpR) * lpCoef
          space.process((lpL + lpR) * 0.5, wet)
          L[i] = lpL * 0.8 + wet[0] * 0.35
          R[i] = lpR * 0.8 + wet[1] * 0.35
        }
      },
    }
  }

  interface Chime { period: number; left: number; note: number; t: number; ph: number; active: boolean; pan: number; amp: number }

  function chimesGenerator(fs: number, rand: () => number): Generator {
    const loops: Chime[] = CHIME_PERIODS.map((p, k) => ({
      period: Math.round(p * fs),
      // 第一个音 1–2 s 内就响, 其余错开; 场景开头不会长时间无声
      left: Math.round(fs * (k === 0 ? 1 + rand() : 2 + p * rand())),
      note: CHIME_NOTES[Math.floor(rand() * CHIME_NOTES.length)],
      t: 0,
      ph: 0,
      active: false,
      pan: -0.7 + 1.4 * rand(),
      amp: 0,
    }))
    const attack = Math.round(fs * 0.25)
    const tau = fs * 2.6
    const space = makeSpace(fs, 0.86, 0.45)
    const wet = [0, 0]
    const lpCoef = onePoleCoeff(2600, fs)
    let lpL = 0
    let lpR = 0
    return {
      set() {},
      render(L: Float32Array, R: Float32Array, n: number) {
        for (let i = 0; i < n; i++) {
          let sl = 0
          let sr = 0
          for (let k = 0; k < loops.length; k++) {
            const c = loops[k]
            if (--c.left <= 0) {
              c.left = c.period
              // 偶尔跳过 / 换音, 让互质循环也带一点变化
              if (rand() < 0.75) {
                if (rand() < 0.25) c.note = CHIME_NOTES[Math.floor(rand() * CHIME_NOTES.length)]
                c.active = true
                c.t = 0
                c.amp = 0.07 + 0.05 * rand()
              }
            }
            if (!c.active) continue
            const f = midiToHz(c.note)
            c.ph += (2 * Math.PI * f) / fs
            if (c.ph > 6.283185307179586) c.ph -= 6.283185307179586
            const env = (c.t < attack ? c.t / attack : 1) * Math.exp(-c.t / tau)
            const v = (Math.sin(c.ph) + 0.12 * Math.sin(2 * c.ph)) * env * c.amp
            const p = (c.pan + 1) * Math.PI / 4
            sl += v * Math.cos(p)
            sr += v * Math.sin(p)
            if (++c.t > tau * 7) c.active = false
          }
          lpL += (sl - lpL) * lpCoef
          lpR += (sr - lpR) * lpCoef
          space.process((lpL + lpR) * 0.5, wet)
          // 偏湿的混音: 声音像从远处传来
          L[i] = lpL * 0.45 + wet[0] * 0.6
          R[i] = lpR * 0.45 + wet[1] * 0.6
        }
      },
    }
  }

  function makeGenerator(kind: SynthKind, fs: number, seed: number, params: SynthParams): Generator {
    const rand = mulberry32(seed || 1)
    const p = params || {}
    if (kind === 'rain') return rainGenerator(fs, rand, p)
    if (kind === 'wind') return windGenerator(fs, rand, p)
    if (kind === 'pad') return padGenerator(fs, rand)
    if (kind === 'chimes') return chimesGenerator(fs, rand)
    return noiseGenerator(fs, rand, p)
  }

  return {
    mulberry32,
    KELLET,
    BROWN_LEAK,
    NOISE_GAIN,
    biquadCoeffs,
    makeWander,
    makeNoiseSource,
    PAD_CHORDS,
    CHIME_NOTES,
    CHIME_PERIODS,
    nextChordIndex,
    midiToHz,
    makeGenerator,
  }
}
