import { randomUUID } from 'node:crypto'
import { realpathSync, lstatSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const readerRoot = fileURLToPath(new URL('../', import.meta.url))
const workspace = resolve(readerRoot, '..')

// Resolve the existing prefix too: a not-yet-created child can traverse a junction.
function physicalPath(path) {
  const suffix = []
  let current = resolve(path)
  for (;;) {
    try { return resolve(realpathSync(current), ...suffix) } catch (error) {
      if (error.code !== 'ENOENT') throw error
      try {
        if (lstatSync(current).isSymbolicLink()) throw new Error(`Dangling path alias: ${current}`)
      } catch (statError) { if (statError.code !== 'ENOENT') throw statError }
      const parent = dirname(current)
      if (parent === current) throw error
      suffix.unshift(relative(parent, current))
      current = parent
    }
  }
}

function within(base, path) {
  const rel = relative(base, path)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

function rejectDependencies(path) {
  const absolute = resolve(path)
  const physical = physicalPath(absolute)
  if ([absolute, physical].some(value => value.split(/[\\/]/).some(part => part.toLowerCase() === 'node_modules'))
    || within(physicalPath(resolve(readerRoot, 'node_modules')), physical)) {
    throw new Error(`Vite path must not resolve into node_modules: ${path}`)
  }
  return physical
}

export function isolatedCacheDir(base = resolve(workspace, '.cache/vite'), root = readerRoot) {
  rejectDependencies(root)
  const absolute = resolve(root, base)
  const physical = rejectDependencies(absolute)
  if (!within(resolve(workspace, '.cache'), absolute)
    || !within(resolve(physicalPath(workspace), '.cache'), physical)) {
    throw new Error(`Vite cache must stay in this workspace's .cache: ${base}`)
  }
  const child = resolve(absolute, `${process.pid}-${randomUUID()}`)
  rejectDependencies(child)
  return child
}

export async function createServer(inlineConfig = {}) {
  const root = inlineConfig.root === undefined ? readerRoot : resolve(inlineConfig.root)
  // Validate before loading a config or allowing any cache mkdir.
  const cacheDir = isolatedCacheDir(inlineConfig.cacheDir, root)
  const { createServer: viteCreateServer } = await import('vite')
  return viteCreateServer({ ...inlineConfig, root, configLoader: 'runner', cacheDir })
}

// The retirement fixture also uses Vite's path utility, not another startup API.
export { normalizePath } from 'vite'
