<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { getStorage, isTauri } from '../storage'
import { useSettings } from '../stores/settings'
import { useLibrary } from '../stores/library'
import { exportBackup, importBackup, LIBRARY_ARCHIVE_EXTENSION } from '../services/backup'
import { fetchRemote } from '../services/net'
import { toast } from '../services/toast'
import { CURRENT_VERSION } from '../services/appVersion'
import { t } from '../i18n'
import { loadLibrarySession, saveLibrarySession } from '../services/librarySession'
import { providerById, chatStream } from '../services/ai'
import AppIcon from '../components/AppIcon.vue'
import AiProviderSelector from '../components/AiProviderSelector.vue'
import { useFolderLibrary } from '../services/folderLibrary'

const settings = useSettings()
const library = useLibrary()
const storageKind = ref('')
const busy = ref('')
const backupInput = ref<HTMLInputElement>()

const folderLibrary = computed(() => useFolderLibrary())

async function onChooseMonitoredFolder() {
  try {
    await folderLibrary.value?.chooseFolder()
  } catch (err: any) {
    toast(err?.message || t('common.unknownError'), 'error')
  }
}

async function onRescanMonitoredFolder() {
  try {
    await folderLibrary.value?.rescan()
    const status = folderLibrary.value?.status.value
    if (status && ['partial', 'error', 'permission-denied'].includes(status.state)) {
      const message = status.state === 'partial' ? [t('folder.status.partial'), status.error].filter(Boolean).join(' · ') : status.error || t('library.filePermission')
      throw new Error(message)
    }
    toast(t('common.done'), 'success', 2000)
  } catch (err: any) {
    toast(err?.message || t('common.unknownError'), 'error')
  }
}

const navSections = computed(() => [
  { id: 'general', label: t('settings.general') },
  { id: 'folder', label: t('folder.monitoredTitle') },
  { id: 'library-display', label: t('library.libraryDisplay') },
  { id: 'reading', label: t('settings.navReading') },
  { id: 'ai', label: t('settings.aiTitle') },
  { id: 'data', label: t('settings.data') },
  { id: 'network', label: t('settings.network') },
  { id: 'about', label: t('settings.about') },
])
const libraryPageSize = ref(loadLibrarySession()?.pageSize ?? 12)
watch(libraryPageSize, value => { saveLibrarySession({ pageSize: value, page: 1 }) })
const activeSection = ref('general')
const rootEl = ref<HTMLElement>()
const navEl = ref<HTMLElement>()
let scroller: HTMLElement | null = null
let spyFrame = 0
let spyLockUntil = 0

function updateActiveSection() {
  spyFrame = 0
  if (!scroller || Date.now() < spyLockUntil) return
  const navBottom = navEl.value?.getBoundingClientRect().bottom ?? 0
  let current = navSections.value[0]?.id ?? ''
  for (const s of navSections.value) {
    const el = document.getElementById(`settings-${s.id}`)
    if (el && el.getBoundingClientRect().top <= navBottom + 32) current = s.id
  }
  if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4) {
    current = navSections.value[navSections.value.length - 1]?.id ?? current
  }
  setActiveSection(current)
}

function setActiveSection(id: string) {
  if (activeSection.value === id) return
  activeSection.value = id
  nextTick(() => {
    const nav = navEl.value
    const chip = nav?.querySelector<HTMLElement>(`[data-section="${id}"]`)
    if (!nav || !chip) return
    const left = chip.offsetLeft - 16
    const right = chip.offsetLeft + chip.offsetWidth + 16 - nav.clientWidth
    if (nav.scrollLeft > left) nav.scrollTo({ left, behavior: 'smooth' })
    else if (nav.scrollLeft < right) nav.scrollTo({ left: right, behavior: 'smooth' })
  })
}

function onSettingsScroll() {
  if (!spyFrame) spyFrame = requestAnimationFrame(updateActiveSection)
}

function jumpTo(id: string) {
  const el = document.getElementById(`settings-${id}`)
  if (!el) return
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  spyLockUntil = Date.now() + (reduce ? 50 : 700)
  setActiveSection(id)
  el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' })
  el.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true })
}

const route = useRoute()
onMounted(async () => {
  scroller = rootEl.value?.closest<HTMLElement>('.main') ?? null
  scroller?.addEventListener('scroll', onSettingsScroll, { passive: true })
  const section = typeof route.query.section === 'string' ? route.query.section : ''
  if (section && navSections.value.some(s => s.id === section)) nextTick(() => jumpTo(section))
  parseProxyUrl(settings.httpProxy)
  const storage = await getStorage()
  storageKind.value = storage.kind
})
onBeforeUnmount(() => {
  scroller?.removeEventListener('scroll', onSettingsScroll)
  if (spyFrame) cancelAnimationFrame(spyFrame)
})

const PROXY_SCHEMES: Array<{ label?: string; labelKey?: string; value: string }> = [
  { labelKey: 'settings.proxyNone', value: '' },
  { label: 'HTTP', value: 'http' },
  { label: 'HTTPS', value: 'https' },
  { label: 'SOCKS5', value: 'socks5' },
  { labelKey: 'settings.proxySocks5h', value: 'socks5h' },
  { label: 'SOCKS4', value: 'socks4' },
]
const proxy = reactive({ scheme: '', host: '127.0.0.1', port: '7890', username: '', password: '' })

function parseProxyUrl(raw: string) {
  const m = raw.trim().match(
    /^(https?|socks5h?|socks4a?):\/\/(?:([^:@/]+)(?::([^@/]*))?@)?([^:/@]+)(?::(\d+))?$/i)
  if (!m) return
  proxy.scheme = m[1].toLowerCase()
  proxy.username = m[2] ? decodeURIComponent(m[2]) : ''
  proxy.password = m[3] ? decodeURIComponent(m[3]) : ''
  proxy.host = m[4]
  proxy.port = m[5] ?? ''
}

function composeProxyUrl(): string {
  if (!proxy.scheme || !proxy.host.trim()) return ''
  const auth = proxy.username
    ? `${encodeURIComponent(proxy.username)}${proxy.password ? ':' + encodeURIComponent(proxy.password) : ''}@`
    : ''
  const port = proxy.port.trim() ? `:${proxy.port.trim()}` : ''
  return `${proxy.scheme}://${auth}${proxy.host.trim()}${port}`
}
watch(proxy, () => { settings.httpProxy = composeProxyUrl() })

const testing = ref(false)
const testResult = ref('')
async function testProxy() {
  testing.value = true
  testResult.value = ''
  const start = performance.now()
  try {
    await fetchRemote('https://www.google.com/generate_204')
    testResult.value = t('settings.proxyOk', { ms: Math.round(performance.now() - start) })
  } catch (e: any) {
    testResult.value = e?.message ?? t('settings.connectionFailed')
  } finally {
    testing.value = false
  }
}

const aiTesting = ref(false)
const aiTestResult = ref('')
const aiBaseUrlOpen = ref(false)
const aiShowBaseUrl = computed(() => {
  try {
    const preset = providerById(settings.aiProvider)
    return aiBaseUrlOpen.value || preset.id === 'custom' || !settings.aiBaseUrl || settings.aiBaseUrl !== preset.baseUrl
  } catch {
    return true
  }
})
const aiDocsUrl = computed(() => {
  try {
    return providerById(settings.aiProvider).docsUrl ?? ''
  } catch {
    return ''
  }
})

async function openAiDocs() {
  if (isTauri()) {
    const { openUrl } = await import('@tauri-apps/plugin-opener')
    await openUrl(aiDocsUrl.value)
  } else {
    window.open(aiDocsUrl.value, '_blank', 'noopener,noreferrer')
  }
}

async function testAi() {
  if (aiTesting.value) return
  aiTesting.value = true
  aiTestResult.value = ''
  const started = performance.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    let got = ''
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout 20s')), 20000)
    })
    await Promise.race([
      (async () => {
        for await (const delta of chatStream([{ role: 'user', content: '请回复: OK' }])) {
          got += delta
          if (got.length >= 2) break
        }
      })(),
      timeout,
    ])
    aiTestResult.value = t('settings.aiTestOk', { ms: Math.round(performance.now() - started), reply: got.slice(0, 20) })
  } catch (e: any) {
    aiTestResult.value = e?.message ?? String(e)
  } finally {
    clearTimeout(timer)
    aiTesting.value = false
  }
}

const migrating = ref('')
async function changeLibraryRoot() {
  const { open } = await import('@tauri-apps/plugin-dialog')
  const picked = await open({ directory: true, title: t('settings.pickLibraryFolder') })
  if (typeof picked !== 'string') return
  const { hasLibraryAt, migrateLibraryTo } = await import('../storage/tauri')
  try {
    if (await hasLibraryAt(picked)) {
      if (!confirm(t('settings.useExistingLibrary', { path: picked }))) return
    } else {
      if (!confirm(t('settings.migrateConfirm', { path: picked }))) return
      migrating.value = t('settings.preparingMigration')
      await migrateLibraryTo(picked, msg => (migrating.value = msg))
    }
    settings.libraryRoot = picked
    localStorage.setItem('lightread-settings', JSON.stringify(settings.$state))
    toast(t('settings.locationSwitched'), 'success')
    setTimeout(() => location.reload(), 800)
  } catch (e: any) {
    migrating.value = ''
    toast(t('settings.switchFailed', { msg: e?.message ?? t('common.unknownError') }), 'error', 6000)
  }
}
function resetLibraryRoot() {
  if (!confirm(t('settings.resetLocationConfirm'))) return
  settings.libraryRoot = ''
  localStorage.setItem('lightread-settings', JSON.stringify(settings.$state))
  setTimeout(() => location.reload(), 300)
}
async function doExport() {
  busy.value = t('settings.preparingExport')
  try {
    const blob = await exportBackup(msg => (busy.value = msg))
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `lightread-library-${new Date().toISOString().slice(0, 10)}${LIBRARY_ARCHIVE_EXTENSION}`
    a.click()
    URL.revokeObjectURL(a.href)
    toast(t('settings.backupExported'), 'success')
  } catch (e: any) {
    toast(t('settings.exportFailed', { msg: e?.message }), 'error', 5000)
  } finally {
    busy.value = ''
  }
}
async function doImport(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  busy.value = t('settings.readingBackup')
  try {
    const result = await importBackup(file, msg => (busy.value = msg))
    await library.refresh()
    toast(t('settings.archiveImportDone', { books: result.books, annotations: result.annotations }), 'success', 5000)
  } catch (e: any) {
    toast(t('settings.restoreFailed', { msg: e?.message }), 'error', 5000)
  } finally {
    busy.value = ''
  }
}
const APPEARANCE_OPTIONS = [
  { value: 'system', labelKey: 'settings.appearanceSystem', icon: 'M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5zm4 16h8m-4-5v5' },
  { value: 'light', labelKey: 'settings.appearanceLight', icon: 'M12 3v2m0 14v2M5.6 5.6l1.4 1.4m10 10 1.4 1.4M3 12h2m14 0h2M5.6 18.4l1.4-1.4m10-10 1.4-1.4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z' },
  { value: 'dark', labelKey: 'settings.appearanceDark', icon: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z' },
] as const
</script>

<template>
  <div ref="rootEl" class="settings">
    <h1>{{ t('settings.title') }}</h1>
    <nav ref="navEl" class="settings-nav" :aria-label="t('settings.navLabel')">
      <button v-for="s in navSections" :key="s.id" type="button" class="nav-chip" :class="{ active: activeSection === s.id }" :aria-current="activeSection === s.id ? 'true' : undefined" :data-section="s.id" @click="jumpTo(s.id)">{{ s.label }}</button>
    </nav>

    <section id="settings-general" class="card section" aria-labelledby="settings-general-heading">
      <h2 id="settings-general-heading" tabindex="-1">{{ t('settings.general') }}</h2>
      <div class="row">
        <div class="row-text"><div class="row-title">{{ t('settings.language') }}</div></div>
        <select v-model="settings.language" class="input language-input" :aria-label="t('settings.language')">
          <option value="zh">简体中文</option><option value="en">English</option>
        </select>
      </div>
      <div class="row">
        <div class="row-text"><div class="row-title">{{ t('settings.appearance') }}</div><div class="row-desc">{{ t('settings.appearanceDesc') }}</div></div>
        <div class="segmented" role="group" :aria-label="t('settings.appearance')">
          <button v-for="opt in APPEARANCE_OPTIONS" :key="opt.value" :aria-pressed="settings.appearance === opt.value" :class="{ active: settings.appearance === opt.value }" @click="settings.appearance = opt.value">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="opt.icon" /></svg>
            {{ t(opt.labelKey) }}
          </button>
        </div>
      </div>
      <label class="toggle-row">
        <span class="toggle-text"><span class="row-title">{{ t('settings.usageStats') }}</span><span class="row-desc">{{ t('settings.usageStatsDesc') }}</span></span>
        <span class="switch"><input v-model="settings.usageStats" type="checkbox" role="switch" :aria-checked="settings.usageStats" /><span class="switch-track" aria-hidden="true"></span></span>
      </label>
    </section>

    <section id="settings-folder" class="card section" aria-labelledby="settings-folder-heading">
      <h2 id="settings-folder-heading" tabindex="-1">{{ t('settings.monitoredFolderTitle') }}</h2>
      <p class="section-desc">{{ t('settings.monitoredFolderDesc') }}</p>
      <div class="folder-status-box">
        <div class="folder-status-row">
          <div class="folder-status-info">
            <div class="folder-path-row">
              <AppIcon name="folder" :size="20" aria-hidden="true" />
              <strong class="folder-label">{{ folderLibrary?.status?.value?.folderLabel || t('folder.status.unconfigured') }}</strong>
              <span class="badge" :class="folderLibrary?.status?.value?.state || 'unconfigured'">
                {{ t('folder.status.' + (folderLibrary?.status?.value?.state === 'permission-denied' ? 'permissionDenied' : (folderLibrary?.status?.value?.state || 'unconfigured'))) }}
              </span>
            </div>
            <p v-if="!folderLibrary?.status?.value?.folderLabel || folderLibrary?.status?.value?.state === 'unconfigured'" class="folder-hint">
              {{ t('folder.status.unconfiguredHint') }}
            </p>
            <p v-else class="folder-stats">
              <span>{{ t('folder.indexedCount', { n: folderLibrary?.status?.value?.indexed ?? 0 }) }}</span>
              <span v-if="folderLibrary?.status?.value?.unavailable" class="unavailable-text"> · {{ t('folder.unavailableCount', { n: folderLibrary.status.value.unavailable }) }}</span>
            </p>
            <p v-if="folderLibrary?.status?.value?.error" class="folder-error" role="alert">
              {{ folderLibrary.status.value.error }}
            </p>
          </div>
          <div class="folder-actions">
            <button
              class="btn btn-primary"
              :disabled="folderLibrary?.status?.value?.state === 'scanning'"
              @click="onChooseMonitoredFolder"
            >
              {{ (!folderLibrary?.status?.value?.folderLabel || folderLibrary?.status?.value?.state === 'unconfigured') ? t('folder.choose') : t('folder.change') }}
            </button>
            <button
              v-if="folderLibrary?.status?.value?.folderLabel && folderLibrary?.status?.value?.state !== 'unconfigured'"
              class="btn"
              :disabled="folderLibrary?.status?.value?.state === 'scanning'"
              @click="onRescanMonitoredFolder"
            >
              <AppIcon name="refresh" :size="16" aria-hidden="true" />
              <span>{{ t('folder.rescan') }}</span>
            </button>
          </div>
        </div>
        <p class="folder-notice">
          {{ t('settings.monitoredFolderNotice') }}
        </p>
      </div>
    </section>

    <section id="settings-library-display" class="card section" aria-labelledby="settings-library-display-heading">
      <h2 id="settings-library-display-heading" tabindex="-1">{{ t('library.libraryDisplay') }}</h2>
      <div class="row">
        <label for="library-page-size" class="row-title">{{ t('library.pageSize') }}</label>
        <select id="library-page-size" v-model.number="libraryPageSize" class="input">
          <option :value="12">12</option><option :value="24">24</option>
        </select>
      </div>
    </section>

    <section id="settings-reading" class="card section" aria-labelledby="settings-reading-heading">
      <h2 id="settings-reading-heading" tabindex="-1">{{ t('settings.reading') }}</h2>
      <div class="row">
        <div class="row-text"><div class="row-title">{{ t('settings.pdfRenderer') }}</div><div class="row-desc">{{ t('settings.pdfRendererDesc') }}</div></div>
        <div class="segmented" role="group" :aria-label="t('settings.pdfRenderer')">
          <button :aria-pressed="settings.pdf.renderer === 'mupdf'" :class="{ active: settings.pdf.renderer === 'mupdf' }" @click="settings.pdf.renderer = 'mupdf'">MuPDF</button>
          <button :aria-pressed="settings.pdf.renderer === 'pdfium'" :class="{ active: settings.pdf.renderer === 'pdfium' }" @click="settings.pdf.renderer = 'pdfium'">PDFium</button>
        </div>
      </div>
      <div class="row row-inline">
        <div class="row-text"><div class="row-title">{{ t('settings.resetTypography') }}</div><div class="row-desc">{{ t('settings.resetTypographyDesc') }}</div></div>
        <button class="btn" @click="settings.resetReader(); toast(t('settings.resetDone'), 'success')">{{ t('settings.restoreDefault') }}</button>
      </div>
    </section>

    <section id="settings-ai" class="card section" aria-labelledby="settings-ai-heading">
      <h2 id="settings-ai-heading" tabindex="-1">{{ t('settings.aiTitle') }}</h2>
      <p class="section-desc">{{ t('settings.aiDesc') }}</p>
      <div class="field-grid">
        <div class="field field-wide">
          <AiProviderSelector />
        </div>
        <div class="field"><label class="field-label" for="ai-model">{{ t('settings.aiModelLabel') }}</label><input id="ai-model" v-model="settings.aiModel" class="input" autocapitalize="off" spellcheck="false" :placeholder="t('settings.aiModelPh')" /></div>
        <div v-if="aiShowBaseUrl" class="field field-wide"><label class="field-label" for="ai-base-url">{{ t('settings.aiBaseUrlLabel') }}</label><input id="ai-base-url" v-model="settings.aiBaseUrl" class="input" type="url" inputmode="url" autocapitalize="off" spellcheck="false" placeholder="https://api.siliconflow.cn/v1" /></div>
        <div class="field field-wide"><label class="field-label" for="ai-key">API Key</label><input id="ai-key" v-model="settings.aiApiKey" class="input" type="password" :placeholder="t('settings.aiKeyPh')" autocomplete="new-password" /></div>
      </div>
      <div class="ai-actions">
        <button class="btn btn-primary" :disabled="aiTesting || !settings.aiBaseUrl || !settings.aiModel" @click="testAi">{{ aiTesting ? t('settings.testing') : t('settings.aiTest') }}</button>
        <button v-if="!aiShowBaseUrl" type="button" class="link-btn" @click="aiBaseUrlOpen = true">{{ t('settings.aiEditBaseUrl') }}</button>
        <button v-if="aiDocsUrl" type="button" class="link-btn" @click="openAiDocs">{{ t('settings.aiGetKey') }}</button>
      </div>
      <div v-if="aiTestResult" class="status-info" role="status">{{ aiTestResult }}</div>
    </section>

    <section id="settings-data" class="card section" aria-labelledby="settings-data-heading">
      <h2 id="settings-data-heading" tabindex="-1">{{ t('settings.data') }}</h2>
      <div class="row"><div class="row-text"><div class="row-title">{{ t('settings.storageBackend') }}</div><div class="row-desc">{{ storageKind === 'filesystem' ? t('settings.storageDesktop') : t('settings.storageWeb') }}</div></div></div>
      <div v-if="isTauri()" class="row">
        <div class="row-text"><div class="row-title">{{ t('settings.storageLocation') }}</div><div class="row-desc">{{ t('settings.storageLocationDesc') }}<br />{{ t('common.current') }}: <code>{{ settings.libraryRoot || t('settings.defaultAppData') }}</code></div></div>
        <div class="location-actions"><button class="btn" :disabled="!!migrating" @click="changeLibraryRoot">{{ t('settings.changeLocation') }}</button><button v-if="settings.libraryRoot" class="btn btn-ghost" :disabled="!!migrating" @click="resetLibraryRoot">{{ t('settings.restoreDefault') }}</button></div>
      </div>
      <div v-if="migrating" class="status-info" role="status">{{ migrating }}</div>
      <div class="row row-inline">
        <div class="row-text"><div class="row-title">{{ t('settings.backupRestore') }}</div><div class="row-desc">{{ t('settings.backupDesc') }}</div></div>
        <div class="backup-actions"><button class="btn" :disabled="!!busy" @click="doExport">{{ t('settings.exportBackup') }}</button><button class="btn" :disabled="!!busy" @click="backupInput?.click()">{{ t('settings.importBackup') }}</button></div>
        <input ref="backupInput" type="file" accept=".okf.zip,.lightread,.zip" hidden @change="doImport" />
      </div>
      <div v-if="busy" class="status-info" role="status">{{ busy }}</div>
    </section>

    <section id="settings-network" class="card section" aria-labelledby="settings-network-heading">
      <h2 id="settings-network-heading" tabindex="-1">{{ t('settings.network') }}</h2>
      <template v-if="isTauri()">
        <p class="section-desc">{{ t('settings.proxyDesc') }}</p>
        <div class="proxy-row">
          <select v-model="proxy.scheme" class="input proxy-scheme" :aria-label="t('settings.proxyTitle')"><option v-for="s in PROXY_SCHEMES" :key="s.value" :value="s.value">{{ s.labelKey ? t(s.labelKey) : s.label }}</option></select>
          <input v-model="proxy.host" class="input proxy-host" :disabled="!proxy.scheme" :placeholder="t('settings.proxyHostPlaceholder')" :aria-label="t('settings.proxyHostPlaceholder')" autocapitalize="off" spellcheck="false" />
          <span class="proxy-colon">:</span><input v-model="proxy.port" class="input proxy-port" :disabled="!proxy.scheme" :placeholder="t('settings.proxyPort')" :aria-label="t('settings.proxyPort')" inputmode="numeric" />
        </div>
        <div v-if="proxy.scheme" class="proxy-auth">
          <input v-model="proxy.username" class="input" :placeholder="t('common.usernameOptional')" :aria-label="t('common.usernameOptional')" autocomplete="off" autocapitalize="off" spellcheck="false" />
          <input v-model="proxy.password" class="input" type="password" :placeholder="t('common.passwordOptional')" :aria-label="t('common.passwordOptional')" autocomplete="new-password" />
        </div>
      </template>
      <template v-else>
        <p class="section-desc">{{ t('settings.corsDesc1') }} {{ t('settings.corsDesc2pre') }} <code>{url}</code> {{ t('settings.corsDesc2post') }}</p>
        <div class="row"><label class="row-title" for="cors-proxy">{{ t('settings.corsTitle') }}</label><input id="cors-proxy" v-model="settings.corsProxy" class="input proxy-input" type="url" inputmode="url" autocapitalize="off" spellcheck="false" placeholder="https://your-proxy.example.com/?url={url}" /></div>
      </template>
      <div class="proxy-test"><button class="btn" :disabled="testing" @click="testProxy">{{ testing ? t('settings.testingProxy') : t('settings.testConnection') }}</button><span v-if="testResult" class="test-result" role="status">{{ testResult }}</span></div>
    </section>

    <section id="settings-about" class="card section" aria-labelledby="settings-about-heading">
      <h2 id="settings-about-heading" tabindex="-1">{{ t('settings.about') }}</h2>
      <div class="app-identity">
        <img class="app-icon" src="/pagewise-logo.png" alt="" aria-hidden="true" />
        <div class="app-meta"><div class="app-name">{{ t('app.fullName') }}<span class="version-chip">v{{ CURRENT_VERSION }}</span><span class="env-chip">{{ isTauri() ? t('settings.androidVersion') : t('settings.previewVersion') }}</span></div><div class="app-tagline">{{ t('app.description') }}</div><div class="app-tagline">{{ t('settings.tagline') }}</div><div class="app-tagline">{{ t('settings.upstreamCredit') }}</div></div>
        <div class="about-actions"><button class="btn" @click="$router.push('/manual')">{{ t('manual.title') }}</button></div>
      </div>
      <p class="section-desc about-formats">{{ t('settings.aboutFormats') }}</p>
      <p class="section-desc about-formats">{{ t('settings.author') }}: 云中江树 ({{ t('settings.wechat') }}: 云中江树) · {{ t('settings.license') }}: GNU AGPL v3.0+</p>
      <p class="about-links"><a href="https://github.com/yzfly/LightRead" target="_blank" rel="noopener noreferrer">{{ t('settings.repoLink') }}</a></p>
    </section>
  </div>
</template>

<style scoped>
.settings { max-width: 820px; margin: 0 auto; padding: 24px 28px calc(40px + var(--lr-safe-bottom)); }
h1 { margin: 0 0 20px; font-size: 24px; }
.settings-nav { position: sticky; top: 0; z-index: 10; display: flex; gap: 6px; overflow-x: auto; padding: 12px 0; margin-bottom: 16px; background: var(--bg); scrollbar-width: thin; }
.nav-chip { flex-shrink: 0; border: 1px solid var(--border); border-radius: var(--radius-pill); padding: 7px 14px; color: var(--text-2); background: var(--card); cursor: pointer; }
.nav-chip.active { color: var(--brand); background: var(--brand-light); border-color: var(--brand); }
.section { margin-bottom: 20px; padding: 24px; scroll-margin-top: 72px; }
h2 { font-size: 17px; margin: 0 0 18px; }
.section-desc { color: var(--text-2); font-size: 13px; line-height: 1.6; margin: 0 0 16px; }
.row, .toggle-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px 0; border-top: 1px solid var(--border); }
.row-text, .toggle-text { flex: 1; min-width: 0; }
.row-title { display: block; color: var(--text); font-size: 14px; }
.row-desc { display: block; color: var(--text-3); font-size: 12px; line-height: 1.6; margin-top: 4px; overflow-wrap: anywhere; }
.language-input { width: 150px; }
.segmented button { display: inline-flex; align-items: center; justify-content: center; gap: 5px; white-space: nowrap; }
.switch { position: relative; width: 40px; height: 24px; flex-shrink: 0; }
.switch input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: pointer; z-index: 1; }
.switch-track { position: absolute; inset: 0; border-radius: var(--radius-pill); background: var(--border-strong); }
.switch-track::after { content: ''; position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 50%; background: var(--on-brand); box-shadow: var(--shadow-sm); }
.switch input:checked + .switch-track { background: var(--brand); }
.switch input:checked + .switch-track::after { transform: translateX(16px); }
.switch input:focus-visible + .switch-track { outline: 2px solid var(--brand); outline-offset: 3px; }
.field-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.field { min-width: 0; }
.field-wide { grid-column: 1 / -1; }
.field-label { display: block; margin-bottom: 7px; color: var(--text-2); font-size: 13px; }
.field .input { width: 100%; }
.ai-actions, .backup-actions, .location-actions, .about-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.ai-actions { margin-top: 16px; }
.folder-status-box { background: var(--surface-2); border-radius: var(--radius); padding: 16px; margin-top: 12px; }
.folder-status-row { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 16px; }
.folder-path-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.folder-label { font-size: 15px; color: var(--text); }
.folder-hint, .folder-stats { margin: 6px 0 0; font-size: 13px; color: var(--text-2); }
.folder-error { margin: 6px 0 0; font-size: 13px; color: var(--danger); }
.folder-actions { display: flex; align-items: center; gap: 8px; }
.folder-notice { margin: 12px 0 0; padding-top: 10px; border-top: 1px dashed var(--border); font-size: 12px; color: var(--text-3); }
.badge.unconfigured { background: var(--surface-3); color: var(--text-2); }
.badge.idle { background: var(--brand-light); color: var(--brand); }
.badge.scanning { background: color-mix(in srgb, var(--brand) 20%, transparent); color: var(--brand); }
.badge.partial, .badge.permission-denied { background: color-mix(in srgb, var(--warning) 20%, transparent); color: var(--warning); }
.badge.error { background: color-mix(in srgb, var(--danger) 20%, transparent); color: var(--danger); }
.btn { min-height: 48px; display: inline-flex; align-items: center; gap: 6px; }
.link-btn { padding: 6px 0; border: none; background: none; color: var(--brand); cursor: pointer; font-size: 13px; }
.status-info { margin-top: 12px; padding: 10px 12px; border-radius: var(--radius-sm); background: var(--surface-2); color: var(--text-2); font-size: 13px; overflow-wrap: anywhere; }
.proxy-row { display: flex; align-items: center; gap: 8px; }
.proxy-scheme { width: 125px; }
.proxy-host { flex: 1; min-width: 0; }
.proxy-port { width: 80px; }
.proxy-colon { color: var(--text-3); }
.proxy-auth { display: flex; gap: 10px; margin-top: 12px; }
.proxy-auth .input { flex: 1; min-width: 0; }
.proxy-input { flex: 1; min-width: 0; }
.proxy-test { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; margin-top: 14px; }
.test-result { font-size: 13px; color: var(--text-2); overflow-wrap: anywhere; }
.app-identity { display: flex; align-items: center; flex-wrap: wrap; gap: 16px; }
.app-icon { width: 64px; height: 64px; border-radius: var(--radius); flex-shrink: 0; }
.app-meta { flex: 1; min-width: 180px; }
.app-name { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 18px; font-weight: 600; }
.version-chip, .env-chip { border-radius: var(--radius-pill); padding: 3px 7px; background: var(--surface-2); color: var(--text-2); font-size: 11px; font-weight: 400; }
.app-tagline { margin-top: 6px; font-size: 12px; line-height: 1.6; color: var(--text-3); }
.about-formats { margin: 20px 0 0; }
button:focus-visible, a:focus-visible { outline: 2px solid var(--brand); outline-offset: 3px; }
@media (max-width: 600px) {
  .settings { padding: 16px 12px calc(40px + var(--lr-safe-bottom)); }
  .section { padding: 18px 16px; }
  .row { flex-wrap: wrap; }
  .row-text { flex-basis: 100%; }
  .field-grid { grid-template-columns: minmax(0, 1fr); }
  .field-wide { grid-column: auto; }
  .proxy-row { flex-wrap: wrap; }
  .proxy-scheme { width: 100%; }
  .proxy-auth { flex-direction: column; }
  .backup-actions, .location-actions, .about-actions { width: 100%; }
  .backup-actions .btn, .location-actions .btn, .about-actions .btn { flex: 1; min-height: 40px; }
  .nav-chip { min-height: 40px; }
}
</style>
