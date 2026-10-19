import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { parse } from '@vue/compiler-sfc'
import { PdfByteLru, PDF_GEOMETRY_BYTES } from '../src/services/pdfResources.ts'

const source = readFileSync(new URL('../src/views/PdfReaderView.vue', import.meta.url), 'utf8')
const { descriptor } = parse(source)
const ast = ts.createSourceFile('PdfReaderView.ts', descriptor.scriptSetup.content, ts.ScriptTarget.Latest, true)
function functions(names, bindings) {
  const context = vm.createContext(bindings)
  for (const name of names) {
    const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name)
    assert.ok(node, `production ${name}`)
    context[name] = vm.runInContext(ts.transpileModule(`(${node.getText(ast)})`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    }).outputText, context)
  }
  return context
}

test('PERF-REVIEW-002: one geometry extraction per matching page even when its model exceeds LRU admission', () => {
  const codes = new Uint32Array(350_000).fill(122)
  codes[10] = codes[100] = codes[1000] = 97
  const cache = new PdfByteLru(PDF_GEOMETRY_BYTES)
  let extractions = 0
  const pdm = {
    pageCodes: () => codes,
    text(page) {
      const cached = cache.get(page)
      if (cached) return cached
      extractions++
      const model = { count: codes.length, codes, boxes: new Float32Array(codes.length * 4), sizes: new Float32Array(codes.length), lines: [] }
      assert.ok(model.codes.byteLength + model.boxes.byteLength + model.sizes.byteLength > PDF_GEOMETRY_BYTES)
      cache.set(page, model, 256 + model.codes.byteLength + model.boxes.byteLength + model.sizes.byteLength)
      return model
    },
  }
  const c = functions(['appendSearchUnits', 'modelSearchUnits', 'pageSearchHits'], {
    pdm, pdfSearchMatchCase: { value: false }, pdfSearchWholeWord: { value: false },
    rangeRects: (_model, a, b) => [{ x: a, y: 0, w: b - a, h: 1 }],
  })
  const hits = c.pageSearchHits(1, ['a'])
  assert.equal(hits.length, 3)
  assert.deepEqual(Array.from(hits, h => [h.a, h.b]), [[10, 11], [100, 101], [1000, 1001]])
  assert.equal(cache.bytes, 0, 'fixture must not fit the global LRU')
  assert.equal(extractions, 1, 'oversized model must be retained for this invocation, not rebuilt per occurrence')
  assert.equal(c.pageSearchHits(1, ['q']).length, 0)
  assert.equal(extractions, 1, 'nonmatching pages must not extract geometry')
})
