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
    if (!['MonitoredFolderPlugin.kt', 'MonitoredFolderIo.kt', 'NativeFileJobs.kt', 'ExportPlugin.kt', 'SystemTtsPlugin.kt', 'NativeSpeechService.kt', 'ReaderWindowState.kt', 'OnyxSdkBridge.kt', 'NativeBookMetadata.kt', 'NativeMobiLocales.kt', 'NativePdfMetadata.kt', 'NativeImportDatabase.kt', 'NativeBookImporter.kt', 'NativeStateStore.kt', 'NativeStatePlugin.kt', 'NativePagesController.kt', 'NativeManualRenderer.kt', 'NativeLibraryRepository.kt', 'NativeManagementDispatcher.kt', 'NativeManagementHost.kt', 'NativePagesPlugin.kt', 'NativeClassificationEditor.kt', 'NativeNoteEditor.kt', 'NativeSettingsPanel.kt', 'NativePageVisibility.kt', 'NativeStatsPanel.kt', 'NativeLibraryPanel.kt'].includes(name)) throw new Error(`Unsupported Android template: ${name}`)




    const data = regularFile(join(base, 'src-tauri/android', name))
    const source = data.toString('utf8')
    if (name === 'MonitoredFolderPlugin.kt') {
      if (!/^package io\.pagewise\.reader\s*\r?\n/.test(source) || !/@TauriPlugin\b/.test(source) || !/class MonitoredFolderPlugin\b/.test(source)) throw new Error('Invalid monitored-folder template')
    } else if (name === 'MonitoredFolderIo.kt') {
      if (!/^package io\.pagewise\.reader\s*\r?\n/.test(source) || !/class MonitoredFolderIo\b/.test(source)) throw new Error('Invalid monitored-folder IO template')
    } else if (name === 'NativeFileJobs.kt') {
      if (!/^package io\.pagewise\.reader\s*\r?\n/.test(source) || !/class NativeFileJobService\b/.test(source)) throw new Error('Invalid native file service template')
    } else if (['NativeStateStore.kt', 'NativeStatePlugin.kt', 'NativePagesController.kt', 'NativeManualRenderer.kt', 'NativeLibraryRepository.kt', 'NativeManagementDispatcher.kt', 'NativeManagementHost.kt', 'NativePagesPlugin.kt', 'NativeClassificationEditor.kt', 'NativeNoteEditor.kt', 'NativeSettingsPanel.kt', 'NativePageVisibility.kt', 'NativeStatsPanel.kt', 'NativeLibraryPanel.kt'].includes(name)) {




      const symbol = name.replace(/\.kt$/, '')
      if (!/^package io\.pagewise\.reader\s*\r?\n/.test(source) || !source.includes(`class ${symbol}`) || (name.endsWith('Plugin.kt') && !/@TauriPlugin\b/.test(source))) throw new Error(`Invalid native state template: ${name}`)
    } else if (['NativeBookMetadata.kt', 'NativeMobiLocales.kt', 'NativePdfMetadata.kt', 'NativeImportDatabase.kt', 'NativeBookImporter.kt'].includes(name)) {
      const symbol = name === 'NativeMobiLocales.kt' ? 'nativeMobiLocales' : name.replace(/\.kt$/, '')
      if (!/^package io\.pagewise\.reader\s*\r?\n/.test(source) || !source.includes(symbol)) throw new Error(`Invalid native import template: ${name}`)
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
  if (nativeFolderTemplates.some(template => template.path.endsWith('NativeFileJobs.kt'))) {
    if (!nativeFolderTemplates.some(template => template.path.endsWith('MonitoredFolderIo.kt'))) throw new Error('Missing monitored-folder IO template')
    for (const permission of ['android.permission.FOREGROUND_SERVICE', 'android.permission.FOREGROUND_SERVICE_DATA_SYNC', 'android.permission.POST_NOTIFICATIONS']) {
      if (!nextManifest.includes(`android:name="${permission}"`)) nextManifest = nextManifest.replace(/<application\b/, `<uses-permission android:name="${permission}" />\n    <application`)
    }
    if (!nextManifest.includes('android:name=".NativeFileJobService"')) {
      nextManifest = nextManifest.replace(/<\/application>/, '    <service android:name=".NativeFileJobService" android:foregroundServiceType="dataSync" android:exported="false" />\n  </application>')
    }
  }
  validateXml(values, 'resources')
  validateXml(nextManifest, 'manifest')
  const icons = iconFiles(join(base, 'src-tauri/icons/android'), resources)
  if (!icons.length) throw new Error('Android branding resources are missing')
  const importEntries = []
  if (nativeFolderTemplates.some(template => template.path.endsWith('NativeBookMetadata.kt'))) {
    const version = regularFile(join(base, 'src-tauri/android/kotlin-version.txt')).toString('utf8').trim()
    if (version !== '2.4.20') throw new Error('Expected project-local Kotlin 2.4.20')
    const rootBuildPath = join(project, 'build.gradle.kts')
    const rootBuild = regularFile(rootBuildPath).toString('utf8')
    const matches = [...rootBuild.matchAll(/org\.jetbrains\.kotlin:kotlin-gradle-plugin:([0-9.]+)/g)]
    if (matches.length !== 1 || !['1.9.25', '2.4.0', version].includes(matches[0][1])) throw new Error('Unsupported existing Kotlin build configuration')
    const appBuildPath = join(project, 'app/build.gradle.kts')
    let appBuild = regularFile(appBuildPath).toString('utf8')
    const kotlinOptions = /    kotlinOptions\s*\{\s*jvmTarget = "1\.8"\s*\}/
    const compilerDsl = text => {
      if (kotlinOptions.test(text)) return text.replace(kotlinOptions, '') + '\nkotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_1_8) } }\n'
      if (text.includes('JvmTarget.JVM_1_8')) return text
      throw new Error('Unsupported Kotlin JVM target')
    }
    appBuild = compilerDsl(appBuild)
    const applyImport = 'apply(from = "native-import.gradle.kts")'
    if (!appBuild.includes(applyImport)) {
      const anchor = 'apply(from = "tauri.build.gradle.kts")'
      if (appBuild.split(anchor).length !== 2) throw new Error('Unsupported generated Android dependency script')
      appBuild = appBuild.replace(anchor, applyImport + '\n\n' + anchor)
    }
    const dependencyTemplate = regularFile(join(base, 'src-tauri/android/native-import.gradle.kts'))
    const dependencies = dependencyTemplate.toString('utf8')
    if (!dependencies.includes('io.legere:pdfiumandroid:1.0.35') || !dependencies.includes('org.commonmark:commonmark:0.21.0')) throw new Error('Unexpected native import dependencies')
    const settingsPath = join(project, 'settings.gradle')
    let settings = regularFile(settingsPath).toString('utf8')
    if (!settings.includes("apply from: 'tauri.settings.gradle'")) throw new Error('Unsupported Tauri module settings')
    if (!settings.includes("apply from: 'native-settings.gradle'")) settings += "\napply from: 'native-settings.gradle'\n"
    const modules = regularFile(join(project, 'tauri.settings.gradle')).toString('utf8').split('\n').filter(line => line.includes('.projectDir = new File('))
    const expected = new Set(['tauri-android', 'tauri-plugin-dialog', 'tauri-plugin-fs', 'tauri-plugin-opener'])
    for (const line of modules) {
      const name = line.split("'")[1].replace(/^:/, '')
      if (!expected.delete(name)) throw new Error(`Unsupported Tauri Kotlin module: ${name}`)
      const literal = line.slice(line.indexOf('new File(') + 9, line.lastIndexOf(')'))
      const upstream = regularFile(join(JSON.parse(literal), 'build.gradle.kts')).toString('utf8')
      const adapter = compilerDsl(upstream) + '\nlayout.buildDirectory.set(rootProject.layout.buildDirectory.dir("native-modules/" + project.name))\n'
      importEntries.push({ path: join(project, 'native-gradle', name + '.gradle.kts'), data: Buffer.from(adapter) })
    }
    if (expected.size) throw new Error('Missing expected Tauri Kotlin modules')
    importEntries.push({ path: rootBuildPath, data: Buffer.from(rootBuild.replace(matches[0][0], `org.jetbrains.kotlin:kotlin-gradle-plugin:${version}`)) },
      { path: appBuildPath, data: Buffer.from(appBuild) }, { path: join(project, 'app/native-import.gradle.kts'), data: dependencyTemplate },
      { path: settingsPath, data: Buffer.from(settings) }, { path: join(project, 'native-settings.gradle'), data: regularFile(join(base, 'src-tauri/android/native-settings.gradle')) })
  }
  const manualEntries = []
  if (nativeFolderTemplates.some(entry => entry.path.endsWith('NativeManualRenderer.kt'))) {
    for (const name of ['README.md', '01-读书方法.md', '02-阅读模式.md', '03-声音.md', '04-使用说明.md', '05-伴读.md']) {
      const data = regularFile(join(base, 'docs/manual', name))
      if (data.byteLength > 1024 * 1024 || !Buffer.from(data.toString('utf8')).equals(data)) throw new Error(`Invalid offline manual chapter: ${name}`)
      manualEntries.push({ path: join(project, 'app/src/main/assets/manual', name), data })
    }
  }
  const entries = [...icons, { path: activity, data: template }, ...nativeFolderTemplates, ...importEntries, ...manualEntries, { path: strings, data: Buffer.from(values) }, { path: manifest, data: Buffer.from(nextManifest) }, { path: bridgePath, data: Buffer.from(preparedBridge) }]
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
