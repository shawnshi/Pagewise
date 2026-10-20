import { existsSync, lstatSync, readFileSync, writeFileSync, readdirSync, mkdirSync, mkdtempSync, renameSync, rmSync, rmdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function androidVariantMetadata(version, productName = '知页') {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version)
  if (!match) throw new Error('Expected a stable three-part Android version')
  const [major, minor, patch] = match.slice(1).map(Number)
  const versionCode = major * 1_000_000 + minor * 1_000 + patch
  if (!Number.isSafeInteger(versionCode) || versionCode < 1 || versionCode > 2_100_000_000 || minor > 999 || patch > 999) throw new Error('Android version code is out of range')
  if (typeof productName !== 'string' || !productName.trim() || /[\x00-\x1f]/.test(productName)) throw new Error('Invalid Android product label')
  return { versionName: version, versionCode, releaseLabel: productName, debugLabel: `${productName} ${version} 测试版` }
}

function regularFile(path) {
  if (!lstatSync(path).isFile()) throw new Error(`Expected a regular managed file: ${path}`)
  return readFileSync(path)
}
const xml = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", "\\'")

export function prepareAndroidVariants(base = fileURLToPath(new URL('../', import.meta.url)), { replace = renameSync, restore = renameSync } = {}) {
  let pkg, config
  try {
    pkg = JSON.parse(regularFile(join(base, 'package.json')).toString('utf8'))
    config = JSON.parse(regularFile(join(base, 'src-tauri/tauri.conf.json')).toString('utf8'))
  } catch (error) {
    throw new Error('Invalid Android variant configuration', { cause: error })
  }
  if (config.identifier !== 'io.pagewise.reader' || pkg.version !== config.version) throw new Error('Android identity or root versions do not agree')
  const metadata = androidVariantMetadata(pkg.version, config.productName)
  const project = join(base, 'src-tauri/gen/android')
  const app = join(project, 'app')
  const gradlePath = join(app, 'build.gradle.kts')
  let gradle = regularFile(gradlePath).toString('utf8')
  if (!/\bnamespace\s*=\s*"io\.pagewise\.reader"/.test(gradle) || !/\bapplicationId\s*=\s*"io\.pagewise\.reader"/.test(gradle)) throw new Error('Unexpected Gradle application identity')
  const debug = [...gradle.matchAll(/getByName\("debug"\)\s*\{/g)]
  const release = [...gradle.matchAll(/getByName\("release"\)\s*\{/g)]
  if (debug.length !== 1 || release.length !== 1 || debug[0].index >= release[0].index) throw new Error('Unsupported Android build-type structure')
  const suffixes = [...gradle.matchAll(/\bapplicationIdSuffix\s*=\s*"([^"]*)"/g)]
  if (suffixes.length > 1 || (gradle.includes('applicationIdSuffix') && suffixes.length !== 1)
    || suffixes.some(m => m[1] !== '.debug' || m.index < debug[0].index || m.index > release[0].index)) throw new Error('Refusing an unexpected application ID suffix')
  if (!suffixes.length) gradle = gradle.replace(debug[0][0], `${debug[0][0]}${gradle.includes('\r\n') ? '\r\n' : '\n'}            applicationIdSuffix = ".debug"`)
  const propertiesPath = join(app, 'tauri.properties')
  let properties = existsSync(propertiesPath) ? regularFile(propertiesPath).toString('utf8') : ''
  for (const [key, value] of [['versionName', metadata.versionName], ['versionCode', metadata.versionCode]]) {
    const pattern = new RegExp(`^tauri\\.android\\.${key}=[^\\r\\n]*`, 'gm')
    const matches = [...properties.matchAll(pattern)]
    if (matches.length > 1) throw new Error('Duplicate Android version property')
    properties = matches.length ? properties.replace(pattern, `tauri.android.${key}=${value}`) : `${properties}${properties && !properties.endsWith('\n') ? '\n' : ''}tauri.android.${key}=${value}\n`
  }
  const entries = [{ path: gradlePath, data: Buffer.from(gradle) }, { path: propertiesPath, data: Buffer.from(properties) }]
  for (const [variant, label] of [['debug', metadata.debugLabel], ['release', metadata.releaseLabel]]) {
    const values = join(app, `src/${variant}/res/values`)
    const path = join(values, 'pagewise_variant.xml')
    if (existsSync(values)) {
      for (const name of readdirSync(values).filter(name => name.endsWith('.xml') && name !== 'pagewise_variant.xml')) {
        if (/\bname\s*=\s*["'](?:app_name|main_activity_title)["']/.test(regularFile(join(values, name)).toString('utf8'))) throw new Error('Conflicting variant label resource')
      }
    }
    entries.push({ path, data: Buffer.from(`<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <string name="app_name">${xml(label)}</string>\n    <string name="main_activity_title">${xml(label)}</string>\n</resources>\n`) })
  }
  for (const entry of entries) {
    entry.previous = existsSync(entry.path) ? regularFile(entry.path) : null
    for (let parent = dirname(entry.path); parent !== project; parent = dirname(parent)) {
      if (existsSync(parent) && !lstatSync(parent).isDirectory()) throw new Error(`Invalid managed directory: ${parent}`)
    }
  }
  const stage = mkdtempSync(join(project, '.pagewise-variants-'))
  const created = [], committed = []
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
      for (const parent of missing) { mkdirSync(parent); created.push(parent) }
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
    for (const parent of created.slice().reverse()) {
      try { rmdirSync(parent) } catch (rollbackError) { failures.push(`${parent}: ${rollbackError.message}`) }
    }
    if (failures.length) {
      preserveStage = true
      throw new AggregateError([error], `Variant preparation failed; rollback failed: ${failures.join('; ')}; recovery: ${stage}`)
    }
    throw error
  } finally {
    if (!preserveStage) rmSync(stage, { recursive: true, force: true })
  }
  return metadata
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(prepareAndroidVariants())) } catch (error) { console.error(error.message); process.exitCode = 1 }
}
