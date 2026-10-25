import assert from 'node:assert/strict'
import {test} from 'node:test'
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs'
import {join,resolve,relative,delimiter} from 'node:path'
import {compile,root,runJvm,toolchain} from './native-import-test-tools.mjs'

const project=resolve(root,'..')
const out=resolve(process.env.PW_WINDOW_READY_OUT??join(project,'.cache',`native-window-ready-${Date.now()}`))
assert.ok(!relative(project,out).startsWith('..'),'Test artifacts must remain inside the project')

test('actual Kotlin readiness gate handles 16 deterministic lifecycle and negative scenarios',{timeout:80000},()=>{
 assert.ok(!existsSync(out),'Never overwrite a prior test receipt');mkdirSync(out,{recursive:true})
 const jdk='C:/Program Files/Java/jdk-21.0.12.1';if(process.platform==='win32'&&existsSync(jdk)){process.env.JAVA_HOME=jdk;process.env.PATH=join(jdk,'bin')+delimiter+process.env.PATH}
 const sources=['NativeWindowReadyGate.kt','NativeWindowReadyGateMain.kt'].map(name=>join(root,'scripts/fixtures',name))
 const tools=toolchain();compile(out,sources,[tools.stdlib]);const run=runJvm(out,'host',['-cp',join(out,'classes')+delimiter+tools.stdlib,'io.pagewise.reader.NativeWindowReadyGateMainKt'])
 assert.equal(typeof run,'string');const names=run.split(/\r?\n/).filter(line=>line.startsWith('PASS ')).map(line=>line.slice(5));assert.equal(names.length,16);assert.match(run,/NATIVE_WINDOW_GATE_HOST_PASS cases=16/)
 writeFileSync(join(out,'result.json'),JSON.stringify({passed:true,hostCases:16,names,androidRuntimeExecuted:false,productionCodeExercised:false,scope:'Real test-only Kotlin gate under a controlled scheduler; not Android MessageQueue/View behavior'},null,2))
})
test('Android adapter waits for queued dismiss callbacks and uses event subscriptions, not a stale captured window',()=>{
 const source=readFileSync(join(root,'scripts/fixtures/NativeStatsSettingsMain.kt'),'utf8')
 assert.match(source,/addIdleHandler\(idle\)/);assert.match(source,/postFrameCallback\(first\)/);assert.match(source,/postFrameCallback\(second\)/)
 assert.match(source,/currentWindow = ::currentTestWindow/);assert.match(source,/onViewDetachedFromWindow/);assert.match(source,/removeOnGlobalLayoutListener/);assert.match(source,/removeFrameCallback\(first\)/);assert.match(source,/removeFrameCallback\(second\)/)
 assert.doesNotMatch(source,/setOnDismissListener/);assert.doesNotMatch(source,/Thread\.sleep|while\s*\([^)]*hasWindowFocus/)
})
