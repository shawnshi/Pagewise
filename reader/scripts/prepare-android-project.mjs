import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// Generated Android XML needs no DTDs; reject unsupported constructs rather than
// partially rewriting a malformed manifest or resource document.
function validateXml(xml, rootName) {
  const tokens = xml.match(/<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<[^>]*>|[^<]+/g) ?? []
  if (tokens.join('') !== xml) throw new Error(`Malformed ${rootName} XML`)
  const stack = []
  let roots = 0
  for (const token of tokens) {
    if (token.startsWith('<!--') || token.startsWith('<?')) continue
    if (!token.startsWith('<')) {
      if ((!stack.length && token.trim()) || /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);)/.test(token)) throw new Error(`Malformed ${rootName} XML text`)
      continue
    }
    const close = token.match(/^<\/([\w:.-]+)\s*>$/)
    if (close) {
      if (stack.pop() !== close[1]) throw new Error(`Malformed ${rootName} XML closing tag`)
      continue
    }
    const open = token.match(/^<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"<>]*"|'[^'<>]*'))*)\s*(\/?)>$/)
    if (!open) throw new Error(`Malformed ${rootName} XML tag`)
    const attrs = [...open[2].matchAll(/([\w:.-]+)\s*=/g)].map(match => match[1])
    if (new Set(attrs).size !== attrs.length) throw new Error(`Duplicate ${rootName} XML attribute`)
    if (!stack.length && (++roots !== 1 || open[1] !== rootName)) throw new Error(`Expected ${rootName} XML root`)
    if (!open[3]) stack.push(open[1])
  }
  if (stack.length || roots !== 1) throw new Error(`Incomplete ${rootName} XML`)
}

function regularFile(path) {
  if (!lstatSync(path).isFile()) throw new Error(`Expected regular file: ${path}`)
  return readFileSync(path)
}

function iconFiles(source, target) {
  if (!lstatSync(source).isDirectory()) throw new Error(`Expected icon directory: ${source}`)
  return readdirSync(source, { withFileTypes: true }).flatMap(entry => {
    const from = join(source, entry.name)
    const to = join(target, entry.name)
    if (entry.isDirectory()) return iconFiles(from, to)
    if (!entry.isFile()) throw new Error(`Unsupported icon entry: ${from}`)
    return [{ path: to, data: regularFile(from) }]
  })
}

export function prepareAndroidProject(base = root, { replace = renameSync, restore = renameSync } = {}) {
  let config
  try {
    config = JSON.parse(regularFile(join(base, 'src-tauri/tauri.conf.json')).toString('utf8'))
  } catch (error) {
    throw new Error(`Invalid Android configuration: ${error.message}`, { cause: error })
  }
  if (config.identifier !== 'io.pagewise.reader') throw new Error('Unexpected Android application identity')
  if (typeof config.productName !== 'string' || !config.productName.trim() || /[\x00-\x1f]/.test(config.productName)) throw new Error('Invalid Android product name')
  const project = join(base, 'src-tauri/gen/android')
  const pkg = JSON.parse(regularFile(join(base, 'package.json')).toString('utf8'))
  if (pkg.scripts?.android !== 'tauri android') throw new Error('Unsupported Android npm entry')
  const bridgePath = join(project, 'buildSrc/src/main/java/io/pagewise/reader/kotlin/BuildTask.kt')
  const bridge = regularFile(bridgePath).toString('utf8')
  const legacyArgs = 'listOf("run", "--", "tauri", "android", "android-studio-script")'
  const androidArgs = 'listOf("run", "--", "android", "android-studio-script")'
  const argLines = [...bridge.matchAll(/^[ \t]*val args = (listOf\([^\r\n]*\));?[ \t]*\r?$/gm)]
  if (!bridge.includes('val executable = """npm"""') || argLines.length !== 1 || ![legacyArgs, androidArgs].includes(argLines[0][1])) {
    throw new Error('Unsupported native build bridge')
  }
  // Generated Tauri assumes a generic npm script removed by this Android-only fork.
  const preparedBridge = bridge.replace(legacyArgs, androidArgs)
  const resources = join(project, 'app/src/main/res')
  const activity = join(project, 'app/src/main/java', ...config.identifier.split('.'), 'MainActivity.kt')
  const strings = join(resources, 'values/strings.xml')
  const manifest = join(project, 'app/src/main/AndroidManifest.xml')
  const template = regularFile(join(base, 'src-tauri/android/MainActivity.kt'))
  const kotlin = template.toString('utf8')
  if (!/^package io\.pagewise\.reader\s*\r?\n/.test(kotlin) || !/class MainActivity\s*:\s*TauriActivity\(\)/.test(kotlin) || /LightReadUpdater|UpdaterBridge|REQUEST_INSTALL_PACKAGES/.test(kotlin)) throw new Error('Invalid MainActivity template')
  const nativeFolderTemplates = readdirSync(join(base, 'src-tauri/android')).filter(name => name !== 'MainActivity.kt' && name.endsWith('.kt')).map(name => {
    if (!['MonitoredFolderPlugin.kt', 'ExportPlugin.kt', 'SystemTtsPlugin.kt', 'NativeSpeechService.kt', 'ReaderWindowState.kt', 'OnyxSdkBridge.kt'].includes(name)) throw new Error(`Unsupported Android template: ${name}`)
    const data = regularFile(join(base, 'src-tauri/android', name))
    const source = data.toString('utf8')
    if (name === 'MonitoredFolderPlugin.kt') {
      if (!/^package io\.pagewise\.reader\s*\r?\n/.test(source) || !/@TauriPlugin\b/.test(source) || !/class MonitoredFolderPlugin\b/.test(source)) throw new Error('Invalid monitored-folder template')
    } else if (name === 'ExportPlugin.kt') {
      if (!/^package io\.pagewise\.reader\s*\r?\n/.test(source) || !/@TauriPlugin\b/.test(source) || !/class ExportPlugin\b/.test(source)) throw new Error('Invalid export template')
    } else if (name === 'ReaderWindowState.kt') {
      if (!/^package io\.pagewise\.reader\s*\r?\n/.test(source) || !/class ReaderWindowState\b/.test(source)) throw new Error('Invalid reader window template')
    } else if (name === 'OnyxSdkBridge.kt') {
      if (!/^package io\.pagewise\.reader\s*\r?\n/.test(source) || !/class OnyxSdkBridge\b/.test(source)) throw new Error('Invalid Onyx SDK bridge template')
    } else if (name === 'NativeSpeechService.kt') {
      if (!/^package io\.pagewise\.reader\s*\r?\n/.test(source) || !/class SystemTtsService\b/.test(source)) throw new Error('Invalid speech service template')
    } else if (!/^package io\.pagewise\.reader\s*\r?\n/.test(source) || !/@TauriPlugin\b/.test(source) || !/class SystemTtsPlugin\b/.test(source)) {
      throw new Error('Invalid system TTS template')
    }
    return { path: join(dirname(activity), name), data }
  })
  if (/ReaderWindowState\s*\(/.test(kotlin) && !nativeFolderTemplates.some(template => template.path.endsWith('ReaderWindowState.kt'))) throw new Error('Missing reader window template')
  const currentStrings = regularFile(strings).toString('utf8')
  const currentManifest = regularFile(manifest).toString('utf8')
  validateXml(currentStrings, 'resources')
  validateXml(currentManifest, 'manifest')
  if (!/<provider\b[^>]*android:name="androidx\.core\.content\.FileProvider"[^>]*>/.test(currentManifest) || !currentManifest.includes('android:authorities="${applicationId}.fileprovider"')) throw new Error('Android manifest is missing the shared FileProvider')
  const label = config.productName.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", "\\'")
  const names = new Set()
  const values = currentStrings.replace(/(<string\b[^>]*\bname="(app_name|main_activity_title)"[^>]*>)[^<]*(<\/string>)/g, (_, opening, name, closing) => {
    if (names.has(name)) throw new Error(`Duplicate Android resource: ${name}`)
    names.add(name)
    return opening + label + closing
  })
  if (names.size !== 2) throw new Error('Expected Android application-name resources were not found')
  let nextManifest = currentManifest.replace(/<uses-permission\b(?=[^>]*\bandroid:name\s*=\s*["']android\.permission\.REQUEST_INSTALL_PACKAGES["'])[^>]*(?:\/>|>\s*<\/uses-permission>)/g, '')
  if (nextManifest.includes('android.permission.REQUEST_INSTALL_PACKAGES')) throw new Error('Unsupported install-permission declaration')
  // Never declare a native service if the corresponding source is absent.
  if (nativeFolderTemplates.some(template => template.path.endsWith('SystemTtsPlugin.kt'))) {
    for (const permission of ['android.permission.FOREGROUND_SERVICE', 'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK', 'android.permission.POST_NOTIFICATIONS', 'android.permission.WAKE_LOCK']) {
      if (!nextManifest.includes(`android:name="${permission}"`)) nextManifest = nextManifest.replace(/<application\b/, `<uses-permission android:name="${permission}" />\n    <application`)
    }
    if (!nextManifest.includes('android:name=".SystemTtsService"')) {
      nextManifest = nextManifest.replace(/<\/application>/, '    <service android:name=".SystemTtsService" android:foregroundServiceType="mediaPlayback" android:exported="false" />\n  </application>')
    }
  }
  validateXml(values, 'resources')
  validateXml(nextManifest, 'manifest')
  const icons = iconFiles(join(base, 'src-tauri/icons/android'), resources)
  if (!icons.length) throw new Error('Android branding resources are missing')
  const entries = [...icons, { path: activity, data: template }, ...nativeFolderTemplates, { path: strings, data: Buffer.from(values) }, { path: manifest, data: Buffer.from(nextManifest) }, { path: bridgePath, data: Buffer.from(preparedBridge) }]
  // Snapshot and validate every destination before creating directories or staging.
  for (const entry of entries) {
    entry.previous = existsSync(entry.path) ? regularFile(entry.path) : null
    let parent = dirname(entry.path)
    while (parent !== project) {
      if (existsSync(parent) && !lstatSync(parent).isDirectory()) throw new Error(`Invalid managed directory: ${parent}`)
      parent = dirname(parent)
    }
  }
  const stage = mkdtempSync(join(project, '.pagewise-prepare-'))
  const created = []
  const committed = []
  let preserveStage = false
  try {
    for (const [index, entry] of entries.entries()) {
      entry.staged = join(stage, `${index}.next`)
      entry.backup = join(stage, `${index}.previous`)
      writeFileSync(entry.staged, entry.data)
      if (entry.previous !== null) writeFileSync(entry.backup, entry.previous)
    }
    for (const entry of entries) {
      const missing = []
      for (let parent = dirname(entry.path); !existsSync(parent); parent = dirname(parent)) missing.unshift(parent)
      for (const directory of missing) { mkdirSync(directory); created.push(directory) }
      replace(entry.staged, entry.path)
      committed.push(entry)
    }
  } catch (error) {
    const failures = []
    for (const entry of committed.slice().reverse()) {
      try {
        if (entry.previous === null) rmSync(entry.path)
        else restore(entry.backup, entry.path)
      } catch (rollbackError) { failures.push(`${entry.path}: ${rollbackError.message}`) }
    }
    for (const directory of created.slice().reverse()) {
      try { rmdirSync(directory) } catch (rollbackError) { failures.push(`${directory}: ${rollbackError.message}`) }
    }
    if (failures.length) {
      preserveStage = true
      throw new AggregateError([error], `Preparation failed: ${error.message}; rollback failed: ${failures.join('; ')}; recovery files: ${stage}`)
    }
    throw error
  } finally {
    if (!preserveStage) rmSync(stage, { recursive: true, force: true })
  }
  return `Android resources prepared: ${config.identifier}, ${config.productName}`
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(prepareAndroidProject()) } catch (error) {
    console.error(`Android project preparation failed: ${error.message}`)
    process.exitCode = 1
  }
}
