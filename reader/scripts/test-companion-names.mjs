import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const root = fileURLToPath(new URL('../../', import.meta.url))
const files = () => [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
  cwd: root, encoding: 'utf8',
}).split('\0').filter(Boolean))]
const legacyContracts = [
  'lightread-dianjing', 'dianjingPromptVersion', '/v1/dianjing', '/dianjing',
]

// Negative assertions and old-format fixture payloads intentionally contain the retired names.
const legacyFixtures = new Set([
  'reader/scripts/test-companion-compat.mjs',
  'reader/scripts/test-companion-names.mjs',
  'reader/src/services/PagewiseCompanion/compatibility.ts',
])

test('active module, test and manual filenames use the canonical companion name', () => {
  const stale = files().filter(path => /dianjing|点睛|點睛/i.test(path) && existsSync(resolve(root, path)))
  assert.deepEqual(stale, [])
  for (const path of [
    'reader/docs/pagewise-companion.md', 'reader/docs/manual/05-伴读.md',
    'reader/scripts/test-companion.mjs', 'reader/scripts/test-companion-boundaries.mjs',
  ]) assert.ok(existsSync(resolve(root, path)), path)
})

test('source and documentation have no retired product names outside explicit compatibility contracts', () => {
  const violations = []
  for (const path of files()) {
    if (legacyFixtures.has(path) || !/\.(?:md|ts|vue|js|mjs|sql|toml|json)$/.test(path)
      || path.endsWith('package-lock.json') || path.includes('/vendor/') || path.includes('/src/data/')
      || !existsSync(resolve(root, path))) continue
    const lines = readFileSync(resolve(root, path), 'utf8').split(/\r?\n/)
    lines.forEach((line, index) => {
      let text = line
      for (const wire of legacyContracts) text = text.replaceAll(wire, '')
      if (/点睛|點睛|dianjing/i.test(text)) violations.push(`${path}:${index + 1}`)
    })
  }
  assert.deepEqual(violations, [])
})

test('runtime companion modules expose descriptive types and helpers, not the old Dj abbreviations', () => {
  const violations = []
  for (const path of files()) {
    if (!(path.startsWith('reader/src/services/PagewiseCompanion/') || path === 'reader/src/composables/usePagewiseCompanion.ts')
      || !existsSync(resolve(root, path))) continue
    const text = readFileSync(resolve(root, path), 'utf8')
    for (const match of text.matchAll(/\b(?:Dj[A-Z]\w*|DJ_[A-Z_]+|\w+Dj[A-Z]\w*|dj[A-Z]\w*)\b/g)) {
      violations.push(`${path}: ${match[0]}`)
    }
  }
  assert.deepEqual(violations, [])
})
