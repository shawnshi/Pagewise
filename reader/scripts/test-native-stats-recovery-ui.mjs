import test from 'node:test'
import { resolve } from 'node:path'
import { assertNativeStatsRecoveryBindings } from './native-stats-recovery-ui-test-tools.mjs'
test('R3-01: statistics recovery remains reachable before query, after repaint and inside failed goal input without navigation', () => {
  assertNativeStatsRecoveryBindings(process.env.NATIVE_STATS_UI_BASELINE ? resolve(process.env.NATIVE_STATS_UI_BASELINE) : undefined)
})
