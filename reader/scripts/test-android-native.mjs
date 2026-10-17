import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import test from 'node:test'

const root = fileURLToPath(new URL('../', import.meta.url))
const read = path => readFileSync(join(root, path), 'utf8')
const manifest = read('src-tauri/Cargo.toml')
const lib = read('src-tauri/src/lib.rs')
const build = read('src-tauri/build.rs')

// These are source contracts, not a substitute for an Android build/device run.
test('only the Android library entry point remains, with the existing brand and crate types', () => {
  assert.match(manifest, /^autobins\s*=\s*false$/m)
  assert.match(manifest, /^name = "pagewise"$/m)
  assert.match(manifest, /^version = "1\.15\.0"$/m)
  assert.match(manifest, /^name = "pagewise_lib"$/m)
  assert.match(manifest, /^crate-type = \["staticlib", "cdylib", "rlib"\]$/m)
  assert.equal(existsSync(join(root, 'src-tauri/src/main.rs')), false)
  assert.match(build, /std::env::var\("CARGO_CFG_TARGET_OS"\)/)
  assert.match(build, /as_deref\(\) != Ok\("android"\)/)
  assert.match(build, /panic!\("Pagewise supports Android only"\)/)
  assert.match(build, /tauri_build::build\(\)/)
  assert.match(lib, /#\[cfg\(not\(target_os = "android"\)\)\]\s*compile_error!\("Pagewise supports Android only"\)/)
  assert.match(lib, /#\[cfg\(target_os = "android"\)\]\s*#\[tauri::mobile_entry_point\]\s*pub fn run\(\)/)
})

test('desktop engines and their native command/state registrations are absent', () => {
  assert.equal(readdirSync(join(root, 'src-tauri/src'), { recursive: true }).filter(name => /^agent[\\/].*\.rs$/.test(name)).length, 0)
  for (const path of ['babeldoc.rs', 'local_tts.rs', 'tts_device.rs', 'calibre.rs', 'app_update.rs', 'http_upload.rs']) {
    assert.equal(existsSync(join(root, 'src-tauri/src', path)), false, path)
  }
  assert.doesNotMatch(lib, /agent::|babeldoc|local_tts|tts_device|single_instance|std::env::args|Service Worker|cfg\(desktop\)|calibre|app_update|http_upload/)
  assert.doesNotMatch(manifest, /sherpa-onnx|windows-sys|tauri-plugin-single-instance|^libc\s*=|^ureq\s*=|^bzip2\s*=|^tar\s*=/m)
  const sources = readdirSync(join(root, 'src-tauri/src')).filter(name => name.endsWith('.rs'))
  for (const source of sources) {
    assert.doesNotMatch(read(`src-tauri/src/${source}`), /crate::(?:agent|babeldoc|local_tts|tts_device)::/, source)
  }
})

test('Android opened-event queue and file read authorization are retained', () => {
  assert.match(lib, /tauri::RunEvent::Opened \{ urls \}/)
  assert.match(lib, /url\.to_file_path\(\)\.ok\(\)/)
  assert.match(lib, /queue_open_files\(app_handle, supported_paths\(paths\)\)/)
  assert.match(lib, /allowed\.insert\(path\.clone\(\)\)/)
  assert.match(lib, /!data\.pending\.contains\(&path\)/)
  assert.match(lib, /std::mem::take\(&mut state\.0\.lock\(\)\.unwrap\(\)\.pending\)/)
  assert.match(lib, /if !state\.0\.lock\(\)\.unwrap\(\)\.allowed\.contains\(&path\)/)
  assert.match(lib, /if !file\.is_file\(\) \|\| !is_supported_path\(file\)/)
  for (const command of ['take_open_files', 'read_open_file', 'edge_tts::edge_tts_synthesize', 'fonts::list_system_fonts']) {
    assert.ok(lib.includes(command), command)
  }
  assert.match(lib, /tauri_plugin_sql::Builder::new\(\)\.build\(\)/)
})

test('shared native implementations retain the frozen brand source (ignoring checkout line endings)', () => {
  const hashes = {
    'edge_tts.rs': '2feb13ca7a75b9f27c62c103a370620b2674b94bd39636e5d387082d13e65fc3',
    'fonts.rs': 'a53d2a7b8a93a510cd04d16cf5c1ed0e23536fbba1641448c3ebbc4e447ec74c',
  }
  for (const [name, expected] of Object.entries(hashes)) {
    assert.equal(createHash('sha256').update(read(`src-tauri/src/${name}`).replaceAll('\r\n', '\n')).digest('hex'), expected, name)
  }
  assert.match(manifest, /cargo_metadata = \{ path = "vendor\/cargo_metadata" \}/)
  assert.doesNotMatch(manifest, /^(?:reqwest|rusqlite)\s*=/m)
  assert.match(lib, /tauri_plugin_http::init\(\)/)
  for (const dependency of ['uuid', 'sha2', 'tokio-tungstenite', 'futures-util', 'fontdb']) {
    assert.ok(manifest.includes(`${dependency} =`), dependency)
  }
})
