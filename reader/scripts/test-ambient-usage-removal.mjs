import assert from 'node:assert/strict'
import { access, readFile, readdir } from 'node:fs/promises'
import { test } from 'node:test'

const source = path => readFile(new URL(path, import.meta.url), 'utf8')

test('background sound UI and feature-only playback/download modules are retired', async () => {
  await assert.rejects(access(new URL('../src/components/AmbientPanel.vue', import.meta.url)), { code: 'ENOENT' })
  // Git tracks files, not empty directories left by an incremental checkout.
  const ambientFiles = await readdir(new URL('../src/services/ambient', import.meta.url), { recursive: true }).catch(error => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  assert.deepEqual(ambientFiles, [], 'No retired playback/download source or assets remain')
  const reader = await source('../src/views/ReaderView.vue')
  assert.doesNotMatch(reader, /ambient|AmbientPanel|useAmbient|背景音/)
  assert.match(reader, /<span(?:\s+[^>]*)?>\{\{ t\('tts.title'\) \}\}<\/span>/, 'listening remains available')
  assert.match(reader, /listenPlayer\.fadeOut\(SLEEP_FADE_SECONDS\)/, 'listening sleep timer remains')
  assert.match(reader, /useReadingTimer\(bookId\)/, 'local reading log remains active')
  const typing = await source('../src/services/readingModes/sound.ts')
  assert.match(typing, /AudioContext/, 'typewriter effects retain their own playback engine')
})

test('anonymous telemetry collectors and startup/book-open reporting are removed, not just hidden', async () => {
  for (const name of ['usageStats.ts', 'usageStatsCore.ts', 'usageCounters.ts']) {
    await assert.rejects(access(new URL(`../src/services/${name}`, import.meta.url)), { code: 'ENOENT' })
  }
  for (const path of ['../src/App.vue', '../src/views/ReaderView.vue', '../src/views/PdfReaderView.vue', '../src/services/PagewiseCompanion/engine.ts']) {
    assert.doesNotMatch(await source(path), /pingUsage|usageStats|usageCounters|noteDjReading|noteKeyWordChunk/)
  }
  const settings = await source('../src/views/SettingsView.vue')
  assert.doesNotMatch(settings, /usageStats/)
  assert.match(settings, /settings\.language/)
  assert.match(settings, /settings\.appearance/)
  const scripts = await source('../package.json')
  assert.doesNotMatch(scripts, /"test:(?:ambient|usage-stats)"/)
})

test('both UI languages and bundled manual stop advertising retired features', async () => {
  for (const language of ['zh', 'en']) {
    assert.doesNotMatch(await source(`../src/i18n/${language}.ts`), /'ambient\.|'settings\.usageStats/)
  }
  for (const name of ['README.md', '02-阅读模式.md', '03-声音.md', '04-使用说明.md']) {
    assert.doesNotMatch(await source(`../docs/manual/${name}`), /背景音/)
  }
  const listening = await source('../docs/manual/03-声音.md')
  assert.match(listening, /PDF 朗读有什么不同/, 'PDF listening instructions must survive background-section removal')
  await access(new URL('../docs/ambient-sources.md', import.meta.url)) // Shared typewriter sound credits remain.
})
