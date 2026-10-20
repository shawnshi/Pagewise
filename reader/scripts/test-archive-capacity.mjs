import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'
import { zipSync, strToU8 } from 'fflate'
import { loadBackup, store } from './test-bounded-archive.mjs'
import { ARCHIVE_LIMITS, readBoundedArchive } from '../src/services/boundedArchive.ts'

const MiB = 1024 * 1024
const split = /split.*archive|split.*library/i
function library(lengths, format = 'txt', idFor = i => `book-${i}`) {
  const s = store()
  lengths.forEach((length, i) => {
    const id = idFor(i)
    s.books.push({ id, title: `Synthetic ${i}`, author: '', tags: [], format, fileName: `book.${format}`, addedAt: 1 })
    s.blobs.set(id, new Blob([new Uint8Array(length)]))
  })
  return s
}

test('real production capacity: two 33 MiB books cannot report successful export', async () => {
  const s = library([33 * MiB, 33 * MiB]); const api = await loadBackup(s)
  let completed = false
  await assert.rejects(async () => { await api.exportBackup(); completed = true }, split)
  assert.equal(completed, false)
})
test('real 64 MiB ZIP boundary includes local headers, descriptors, central directory and EOCD', async () => {
  const empty = await (await loadBackup(library([0]))).exportBackup()
  // Only the byte-length decimal fields change width; SHA-256 and timestamps have fixed widths.
  const overhead = empty.size + 2 * (String(ARCHIVE_LIMITS.archiveBytes).length - 1)
  const contentBytes = ARCHIVE_LIMITS.archiveBytes - overhead
  const api = await loadBackup(library([contentBytes]))
  const exact = await api.exportBackup()
  assert.equal(exact.size, ARCHIVE_LIMITS.archiveBytes, `fixture overhead=${overhead}`)
  const target = store(); const receiver = await loadBackup(target)
  assert.equal((await receiver.importBackup(new File([exact], 'at-limit.zip'))).books, 1)
  assert.equal(target.blobs.get(target.books[0].id).size, contentBytes)
  await assert.rejects((await loadBackup(library([contentBytes + 1]))).exportBackup(), split)
})
test('actual 2048-entry export restores; the next entry cannot produce success', async () => {
  const count = (ARCHIVE_LIMITS.entries - 4) / 2
  const rows = [{ key: 'fixture|2026-10-20|id:book-0', seconds: 1, updatedAt: 1 }]
  const api = await loadBackup(library(Array(count).fill(0)), { exportLogRows: rows })
  const blob = await api.exportBackup()
  assert.equal(Object.keys(await readBoundedArchive(blob)).length, ARCHIVE_LIMITS.entries)
  const receiver = await loadBackup(store())
  assert.equal((await receiver.importBackup(new File([blob], 'entry-limit.zip'))).books, count)
  await assert.rejects((await loadBackup(library(Array(count + 1).fill(0)))).exportBackup(), split)
})
test('central-directory budget is enforced independently of the 2048-entry ceiling', async () => {
  const s = library(Array(1022).fill(0), 'txt', i => `${'x'.repeat(970)}${i}`)
  const api = await loadBackup(s)
  await assert.rejects(api.exportBackup(), split)
})
test('actual Markdown book assets above 4 MiB and invalid YAML bodies roundtrip as bytes, not metadata', async () => {
  for (const content of ['# Markdown book\n' + 'x'.repeat(5 * MiB), '---\nbroken: [\n---\nraw book body']) {
    const s = library([0], 'md'); s.blobs.set('book-0', new Blob([content]))
    const api = await loadBackup(s); const blob = await api.exportBackup()
    const target = store(); const receiver = await loadBackup(target)
    assert.equal((await receiver.importBackup(new File([blob], 'markdown.zip'))).books, 1)
    assert.equal(await target.blobs.get(target.books[0].id).text(), content)
  }
})
test('YAML-like Markdown payloads cannot reclassify or hide another exported book concept', async () => {
  const s = library([0, 0], 'md')
  s.blobs.set('book-0', new Blob(['---\ntype: Book\nresource: ../../../books/book-1.md\n---\nBook text, not bundle metadata']))
  s.blobs.set('book-1', new Blob(['---\ntype: Book\nresource: https://invalid.example/test\n---\nAlso book text']))
  const api = await loadBackup(s); const blob = await api.exportBackup()
  const target = store(); const receiver = await loadBackup(target)
  assert.equal((await receiver.importBackup(new File([blob], 'roles.zip'))).books, 2)
  assert.equal(target.books.length, 2)
})
test('legacy referenced Markdown asset outside assets/ keeps the per-book budget', async () => {
  const content = strToU8('# Legacy\n' + 'x'.repeat(5 * MiB))
  const meta = { id: 'old', title: 'Legacy', author: '', tags: [], format: 'md', fileName: 'content.md', addedAt: 1, fileEntry: 'content.md' }
  const blob = new File([zipSync({ 'manifest.json': strToU8(JSON.stringify({ app: 'lightread', version: 1, books: [meta], annotations: [], sources: [] })), 'content.md': content })], 'legacy.zip')
  const target = store(); const api = await loadBackup(target)
  assert.equal((await api.importBackup(blob)).books, 1)
  assert.equal(target.blobs.get(target.books[0].id).size, content.length)
})
test('oversized generated metadata rejects export, never returns a successful Blob', async () => {
  const s = library([1]); s.books[0].description = 'x'.repeat(ARCHIVE_LIMITS.metadataBytes)
  const api = await loadBackup(s)
  await assert.rejects(api.exportBackup(), split)
})
test('oversized unreferenced Markdown remains bounded metadata before restore writes', async () => {
  const s = store(); const api = await loadBackup(s)
  const oversized = strToU8('x'.repeat(ARCHIVE_LIMITS.metadataBytes + 1))
  for (const path of ['books/oversized.md', 'assets/not-a-book.md']) {
    const blob = new File([zipSync({ 'index.md': strToU8('---\nokf_version: "0.1"\n---\n'), [path]: oversized })], 'metadata.zip')
    await assert.rejects(api.importBackup(blob))
    assert.deepEqual(s.writes, [])
  }
})

async function nativeExporter() {
  const calls = []
  const synthetic = async (name, values) => {
    const mod = new vm.SyntheticModule(Object.keys(values), function () { for (const [key, value] of Object.entries(values)) this.setExport(key, value) }, { identifier: name })
    await mod.link(() => { throw new Error('unexpected dependency') }); await mod.evaluate(); return mod
  }
  const source = await readFile(new URL('../src/services/archiveExport.ts', import.meta.url), 'utf8')
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  const mod = new vm.SourceTextModule(code, { importModuleDynamically: async spec => {
    if (spec === '@tauri-apps/plugin-dialog') return synthetic(spec, { save: async () => 'content://synthetic-target' })
    if (spec === '@tauri-apps/api/core') return synthetic(spec, { invoke: async (name, payload) => { calls.push({ name, path: payload.path, bytes: payload.data?.length ?? 0 }) } })
    throw new Error(`Unexpected native import: ${spec}`)
  } })
  await mod.link(async spec => {
    if (spec === '../storage/types') return synthetic(spec, { isTauri: () => true })
    if (spec === '../storage/sourceFile') return synthetic(spec, { retryWhileBusy: async operation => operation() })
    if (spec === './base64') return synthetic(spec, { toBase64Chunk: bytes => Buffer.from(bytes).toString('base64') })
    throw new Error(`Unexpected static import: ${spec}`)
  })
  await mod.evaluate()
  return { api: mod.namespace, calls }
}
test('real native export orchestration cleans streamed temp and never publishes rejected capacity', async () => {
  const { api: native, calls } = await nativeExporter()
  const api = await loadBackup(library([33 * MiB, 33 * MiB]))
  await assert.rejects(native.exportLibraryArchiveToDevice('synthetic.zip', write => api.exportBackupToSink(write)), split)
  assert.ok(calls.some(call => call.name === 'append_export'), 'fixture must have streamed partial temp output')
  assert.equal(calls.some(call => call.name === 'write_export'), false)
  assert.equal(calls.at(-1).name, 'delete_export')
})
