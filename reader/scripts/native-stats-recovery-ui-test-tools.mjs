import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
export function assertNativeStatsRecoveryBindings(base = fileURLToPath(new URL('../src-tauri/android/', import.meta.url))) {
  const read = name => readFileSync(resolve(base, name), 'utf8')
  const stats = read('NativeStatsPanel.kt'), controller = read('NativePagesController.kt'), settings = read('NativeSettingsPanel.kt')
  const render = stats.split('fun render(): View {')[1]?.split('private fun payload(')[0] ?? ''
  assert.match(render, /recoveryEntry\(\)[\s\S]*?load\(\)/, 'recovery entry must exist before a statistics query can fail')
  const draw = stats.split('private fun draw(')[1]?.split('val today')[0] ?? ''
  assert.match(draw, /recoveryEntry\(\)/, 'successful repaint must retain the recovery entry')
  assert.match(stats, /private fun recoveryEntry\(\)[\s\S]*?button\([\s\S]*?recoverSettings\(\)/)
  const goal = stats.split('private fun editGoal(')[1] ?? ''
  assert.match(goal, /NativeStatsSettingsDialog\([\s\S]*?AlertDialog\.BUTTON_NEUTRAL to tr\("核对恢复", "Recovery"\)/)
  assert.match(goal, /getButton\(AlertDialog\.BUTTON_NEUTRAL\)\.setOnClickListener \{ if \(!saving\) recoverSettings\(\) \}/)
  assert.match(controller, /NativeStatsPanel\([\s\S]*?::showSettingsRecovery/)
  const frame = controller.split('private fun frame() {')[1]?.split('private fun pathFor(')[0] ?? ''
  assert.match(frame, /NativeUi\.iconButton\([\s\S]*?label\("核对恢复"\)[\s\S]*?::showSettingsRecovery/, 'shared native toolbar must also reach recovery without routing')
  assert.doesNotMatch(controller.split('private fun showSettingsRecovery() {')[1]?.split('private inner class DailyBars')[0] ?? '', /page != "stats"/, 'shared entry must not restrict recovery to Statistics')
  const entry = controller.split('private fun showSettingsRecovery() {')[1]?.split('private inner class DailyBars')[0] ?? ''
  assert.match(entry, /settingsPanel\s*\?:\s*NativeSettingsPanel\(/)
  assert.match(entry, /panel\.showRecovery\(\)/)
  assert.doesNotMatch(entry, /navigate\(|recover\(|reloadNativeSettings|flushNativeSettings/, 'opening recovery cannot depend on the failed navigation/action barrier')
  assert.match(settings, /fun showRecovery\(\)[\s\S]*?if \(closed \|\| busy \|\| dialog\?\.isShowing == true\) return[\s\S]*?recovery\(\)/)
  assert.match(settings, /perform\("settingsRecoveryInspect"/)
  assert.match(settings, /perform\("settingsRecoveryDecide"/)
  assert.match(controller, /settingsPanel\?\.canLeave\(\) == false/)
}
