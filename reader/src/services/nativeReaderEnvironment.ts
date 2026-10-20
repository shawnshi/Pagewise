/** Optional, read-only facts from the Android shell; old shells and browser previews remain supported. */
export interface NativeReaderEnvironment {
  version: 1
  boox: boolean
  lowRam: boolean
  memoryClassMb: number
}

export interface OnyxHardwareProfile {
  version: 1
  boox: boolean
  sdkAvailable: boolean
  model: string
  lowRam: boolean
  memoryClassMb: number
  physicalWidthPx: number
  physicalHeightPx: number
  densityDpi: number
  epdController: boolean
  frontLight: boolean
  ctmLight: boolean
  stylus: boolean
  colorEink: boolean
}

type EnvironmentHost = {
  LightReadInsets?: {
    getReaderEnvironment?: () => string
    getOnyxHardwareProfile?: () => string
  }
}
export type ReaderEnvironmentResult =
  | { status: 'available'; value: NativeReaderEnvironment }
  | { status: 'unavailable' }
  | { status: 'invalid' | 'error'; error: string }

export type OnyxHardwareProfileResult =
  | { status: 'available'; value: OnyxHardwareProfile }
  | { status: 'unavailable' }
  | { status: 'invalid' | 'error'; error: string }

export function readNativeReaderEnvironment(host: EnvironmentHost | undefined): ReaderEnvironmentResult {
  try {
    const bridge = host?.LightReadInsets
    if (typeof bridge?.getReaderEnvironment !== 'function') return { status: 'unavailable' }
    const value: unknown = JSON.parse(bridge.getReaderEnvironment())
    if (!value || typeof value !== 'object') return { status: 'invalid', error: 'Expected an environment object' }
    const v = value as Record<string, unknown>
    if (v.version !== 1 || typeof v.boox !== 'boolean' || typeof v.lowRam !== 'boolean'
      || typeof v.memoryClassMb !== 'number' || !Number.isInteger(v.memoryClassMb)
      || v.memoryClassMb < 16 || v.memoryClassMb > 16384) {
      return { status: 'invalid', error: 'Unsupported reader environment' }
    }
    return { status: 'available', value: { version: 1, boox: v.boox, lowRam: v.lowRam, memoryClassMb: v.memoryClassMb } }
  } catch (error) {
    return { status: 'error', error: error instanceof Error ? error.message : String(error) }
  }
}

let cachedEnvironment: ReaderEnvironmentResult | undefined
export function getNativeReaderEnvironment(): ReaderEnvironmentResult {
  // The bridge is installed before the app loads. Avoid a synchronous Android IPC on each page turn.
  return cachedEnvironment ??= readNativeReaderEnvironment(
    typeof window === 'undefined' ? undefined : window as EnvironmentHost,
  )
}

export function nativePdfPixelBudget(ceiling: number, environment = getNativeReaderEnvironment()): number {
  if (environment.status !== 'available') return ceiling
  // memoryClass is a coarse device hint, not available WebView heap. Reserve room for nearby pages,
  // MuPDF/ImageData/canvas copies and the rest of the app; this is not an OOM guarantee.
  const hint = Math.floor(environment.value.memoryClassMb * 1024 * 1024 / (4 * 8))
  if (environment.value.lowRam) return Math.min(ceiling, 2_000_000)
  const hw = cachedOnyxProfile
  if (hw?.status === 'available' && hw.value.boox && !hw.value.lowRam && hw.value.memoryClassMb >= 192) {
    const screenPixels = hw.value.physicalWidthPx * hw.value.physicalHeightPx
    return Math.min(ceiling, Math.max(1_000_000, hint, screenPixels))
  }
  return Math.min(ceiling, Math.max(1_000_000, hint))
}

export function readOnyxHardwareProfile(host: EnvironmentHost | undefined): OnyxHardwareProfileResult {
  try {
    const bridge = host?.LightReadInsets
    if (typeof bridge?.getOnyxHardwareProfile === 'function') {
      const raw: unknown = JSON.parse(bridge.getOnyxHardwareProfile())
      if (!raw || typeof raw !== 'object') return { status: 'invalid', error: 'Expected Onyx hardware profile object' }
      const v = raw as Record<string, unknown>
      if (v.version !== 1 || typeof v.boox !== 'boolean' || typeof v.lowRam !== 'boolean'
        || typeof v.memoryClassMb !== 'number' || !Number.isInteger(v.memoryClassMb)
        || v.memoryClassMb < 16 || v.memoryClassMb > 16384
        || typeof v.physicalWidthPx !== 'number' || v.physicalWidthPx < 1
        || typeof v.physicalHeightPx !== 'number' || v.physicalHeightPx < 1
        || typeof v.densityDpi !== 'number' || v.densityDpi < 72) {
        return { status: 'invalid', error: 'Unsupported Onyx hardware profile' }
      }
      return {
        status: 'available',
        value: {
          version: 1,
          boox: v.boox,
          sdkAvailable: Boolean(v.sdkAvailable),
          model: typeof v.model === 'string' && v.model.trim() ? v.model.trim() : 'BOOX',
          lowRam: v.lowRam,
          memoryClassMb: v.memoryClassMb,
          physicalWidthPx: Math.round(v.physicalWidthPx),
          physicalHeightPx: Math.round(v.physicalHeightPx),
          densityDpi: Math.round(v.densityDpi),
          epdController: Boolean(v.epdController),
          frontLight: Boolean(v.frontLight),
          ctmLight: Boolean(v.ctmLight),
          stylus: Boolean(v.stylus),
          colorEink: Boolean(v.colorEink),
        },
      }
    }
    const env = readNativeReaderEnvironment(host)
    if (env.status === 'available' && env.value.boox) {
      return {
        status: 'available',
        value: {
          version: 1,
          boox: true,
          sdkAvailable: false,
          model: 'NoteX3Pro',
          lowRam: env.value.lowRam,
          memoryClassMb: env.value.memoryClassMb,
          physicalWidthPx: 1860,
          physicalHeightPx: 2480,
          densityDpi: 300,
          epdController: true,
          frontLight: true,
          ctmLight: true,
          stylus: true,
          colorEink: false,
        },
      }
    }
    return { status: 'unavailable' }
  } catch (error) {
    return { status: 'error', error: error instanceof Error ? error.message : String(error) }
  }
}

let cachedOnyxProfile: OnyxHardwareProfileResult | undefined
export function getOnyxHardwareProfile(): OnyxHardwareProfileResult {
  return cachedOnyxProfile ??= readOnyxHardwareProfile(
    typeof window === 'undefined' ? undefined : window as EnvironmentHost,
  )
}

export function resetNativeEnvironmentCacheForTest(): void {
  cachedEnvironment = undefined
  cachedOnyxProfile = undefined
}
