import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'

const hash = data => createHash('sha256').update(data).digest('hex')
const regular = path => {
  if (!lstatSync(path).isFile()) throw new Error(`Expected regular SDK source: ${path}`)
  return readFileSync(path)
}
const relative = name => {
  if (typeof name !== 'string' || isAbsolute(name) || name.includes('\\') || name.includes(':') || name.includes('\0') || name.split('/').some(p => p === '..' || !p)) throw new Error('Invalid SDK source path')
  return name
}

// Return entries for the existing atomic Android preparation transaction. Never write Cargo files.
export function tauriLifecycleEntries(base, project, upstream) {
  const source = join(base, 'src-tauri/android-sdk/tauri-2.11.5')
  let pin
  try { pin = JSON.parse(regular(join(source, 'upstream.json')).toString('utf8')) }
  catch (error) { throw new Error('Invalid lifecycle SDK pin', { cause: error }) }
  if (!pin.moduleFiles || !Array.isArray(pin.replacements) || !Array.isArray(pin.extraSources) ||
      new Set([...Object.keys(pin.moduleFiles), ...pin.extraSources]).size !== Object.keys(pin.moduleFiles).length + pin.extraSources.length) throw new Error('Invalid lifecycle SDK pin schema')
  const packages = regular(join(base, 'src-tauri/Cargo.lock')).toString('utf8').split(/^\[\[package\]\]\s*$/m)
  const tauri = packages.filter(p => /^name = "tauri"\s*$/m.test(p))
  if (pin.tauriVersion !== '2.11.5' || tauri.length !== 1 || !/^version = "2\.11\.5"\s*$/m.test(tauri[0])) throw new Error('Lifecycle overlay requires locked Tauri 2.11.5')
  const target = resolve(project, 'native-sdk/tauri-android')
  if (!target.startsWith(resolve(project) + sep)) throw new Error('SDK overlay escapes generated project')
  const entries = [], original = {}, patched = {}
  for (const [name, expected] of Object.entries(pin.moduleFiles)) {
    relative(name)
    const data = regular(join(upstream, name))
    if (!/^[a-f0-9]{64}$/.test(expected) || hash(data) !== expected) throw new Error(`Pinned SDK source changed: ${name}`)
    original[name] = expected
    let replacement = pin.replacements.includes(name) ? regular(join(source, name.split('/').at(-1))) : data
    for (const edit of pin.inlineEdits?.[name] ?? []) {
      const text = replacement.toString('utf8')
      if (!edit.old || typeof edit.new !== 'string' || text.split(edit.old).length !== 2) throw new Error(`Unsupported SDK inline patch: ${name}`)
      replacement = Buffer.from(text.replace(edit.old, edit.new))
    }
    if (pin.replacements.includes(name) || pin.inlineEdits?.[name]) patched[name] = hash(replacement)
    entries.push({ path: join(target, name), data: replacement })
  }
  for (const name of Object.keys(pin.inlineEdits ?? {})) {
    relative(name)
    if (!Object.hasOwn(pin.moduleFiles, name) || pin.replacements.includes(name)) throw new Error('Inline edit has no distinct upstream pin')
  }
  for (const name of pin.replacements) {
    relative(name)
    if (!Object.hasOwn(pin.moduleFiles, name)) throw new Error('Replacement has no upstream pin')
  }
  for (const name of pin.extraSources) {
    relative(name)
    if (Object.hasOwn(pin.moduleFiles, name)) throw new Error('Extra SDK source shadows an upstream file')
    const data = regular(join(source, name.split('/').at(-1)))
    patched[name] = hash(data)
    entries.push({ path: join(target, name), data })
  }
  const listed = new Set([...pin.replacements, ...pin.extraSources].map(p => p.split('/').at(-1)))
  for (const item of readdirSync(source, { withFileTypes: true })) {
    if (item.name === 'upstream.json' || item.name === 'README.md') continue
    if (!item.isFile() || !listed.has(item.name)) throw new Error(`Unmanaged lifecycle source: ${item.name}`)
  }
  entries.push({ path: join(target, 'pagewise-provenance.json'), data: Buffer.from(JSON.stringify({ version: pin.tauriVersion, upstream: original, patched, globalCacheWritten: false }, null, 2) + '\n') })
  return entries
}
