// Android 首次启动语言与开发浏览器的通用语言判断。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { systemLanguage } from '../src/stores/settings.ts'

const WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0'
const ANDROID = 'Mozilla/5.0 (Linux; Android 12; M2004J11G) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/135.0 Mobile Safari/537.36'
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)'

test('Chinese systems (simplified and traditional) get Chinese, everything else English', () => {
  for (const lang of ['zh-CN', 'zh-TW', 'zh-Hans-CN', 'zh', 'ZH-hk']) assert.equal(systemLanguage(lang, WIN), 'zh', lang)
  for (const lang of ['en-US', 'en-GB', 'ja-JP', 'de-DE', 'zhx']) assert.equal(systemLanguage(lang, WIN), 'en', lang)
  assert.equal(systemLanguage('en-US', ANDROID), 'en')
  assert.equal(systemLanguage('zh-CN', ANDROID), 'zh')
})

test('unreliable or missing language keeps the default', () => {
  assert.equal(systemLanguage('en-US', MAC), undefined, 'WKWebView often reports English on Chinese macOS')
  assert.equal(systemLanguage('', WIN), undefined)
})
