export const TARGET_LANGUAGES = [
  { code: 'zh', englishName: 'Simplified Chinese', labelKey: 'paper.bdLanguageZh' },
  { code: 'zh-TW', englishName: 'Traditional Chinese', labelKey: 'paper.bdLanguageZhTw' },
  { code: 'ja', englishName: 'Japanese', labelKey: 'paper.bdLanguageJa' },
  { code: 'ko', englishName: 'Korean', labelKey: 'paper.bdLanguageKo' },
  { code: 'fr', englishName: 'French', labelKey: 'paper.bdLanguageFr' },
  { code: 'de', englishName: 'German', labelKey: 'paper.bdLanguageDe' },
  { code: 'es', englishName: 'Spanish', labelKey: 'paper.bdLanguageEs' },
  { code: 'pt', englishName: 'Portuguese', labelKey: 'paper.bdLanguagePt' },
  { code: 'it', englishName: 'Italian', labelKey: 'paper.bdLanguageIt' },
  { code: 'ru', englishName: 'Russian', labelKey: 'paper.bdLanguageRu' },
] as const

export type TargetLanguageCode = typeof TARGET_LANGUAGES[number]['code']
export type TargetLanguage = typeof TARGET_LANGUAGES[number]
export const DEFAULT_TARGET_LANGUAGE = TARGET_LANGUAGES[0]
// Preserve the existing translation preference; the key does not enable a service.
const TARGET_LANGUAGE_STORAGE_KEY = 'lightread-babeldoc-target-language'

export function resolveTargetLanguage(value: unknown): TargetLanguage {
  return TARGET_LANGUAGES.find(language => language.code === value) ?? DEFAULT_TARGET_LANGUAGE
}

export function loadTargetLanguage(): TargetLanguageCode {
  try { return resolveTargetLanguage(localStorage.getItem(TARGET_LANGUAGE_STORAGE_KEY)).code }
  catch { return DEFAULT_TARGET_LANGUAGE.code }
}

export function saveTargetLanguage(value: unknown): TargetLanguageCode {
  const code = resolveTargetLanguage(value).code
  try { localStorage.setItem(TARGET_LANGUAGE_STORAGE_KEY, code) }
  catch { /* An unavailable preference store must not prevent translation. */ }
  return code
}
