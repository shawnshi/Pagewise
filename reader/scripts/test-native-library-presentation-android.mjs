import assert from 'node:assert/strict'
import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs'
import { resolve, join, delimiter } from 'node:path'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { compile, toolchain, files, modules, artifact } from './native-import-test-tools.mjs'

const [serial, label, expectation] = process.argv.slice(2)
assert.match(serial ?? '', /^emulator-\d+$/, 'Only a task-owned emulator is permitted')
assert.match(label ?? '', /^[\w-]+$/)
const root = resolve(import.meta.dirname, '../..'), out = join(root, '.cache/eink-ui-s2-20261024', 'android-' + label)
assert.ok(!existsSync(out), 'Keep previous execution receipts immutable')
mkdirSync(out, { recursive: true })
const sdk = join(homedir(), 'AppData/Local/Android/Sdk'), jdk = 'C:/Program Files/Java/jdk-21.0.12.1'
process.env.JAVA_HOME = jdk; process.env.PATH = join(jdk, 'bin') + delimiter + process.env.PATH
const android = join(sdk, 'platforms/android-36/android.jar'), adb = join(sdk, 'platform-tools/adb.exe')
function run(name, cmd, args, allowFailure = false) {
  const p = spawnSync(cmd, args, { encoding: 'utf8', timeout: 100000, maxBuffer: 8 * 1024 * 1024 })
  writeFileSync(join(out, name + '.log'), JSON.stringify({ exit: p.status, error: p.error?.message }) + '\n' + (p.stdout ?? '') + (p.stderr ?? ''))
  if (!allowFailure) assert.equal(p.status, 0, p.error?.message ?? p.stdout + p.stderr)
  return p
}
const identity = run('identity', adb, ['-s', serial, 'emu', 'avd', 'name'])
assert.equal(identity.stdout.split(/\r?\n/)[0].trim(), 'EinkLibraryUi32')
const aar = files(join(modules, 'androidx.core/core/1.13.1'), '.aar'); assert.equal(aar.length, 1)
const core = join(out, 'path-parser.jar')
run('core-types', 'python', ['-X', 'utf8', '-c', "import zipfile,io,sys;z=zipfile.ZipFile(sys.argv[1]);c=zipfile.ZipFile(io.BytesIO(z.read('classes.jar')));o=zipfile.ZipFile(sys.argv[2],'w');[(o.writestr(n,c.read(n))) for n in c.namelist() if n.startswith('androidx/core/graphics/PathParser') and n.endswith('.class')];o.close()", aar[0], core])
const names = ['NativePagesController.kt','NativeLibraryPanel.kt','NativeUi.kt','NativeUiMetrics.kt','NativePageVisibility.kt','NativeClassificationEditor.kt','NativeManualRenderer.kt','NativeNoteEditor.kt','NativeBookIntroductionEditor.kt','NativeBookRecommendationsPanel.kt','NativeSettingsPanel.kt','NativeStatsPanel.kt','NativeStatsSettingsUi.kt','NativeStateStore.kt','CanonicalDatabase.kt']
const sources = names.map(name => process.env.PW_LIBRARY_UI_SOURCE_DIR && existsSync(join(process.env.PW_LIBRARY_UI_SOURCE_DIR, name)) ? join(process.env.PW_LIBRARY_UI_SOURCE_DIR, name) : join(root, 'reader/src-tauri/android', name))
const commonmark = artifact('org.commonmark', 'commonmark', '0.21.0')
compile(out, sources.concat(join(root, 'reader/scripts/fixtures/NativeLibraryPresentationMain.kt')), [android, core, commonmark])
const jar = join(jdk, 'bin/jar.exe'), classes = join(out, 'classes.jar'), dex = join(out, 'dex')
run('classes', jar, ['cf', classes, '-C', join(out, 'classes'), '.']); mkdirSync(dex)
run('dex', join(jdk, 'bin/java.exe'), ['-cp', join(sdk, 'build-tools/36.0.0/lib/d8.jar'), 'com.android.tools.r8.D8', '--min-api', '24', '--lib', android, '--output', dex, classes, toolchain().stdlib, core, commonmark])
const pkg = 'io.pagewise.einks2.test', bt = join(sdk, 'build-tools/36.0.0'), manifest = join(out, 'AndroidManifest.xml')
writeFileSync(manifest, `<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="${pkg}" android:versionCode="1" android:versionName="1"><uses-sdk android:minSdkVersion="24" android:targetSdkVersion="36"/><application android:debuggable="true" android:testOnly="true" android:label="Synthetic S2 UI" android:theme="@android:style/Theme.Material.Light.NoActionBar"><activity android:name="io.pagewise.reader.NativeLibraryPresentationActivity" android:exported="true"/></application></manifest>`)
const unsigned = join(out, 'unsigned.apk'), aligned = join(out, 'aligned.apk'), apk = join(out, 'harness.apk')
run('resources', join(bt, 'aapt2.exe'), ['link', '-I', android, '--manifest', manifest, '-o', unsigned])
run('pack-dex', 'python', ['-X','utf8','-c',"import zipfile,sys,pathlib;z=zipfile.ZipFile(sys.argv[1],'a');[(z.write(p,p.name)) for p in pathlib.Path(sys.argv[2]).glob('*.dex')];z.close()",unsigned,dex])
run('align', join(bt, 'zipalign.exe'), ['-f', '4', unsigned, aligned])
const key = join(root, '.cache/eink-ui-s2-20261024/harness-only.jks')
// Disposable key for this empty test app only; never read or modify the production signing key.
if (!existsSync(key)) run('test-key', join(jdk, 'bin/keytool.exe'), ['-genkeypair','-keystore',key,'-alias','fixture','-storepass','android','-keypass','android','-dname','CN=PagewiseSyntheticS2','-keyalg','RSA','-keysize','2048','-validity','2'])
run('sign', join(jdk, 'bin/java.exe'), ['-jar',join(bt,'lib/apksigner.jar'),'sign','--ks',key,'--ks-pass','pass:android','--key-pass','pass:android','--out',apk,aligned])
run('install-test-only', adb, ['-s',serial,'install','-r','-t',apk])
run('start-test-only', adb, ['-s',serial,'shell','am','start','-W','-n',pkg+'/io.pagewise.reader.NativeLibraryPresentationActivity','--es','label',label])
run('receipt-ready', adb, ['-s',serial,'shell','run-as',pkg,'sh','-c',`'for i in $(seq 1 40); do test -f files/${label}/result.json && exit 0; sleep 1; done; exit 1'`])
run('capture', 'python', ['-X','utf8','-c',"import subprocess,pathlib,sys,tarfile,io;r=subprocess.run([sys.argv[1],'-s',sys.argv[2],'exec-out','run-as',sys.argv[3],'tar','-cf','-','-C','files',sys.argv[4]],capture_output=True,timeout=20);assert r.returncode==0,r.stderr;b=pathlib.Path(sys.argv[5]);(b/'fixture.tar').write_bytes(r.stdout);t=tarfile.open(fileobj=io.BytesIO(r.stdout));[( (b/'images'/m.name).parent.mkdir(parents=True,exist_ok=True),(b/'images'/m.name).write_bytes(t.extractfile(m).read()) ) for m in t.getmembers() if m.isfile() and not pathlib.PurePosixPath(m.name).is_absolute() and '..' not in pathlib.PurePosixPath(m.name).parts]",adb,serial,pkg,label,out])
let result
try { result = JSON.parse(readFileSync(join(out,'images',label,'result.json'),'utf8')) }
catch (cause) { throw new Error('Invalid real-Activity presentation receipt', { cause }) }
writeFileSync(join(out,'result.json'),JSON.stringify({serial,compileApi:36,runtimeApi:32,testPackage:pkg,sourceOverlay:process.env.PW_LIBRARY_UI_SOURCE_DIR??null,expectedFailure:expectation==='--expect-failure',...result},null,2))
if (expectation==='--expect-failure') assert.ok(result.failures>0,'Original UI must fail changed presentation requirements')
else assert.equal(result.failures,0)
console.log(JSON.stringify({serial,label,cases:result.cases.length,failures:result.failures,expectedFailure:expectation==='--expect-failure'}))
