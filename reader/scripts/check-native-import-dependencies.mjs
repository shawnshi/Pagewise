import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join, basename, relative } from 'node:path'
import { spawnSync } from 'node:child_process'
import { root, modules, files, toolchain } from './native-import-test-tools.mjs'

const out = join(root, '../.cache/native-import-20261021')
const online = process.argv.includes('--online')
const report = { checkedAt: new Date().toISOString(), online, status: 'running', runtimeDelta: [], artifacts: [], advisories: [],
  limits: ['HTTPS repository checksums are not signature verification.', 'Maven OSV matching does not audit embedded native PDFium/C++ components or prove absence of vulnerabilities.', 'Kotlin Gradle plugin executes build code; no new project shell/install-script hook is added.'] }
const digest = (data, algorithm = 'sha256') => createHash(algorithm).update(data).digest('hex')
function save() {
  const path = join(out, 'dependency-audit.json')
  writeFileSync(path + '.tmp', JSON.stringify(report, null, 2) + '\n')
  renameSync(path + '.tmp', path)
}
function graph(text) {
  const result = new Map()
  for (const line of text.split('\n')) {
    if (line.includes('(c)')) continue
    const m = line.match(/--- ([a-z][a-z0-9_.-]*):([A-Za-z0-9_.-]+)(?::([^\s:()]+))?(?: -> ([^\s()]+))?/)
    if (m && (m[4] || m[3])) result.set(`${m[1]}:${m[2]}`, m[4] || m[3])
  }
  return result
}
function central(name, version, file) {
  assert.match(name, /^[a-z0-9_.-]+:[A-Za-z0-9_.-]+$/)
  assert.match(version, /^[A-Za-z0-9_.-]+$/)
  return `https://repo.maven.apache.org/maven2/${name.replaceAll('.', '/').replace(':', '/')}/${version}/${file}`
}
async function publicText(url, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(25000) })
  if (!response.ok) throw new Error(`Public dependency endpoint returned HTTP ${response.status}: ${url}`)
  const text = await response.text()
  assert.ok(text.length < 4 * 1024 * 1024, 'bounded dependency metadata')
  return text
}
async function licenses(name, version, depth = 0) {
  assert.ok(depth < 6, `unresolved POM license: ${name}`)
  const [group, artifact] = name.split(':')
  const filename = `${artifact}-${version}.pom`
  const cached = files(join(modules, group, artifact, version), '.pom').find(p => basename(p) === filename)
  const text = cached ? readFileSync(cached, 'utf8') : await publicText(central(name, version, filename))
  const block = text.match(/<licenses>([\s\S]*?)<\/licenses>/)?.[1]
  if (block) return [...block.matchAll(/<name>([\s\S]*?)<\/name>/g)].map(m => m[1].trim())
  const parent = text.match(/<parent>([\s\S]*?)<\/parent>/)?.[1]
  assert.ok(parent, `no declared license or parent: ${name}:${version}`)
  const tag = n => parent.match(new RegExp(`<${n}>([^<]+)</${n}>`))?.[1]
  return licenses(`${tag('groupId')}:${tag('artifactId')}`, tag('version'), depth + 1)
}
try {
  assert.equal(readFileSync(join(root, 'src-tauri/android/kotlin-version.txt'), 'utf8').trim(), '2.4.20')
  const args = ['--offline', '--no-daemon', ':app:dependencies', '--configuration', 'universalDebugRuntimeClasspath', 'buildEnvironment']
  const command = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : './gradlew'
  const argv = process.platform === 'win32' ? ['/c', 'gradlew.bat', ...args] : args
  const run = spawnSync(command, argv, { cwd: join(root, 'src-tauri/gen/android'), encoding: 'utf8', timeout: 90000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, ANDROID_HOME: process.env.ANDROID_HOME || join(process.env.USERPROFILE, 'AppData/Local/Android/Sdk') } })
  const tree = (run.stdout ?? '') + (run.stderr ?? '')
  writeFileSync(join(out, 'dependencies-final.log'), tree)
  assert.equal(run.status, 0, run.error?.message ?? tree)
  const split = tree.indexOf('> Task :buildEnvironment')
  assert.ok(split > 0, 'both runtime and build dependency graphs must be present')
  const before = graph(readFileSync(join(out, 'dependencies-before.log'), 'utf8'))
  const current = graph(tree.slice(0, split))
  const build = tree.slice(split)
  const start = build.indexOf('--- org.jetbrains.kotlin:kotlin-gradle-plugin:2.4.20')
  assert.ok(start >= 0, 'project Kotlin plugin must resolve to the authorized version')
  const tail = build.slice(start)
  const next = tail.indexOf('\n+--- ')
  const tooling = graph(tail.slice(0, next < 0 ? undefined : next))
  for (const [name, version] of current) if (before.get(name) !== version) report.runtimeDelta.push({ name, before: before.get(name) ?? null, after: version })
  if (online) {
    const init = join(out, 'resolve-audit-artifacts.gradle')
    const selected = report.runtimeDelta.map(r => JSON.stringify(r.name)).join(',')
    writeFileSync(init, `gradle.projectsEvaluated {
  def app = gradle.rootProject.findProject(':app')
  if (app == null) return
  app.tasks.register('nativeImportAuditArtifacts') {
    doLast {
      def selected = [${selected}] as Set
      def view = app.configurations.getByName('universalDebugRuntimeClasspath').incoming.artifactView {
        componentFilter { id -> id instanceof org.gradle.api.artifacts.component.ModuleComponentIdentifier && selected.contains(id.group + ':' + id.module) }
      }
      view.files.files.each { println('Resolved audit artifact: ' + it.name) }
    }
  }
}
`)
    const resolveArgs = ['--no-daemon', '--init-script', init, ':app:nativeImportAuditArtifacts']
    const resolved = spawnSync(command, process.platform === 'win32' ? ['/c', 'gradlew.bat', ...resolveArgs] : resolveArgs,
      { cwd: join(root, 'src-tauri/gen/android'), env: { ...process.env, ANDROID_HOME: process.env.ANDROID_HOME || join(process.env.USERPROFILE, 'AppData/Local/Android/Sdk') }, encoding: 'utf8', timeout: 90000, maxBuffer: 4 * 1024 * 1024 })
    writeFileSync(join(out, 'dependency-resolution.log'), (resolved.stdout ?? '') + (resolved.stderr ?? ''))
    assert.equal(resolved.status, 0, resolved.error?.message ?? resolved.stdout + resolved.stderr)
  }
  const audit = new Map(report.runtimeDelta.map(r => [r.name, r.after]))
  for (const pair of tooling) audit.set(...pair)
  const selections = [...audit]
  // Compiler/daemon artifacts are resolved by compilation, not always expanded by buildEnvironment.
  for (const path of toolchain().compiler) {
    const [group, artifact, version] = relative(modules, path).split(/[\\/]/)
    const name = `${group}:${artifact}`
    if (!selections.some(([n, v]) => n === name && v === version)) selections.push([name, version])
  }
  const queries = []
  for (const [name, version] of selections) {
    const [group, artifact] = name.split(':')
    const jars = files(join(modules, group, artifact, version)).concat(files(join(modules, group, artifact, version), '.aar'))
      .filter(p => basename(p).startsWith(`${artifact}-${version}`) && !/-sources\.|-javadoc\./.test(p))
    if (!jars.length) {
      const pom = files(join(modules, group, artifact, version), '.pom').find(p => basename(p) === `${artifact}-${version}.pom`)
      assert.ok(pom && /<packaging>pom<\/packaging>/.test(readFileSync(pom, 'utf8')), `no installed artifact: ${name}:${version}`)
      jars.push(pom)
    }
    const declared = await licenses(name, version)
    assert.ok(declared.length && declared.some(x => /Apache|BSD|MIT/i.test(x)), `license review required: ${name}: ${declared}`)
    for (const path of jars) {
      const bytes = readFileSync(path)
      const entry = { name, version, file: basename(path), sha256: digest(bytes), licenses: declared }
      if (online) {
        const published = (await publicText(central(name, version, `${basename(path)}.sha1`))).trim().split(/\s+/)[0].toLowerCase()
        assert.match(published, /^[a-f0-9]{40}$/)
        assert.equal(digest(bytes, 'sha1'), published, `repository checksum mismatch: ${name}`)
        entry.repositorySha1Verified = true
      }
      report.artifacts.push(entry)
    }
    queries.push({ package: { ecosystem: 'Maven', name }, version })
  }
  if (online) {
    const raw = await publicText('https://api.osv.dev/v1/querybatch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ queries }) })
    let response
    try { response = JSON.parse(raw) } catch (cause) { throw new Error('Invalid OSV JSON response', { cause }) }
    assert.equal(response.results?.length, queries.length, 'OSV must account for every requested coordinate')
    for (const [i, result] of response.results.entries()) {
      assert.ok(!result.next_page_token && !result.error, 'OSV partial/error response requires follow-up')
      assert.ok(result.vulns === undefined || Array.isArray(result.vulns), 'invalid OSV vulnerability list')
      const ids = (result.vulns ?? []).map(v => { assert.equal(typeof v.id, 'string'); return v.id })
      report.advisories.push({ ...queries[i], ids })
    }
    writeFileSync(join(out, 'osv-response.json'), raw)
    assert.ok(report.advisories.every(r => r.ids.length === 0), 'affected advisory requires review; see dependency-audit.json')
  }
  const baseline = JSON.parse(readFileSync(join(out, 'preflight.json'), 'utf8'))
  assert.equal(baseline.upstreamAndroidBuilds?.length, 4, 'all upstream build scripts must be covered')
  for (const entry of baseline.upstreamAndroidBuilds) assert.equal(digest(readFileSync(entry.path)), entry.sha256, 'upstream Cargo Gradle script must remain unchanged')
  for (const entry of baseline.baseline.filter(e => e.exists && e.inWriteSet === false)) assert.equal(digest(readFileSync(join(root, '..', entry.path))), entry.sha256, `preserve unrelated dirty file: ${entry.path}`)
  report.status = online ? 'passed-scoped-audit' : 'local-only-network-checks-not-run'
  save()
  console.log(`${report.status}: ${report.runtimeDelta.length} runtime changes, ${report.artifacts.length} artifacts, ${report.advisories.length} public Maven advisory queries; native-binary audit remains out of scope.`)
} catch (error) {
  report.status = 'error'
  report.error = { type: error.name, message: error.message, causeCode: error.cause?.code }
  save()
  throw error
}
