/**
 * 合成层的音频节点: 优先 AudioWorklet (音频线程, 不受主线程卡顿影响),
 * 不可用时回退 ScriptProcessorNode (旧 WebView / 非安全上下文)。
 *
 * Worklet 模块用 Blob URL 加载, 源码由 dsp.ts 的自包含工厂函数拼成, 不依赖 Vite 的资源路径:
 * 网页 PWA、Tauri 桌面 (tauri.localhost) 与 Android WebView 都用同一条路径。
 */
import { ambientDsp, type SynthKind, type SynthParams } from './dsp.ts'

export const PROCESSOR_NAME = 'lightread-ambient'

/** Worklet 模块源码 (导出供单测检查) */
export function workletSource(): string {
  return `const DSP = (${ambientDsp.toString()})();
class LightReadAmbientProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.gen = DSP.makeGenerator(o.kind, sampleRate, (o.seed >>> 0) || 1, o.params || {});
    this.alive = true;
    this.spare = null;
    this.port.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === 'params') this.gen.set(m.params || {});
      else if (m.type === 'stop') this.alive = false;
    };
  }
  process(inputs, outputs) {
    const out = outputs[0];
    if (!out || !out[0]) return this.alive;
    const L = out[0];
    let R = out[1];
    if (!R) {
      if (!this.spare || this.spare.length !== L.length) this.spare = new Float32Array(L.length);
      R = this.spare;
    }
    this.gen.render(L, R, L.length);
    return this.alive;
  }
}
registerProcessor('${PROCESSOR_NAME}', LightReadAmbientProcessor);
`
}

export interface SynthNode {
  /** 接到混音链上的输出节点 */
  node: AudioNode
  mode: 'worklet' | 'script'
  set(params: SynthParams): void
  /** 断开并让处理器退出 */
  stop(): void
}

const moduleLoads = new WeakMap<BaseAudioContext, Promise<boolean>>()

/** 每个 AudioContext 只加载一次 Worklet 模块; 失败 (不支持 / 被策略拦截) 返回 false */
export function loadWorklet(ctx: BaseAudioContext): Promise<boolean> {
  let p = moduleLoads.get(ctx)
  if (!p) {
    p = (async () => {
      const worklet = (ctx as AudioContext).audioWorklet
      if (!worklet || typeof AudioWorkletNode === 'undefined') return false
      const url = URL.createObjectURL(new Blob([workletSource()], { type: 'text/javascript' }))
      try {
        await worklet.addModule(url)
        return true
      } catch (e) {
        console.warn('[ambient] AudioWorklet 不可用, 回退 ScriptProcessor', e)
        return false
      } finally {
        URL.revokeObjectURL(url)
      }
    })()
    moduleLoads.set(ctx, p)
  }
  return p
}

let sharedDsp: ReturnType<typeof ambientDsp> | null = null

export async function createSynthNode(
  ctx: AudioContext,
  kind: SynthKind,
  params: SynthParams,
  seed = (Math.random() * 0xffffffff) >>> 0,
): Promise<SynthNode> {
  if (await loadWorklet(ctx)) {
    try {
      const node = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: { kind, params, seed },
      })
      return {
        node,
        mode: 'worklet',
        set(p) { node.port.postMessage({ type: 'params', params: p }) },
        stop() {
          node.port.postMessage({ type: 'stop' })
          try { node.disconnect() } catch { /* 已断开 */ }
        },
      }
    } catch (e) {
      console.warn('[ambient] 创建 AudioWorkletNode 失败, 回退 ScriptProcessor', e)
    }
  }
  // 回退: 主线程生成, 4096 帧缓冲 (约 85 ms) 足以抗住一般的主线程抖动
  sharedDsp ??= ambientDsp()
  const gen = sharedDsp.makeGenerator(kind, ctx.sampleRate, seed || 1, params)
  const sp = ctx.createScriptProcessor(4096, 0, 2)
  sp.onaudioprocess = (e: AudioProcessingEvent) => {
    const out = e.outputBuffer
    const L = out.getChannelData(0)
    const R = out.numberOfChannels > 1 ? out.getChannelData(1) : new Float32Array(L.length)
    gen.render(L, R, L.length)
  }
  return {
    node: sp,
    mode: 'script',
    set(p) { gen.set(p) },
    stop() {
      sp.onaudioprocess = null
      try { sp.disconnect() } catch { /* 已断开 */ }
    },
  }
}
