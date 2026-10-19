/**
 * 系统语音后端。
 *
 * Android WebView 不实现 Web Speech API（speechSynthesis 不存在），所以 Android
 * 走原生 TextToSpeech 插件；桌面/网页仍用浏览器语音。两个后端暴露同一组
 * utterance/speak/pause/resume/cancel，供 listenPlayer 与 tts.ts 共用。
 */
import { reactive } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { isTauri } from '../storage'
import { useSettings } from '../stores/settings'

export interface SystemVoice {
  name: string
  locale: string
  network?: boolean
  quality?: number
}

export const systemTts = reactive({
  ready: false,
  available: false,
  /** 是否存在可离线使用的中文音色 */
  chinese: false,
  /** 中文音色只有联网版本：不能承诺离线朗读 */
  onlineOnly: false,
  focusLoss: 0,
  voices: [] as SystemVoice[],
})

export function systemVoiceHintKey(name: string): string {
  const selected = systemTts.voices.find(voice => voice.name === name)
  if (name && !selected) return 'tts.systemVoiceMissing'
  if (selected) return selected.network ? 'tts.hintSystemOnline' : 'tts.hintSystem'
  return systemTts.chinese ? 'tts.hintSystem' : 'tts.systemNoOffline'
}

export const isNativeSystemTts = () =>
  isTauri() && /Android/i.test(navigator.userAgent)

let initPromise: Promise<void> | null = null

/** 初始化一次；失败时把持久化的 system 引擎回退到在线语音。 */
export function initSystemTts(): Promise<void> {
  if (initPromise) return initPromise
  initPromise = (async () => {
    if (!isNativeSystemTts()) {
      systemTts.available =
        typeof speechSynthesis !== 'undefined' &&
        typeof SpeechSynthesisUtterance !== 'undefined'
      systemTts.ready = true
      return
    }
    try {
      const result = await invoke<{
        available?: boolean
        chinese?: boolean
        onlineOnly?: boolean
        voices?: SystemVoice[]
      }>('system_tts_available')
      systemTts.available = !!result?.available
      systemTts.chinese = !!result?.chinese
      systemTts.onlineOnly = !!result?.onlineOnly
      systemTts.voices = Array.isArray(result?.voices) ? result.voices : []
    } catch {
      systemTts.available = false
    } finally {
      systemTts.ready = true
    }
    if (!systemTts.available) {
      try {
        const settings = useSettings()
        if (settings.ttsEngine === 'system') settings.ttsEngine = 'edge'
      } catch {
        /* Pinia 尚未就绪时由阅读器自检兜底 */
      }
    }
  })()
  return initPromise
}

export interface SystemUtterance {
  text: string
  rate?: number
  voice?: unknown
  lang?: string
  onstart?: () => void
  onend?: () => void
  onerror?: (event: { error: string }) => void
}

export interface SystemSpeechBackend {
  kind: 'web' | 'native'
  utterance(text: string): SystemUtterance
  speak(utterance: SystemUtterance): void
  cancel(): void
  pause(): void
  resume(): void
  /** 原生批量朗读: 返回已播完的句子数 (含暂停后重读的当前句). */
  speakBatch?(
    texts: string[],
    rate: number,
    voice: string,
    onIndex: (index: number) => void,
  ): Promise<number>
}

const webBackend: SystemSpeechBackend = {
  kind: 'web',
  // SAFETY: SpeechSynthesisUtterance provides text/rate/voice/lang and the event
  // handlers SystemUtterance declares; only the web backend consumes this object.
  utterance: text => new SpeechSynthesisUtterance(text) as unknown as SystemUtterance,
  speak: utterance => {
    if (typeof speechSynthesis === 'undefined') {
      utterance.onerror?.({ error: 'tts_unavailable' })
      return
    }
    // SAFETY: the web backend only receives objects created by its own utterance().
    speechSynthesis.speak(utterance as unknown as SpeechSynthesisUtterance)
  },
  cancel: () => {
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel()
  },
  pause: () => {
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.pause()
  },
  resume: () => {
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.resume()
  },
}

export const systemTtsErrorCode = (error: unknown): string => {
  if (typeof error === 'string') return error
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : 'tts_error'
}

/** Shared, localized errors: never treat a failed utterance as successfully read. */
export function systemTtsErrorKey(error: unknown): string {
  switch (systemTtsErrorCode(error)) {
    case 'no_voice':
    case 'no_offline_voice': return 'tts.systemNoOffline'
    case 'voice_missing': return 'tts.systemVoiceMissing'
    case 'audio_focus_denied':
    case 'audio_focus_lost': return 'tts.focusPaused'
    case 'tts_unavailable': return 'tts.systemUnavailable'
    case 'background_unavailable': return 'tts.backgroundUnavailable'
    case 'extraction_failed':
    case 'coverage_incomplete': return 'tts.nativeExtractionFailed'
    case 'source_changed': return 'tts.nativeSourceChanged'
    case 'resource_limit':
    case 'disk_full': return 'tts.nativeCapacity'
    case 'queue_corrupt': return 'tts.nativeQueueCorrupt'
    case 'tts_busy': return 'tts.nativeBusy'
    case 'io_error': return 'tts.nativeStorageError'
    case 'instance_replaced':
    case 'stale_generation':
    case 'session_replaced': return 'tts.nativeConnection'
    case 'tts_empty':
    case 'no_readable_text': return 'tts.noReadableText'
    default: return 'tts.error'
  }
}

/**
 * 原生后端按句串行播放。Android TextToSpeech 没有 pause API，暂停时停止当前句，
 * 恢复时从这一句开头重读；对“系统语音”兜底路径可接受，也避免丢句。
 */
export function createNativeBackend(): SystemSpeechBackend {
  const queue: SystemUtterance[] = []
  let active = false
  let paused = false
  let generation = 0

  let stopBarrier: Promise<void> = Promise.resolve()
  let stopFailure: unknown = null
  const stopNative = () => {
    stopBarrier = invoke('system_tts_stop').then(
      () => { stopFailure = null },
      error => { stopFailure = error },
    )
  }

  let batchSession = 0
  let batchWaiters: Array<() => void> = []
  const waitBatchResume = () =>
    new Promise<void>(resolve => {
      batchWaiters.push(resolve)
    })
  const releaseBatch = () => {
    const waiters = batchWaiters
    batchWaiters = []
    waiters.forEach(resolve => resolve())
  }

  const selectedVoice = () => {
    try {
      return useSettings().ttsVoice ?? ''
    } catch {
      return ''
    }
  }

  const pump = () => {
    if (paused || active || queue.length === 0) return
    const utterance = queue[0]
    active = true
    const current = ++generation
    utterance.onstart?.()
    const request = async () => {
      await stopBarrier
      if (current !== generation) return
      if (stopFailure) throw stopFailure
      return invoke('system_tts_speak', {
        text: utterance.text,
        rate: utterance.rate ?? 1,
        voice: selectedVoice(),
      })
    }
    request()
      .then(() => {
        if (current !== generation) return
        active = false
        if (paused) return
        queue.shift()
        utterance.onend?.()
        pump()
      })
      .catch((error: unknown) => {
        if (current !== generation) return
        const code = systemTtsErrorCode(error)
        active = false
        if (code === 'audio_focus_lost') {
          // 保留当前句; 播放器会进入暂停, 恢复时重读这一句.
          paused = true
          systemTts.focusLoss++
          return
        }
        if (paused) return
        queue.shift()
        utterance.onerror?.({ error: code })
        pump()
      })
  }

  return {
    kind: 'native',
    utterance: text => ({ text }),
    speak: utterance => {
      queue.push(utterance)
      pump()
    },
    cancel: () => {
      const cancelled = queue.splice(0)
      active = false
      paused = false
      batchSession++
      generation++
      releaseBatch()
      stopNative()
      cancelled.forEach(utterance => utterance.onerror?.({ error: 'canceled' }))
    },
    pause: () => {
      if (paused) return
      paused = true
      active = false
      generation++
      stopNative()
    },
    resume: () => {
      if (!paused) return
      paused = false
      releaseBatch()
      pump()
    },
    speakBatch: async (texts, rate, voice, onIndex) => {
      const session = ++batchSession
      const alive = () => session === batchSession
      let offset = 0
      while (offset < texts.length) {
        while (paused && alive()) await waitBatchResume()
        if (!alive()) throw Object.assign(new Error('canceled'), { code: 'canceled' })
        await stopBarrier
        if (!alive()) throw Object.assign(new Error('canceled'), { code: 'canceled' })
        if (stopFailure) throw stopFailure
        const slice = texts.slice(offset)
        const startedAt = offset
        let last = -1
        let polling = false
        let settled = false
        let poll: ReturnType<typeof setInterval> | null = null
        const request = invoke<{ status?: string; index?: number }>('system_tts_speak_batch', {
          texts: slice,
          rate,
          voice,
        })
        poll = setInterval(async () => {
          if (polling || settled || !alive()) return
          polling = true
          try {
            const status = await invoke<{ index?: number }>('system_tts_status')
            const index = typeof status?.index === 'number' ? status.index : -1
            if (!settled && alive() && index > last && index < slice.length) {
              last = index
              onIndex(startedAt + index)
            }
          } catch {
            /* 状态轮询失败时等命令本身的结果 */
          } finally {
            polling = false
          }
        }, 350)
        try {
          const result = await request
          if (!alive()) throw Object.assign(new Error('canceled'), { code: 'canceled' })
          if (result.status !== 'done' || result.index !== slice.length) {
            throw Object.assign(new Error('tts_error'), { code: 'tts_error' })
          }
          offset = startedAt + slice.length
        } catch (error) {
          if (!alive()) throw Object.assign(new Error('canceled'), { code: 'canceled' })
          const status = await invoke<{ index?: number }>('system_tts_status').catch(() => null)
          if (!alive()) throw Object.assign(new Error('canceled'), { code: 'canceled' })
          const index = typeof status?.index === 'number' ? status.index : Math.max(0, last)
          offset = startedAt + Math.max(0, Math.min(slice.length - 1, index))
          const code = systemTtsErrorCode(error)
          if (code === 'audio_focus_lost') {
            paused = true
            systemTts.focusLoss++
          }
          if (paused) continue
          throw Object.assign(new Error(code), { code, index: offset })
        } finally {
          settled = true
          if (poll) clearInterval(poll)
        }
      }
      return offset
    },
  }
}

let nativeBackend: SystemSpeechBackend | null = null

export function systemSpeech(): SystemSpeechBackend {
  if (isNativeSystemTts()) {
    nativeBackend ??= createNativeBackend()
    return nativeBackend
  }
  return webBackend
}
