import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('system TTS service bridges native commands and keeps a web fallback', () => {
  const source = read('src/services/systemTts.ts')
  assert.match(source, /system_tts_available/)
  assert.match(source, /system_tts_speak/)
  assert.match(source, /system_tts_stop/)
  assert.match(source, /export function systemSpeech/)
  assert.match(source, /isNativeSystemTts/)
  assert.match(source, /QUEUE|queue/)
  assert.match(source, /typeof speechSynthesis === 'undefined'/)
  assert.match(source, /audio_focus_lost/)
  assert.match(source, /onlineOnly/)
})

test('tts.ts guards missing Web Speech API and uses the shared backend', () => {
  const source = read('src/services/tts.ts')
  assert.match(source, /typeof speechSynthesis === 'undefined'/)
  assert.match(source, /systemSpeech\(\)/)
  assert.doesNotMatch(source, /speechSynthesis\.speak\(utterance\)/)
})

test('listenPlayer speaks through the backend instead of touching speechSynthesis', () => {
  const source = read('src/services/listenPlayer.ts')
  assert.match(source, /systemSpeech.*type SystemUtterance/)
  assert.match(source, /backend\.speak\(u\)/)
  assert.match(source, /backend\.pause\(\)/)
  assert.match(source, /audio_focus_lost/)
  assert.doesNotMatch(source, /speechSynthesis\./)
})

test('reader panels only show the system engine when it is available', () => {
  for (const file of ['src/views/ReaderView.vue', 'src/views/PdfReaderView.vue']) {
    const source = read(file)
    assert.match(source, /v-if="systemTts\.available"/, `${file} gates the system button`)
    assert.match(source, /isNativeSystemTts\(\)/, `${file} shows a native voice picker`)
    assert.match(source, /nativeVoiceOptions/, `${file} lists native voices`)
    assert.match(source, /systemVoiceHintKey\(settings\.ttsVoice\)/, `${file} explains the selected voice's network requirement`)
    assert.match(source, /systemTts\.focusLoss/, `${file} synchronizes paused UI on focus loss`)
  }
  const zh = read('src/i18n/zh.ts')
  assert.doesNotMatch(zh, /断网后自动改用系统语音/)
})

test('Android plugin registers TextToSpeech and publishes import/export-safe commands', () => {
  const kotlin = read('src-tauri/android/SystemTtsPlugin.kt')
  assert.match(kotlin, /@TauriPlugin/)
  const service = read('src-tauri/android/NativeSpeechService.kt')
  assert.match(service, /TextToSpeech\.OnInitListener/)
  assert.match(service, /UtteranceProgressListener/)
  assert.match(service, /TextToSpeech\.QUEUE_FLUSH/)
  assert.doesNotMatch(kotlin, /TextToSpeech\(/)
  assert.match(kotlin, /fun available\(/)
  assert.match(kotlin, /fun speak\(/)
  assert.match(kotlin, /fun stop\(/)
  assert.match(service, /focus_lost/)
  assert.match(kotlin, /SystemTtsService/)
  assert.match(service, /FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK|mediaPlayback/)
  assert.match(service, /AtomicFile/)
  assert.match(service, /noBackupFilesDir/)
  assert.match(service, /coverage_incomplete/)
  assert.match(service, /stale_generation/)
  assert.match(service, /request_conflict/)
  assert.match(service, /process_restart/)
  assert.match(service, /MediaSession/)
  assert.match(kotlin, /fun session\(/)
  assert.doesNotMatch(read('src-tauri/android/MainActivity.kt'), /keepWebViewAlive|override fun onPause/)

  const rust = read('src-tauri/src/system_tts.rs')
  assert.match(rust, /register_android_plugin\("io\.pagewise\.reader", "SystemTtsPlugin"\)/)
  assert.match(rust, /system_tts_available/)
  assert.match(rust, /system_tts_speak/)
  assert.match(rust, /system_tts_stop/)
  assert.match(rust, /system_tts_session/)

  const prep = read('scripts/prepare-android-project.mjs')
  assert.match(prep, /SystemTtsPlugin\.kt/)
  assert.match(prep, /NativeSpeechService\.kt/)
  assert.match(prep, /FOREGROUND_SERVICE_MEDIA_PLAYBACK/)
  assert.match(prep, /SystemTtsService/)
  const lib = read('src-tauri/src/lib.rs')
  assert.match(lib, /system_tts::init\(\)/)
  assert.match(lib, /system_tts::system_tts_speak/)
})
