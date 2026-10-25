import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { compile, emit, runJvm, root } from './native-import-test-tools.mjs'
const source = () => readFileSync(join(root, 'src-tauri/android/NativeLibraryPanel.kt'), 'utf8')
function body(name) {
  const text = source(), start = text.indexOf('private fun ' + name + '(')
  assert.ok(start >= 0, name)
  const end = text.slice(start + 1).search(/\n    (?:private )?fun /)
  return text.slice(start, end < 0 ? undefined : start + 1 + end)
}

test('real Kotlin interaction policy refuses every failed/busy/fatal/closed combination', () => {
  const fn = source().match(/internal fun nativeLibraryCanAct\([\s\S]*?\n\) = [^\n]+/u)?.[0]
  assert.ok(fn, 'production interaction policy must be explicit')
  const out = resolve(root, '../.cache/native-library-admission', `${Date.now()}-${process.pid}`)
  mkdirSync(out, { recursive: true })
  const main = emit(out, 'Admission.kt', fn + `\nfun main(){for(mask in 0 until 64){val flags=(0..5).map{mask and (1 shl it)!=0};check(nativeLibraryCanAct(flags[0],flags[1],flags[2],flags[3],flags[4],flags[5])==(mask==0))};println("ADMISSION_64_PASS")}\n`)
  const cp = compile(out, [main]);assert.match(runJvm(out, 'run', ['-cp', cp, 'AdmissionKt']), /ADMISSION_64_PASS/)
})

test('failure invalidates queued metadata callbacks and cannot unlatch a fatal DB state', () => {
  const failed = body('showFailure')
  assert.match(failed, /epoch\+\+/)
  assert.match(failed, /fatalDatabase = fatalDatabase \|\| unsafeDatabase\(code\)/)
  assert.match(failed, /keywordSearch\.settled\(\)/)
  assert.match(source(), /if \(token != epoch\) return@ask/)
})

test('existing dialog inputs survive, affirmative and neutral actions are disabled on failure', () => {
  const failed = body('showFailure')
  assert.match(failed, /BUTTON_POSITIVE/)
  assert.match(failed, /BUTTON_NEUTRAL/)
  assert.doesNotMatch(failed, /\.dismiss\(/)
  assert.match(body('track'), /if \(closed \|\| failed\) return dialog/)
})

test('late dialog choices and all mutation entries recheck current admission', () => {
  assert.match(body('choose'), /if \(owner == epoch && canAct\(\)\) action\(/)
  assert.match(body('mutate'), /if \(!canAct\(\)/)
  assert.match(body('tagBatch'), /if \(!canAct\(\)/)
  const tag = body('tagDialog')
  assert.ok(tag.indexOf('if (!canAct()) return@setOnClickListener') < tag.indexOf('alert.dismiss()'))
  assert.ok(tag.indexOf('if (!canAct()) return@setOnClickListener') >= 0)
})

test('advanced filter draft controls, adoption, apply and clear are epoch-owned', () => {
  const advanced = body('advanced')
  assert.match(advanced, /fun ownsDraft\(\) = owner == epoch && canAct\(\)/)
  assert.match(advanced, /button\(value\) \{ if \(ownsDraft\(\)\) action\(\) \}/)
  assert.equal((advanced.match(/if \(!ownsDraft\(\)\) return@setPositiveButton/g) || []).length, 2)
  assert.match(advanced, /if \(!ownsDraft\(\)\) return@setNeutralButton/)
  assert.match(advanced, /if \(!ownsDraft\(\)\) return@setMultiChoiceItems/)
})
