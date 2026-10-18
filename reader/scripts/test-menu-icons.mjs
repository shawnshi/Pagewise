import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from './vite-isolated.mjs'
import vue from '@vitejs/plugin-vue'
import { h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { iconMarkup, markedBookmarkMarkup } from '../src/components/menuIcons.ts'
import zh from '../src/i18n/zh.ts'
import en from '../src/i18n/en.ts'

let server, AppIcon
before(async () => {
  server = await createServer({
    configFile: false,
    root: fileURLToPath(new URL('../', import.meta.url)),
    cacheDir: fileURLToPath(new URL('../../.cache/menu-icons-v1-20261017/ssr-vite', import.meta.url)),
    plugins: [vue()],
    server: { middlewareMode: true, hmr: false },
    logLevel: 'error',
  })
  AppIcon = (await server.ssrLoadModule('/src/components/AppIcon.vue')).default
})
after(async () => { await server?.close() })

const render = props => renderToString(h(AppIcon, props))
const canonicalNames = [
  'library', 'currently-reading', 'notes', 'reading-history', 'settings', 'table-of-contents',
  'typography', 'annotations', 'search-in-book', 'reading-modes', 'reading-assistant',
  'read-aloud', 'bookmarks', 'search-library',
]

test('v1 contains exactly 14 static monochrome glyphs and one marked bookmark state', () => {
  assert.deepEqual(Object.keys(iconMarkup).sort(), [...canonicalNames].sort())
  for (const markup of [...Object.values(iconMarkup), markedBookmarkMarkup]) {
    assert.doesNotMatch(markup, /<(?:script|style|image|use|foreignObject)\b|\b(?:href|src|on[a-z]+)\s*=|url\(|#[0-9a-f]{3,8}\b/i)
    for (const tag of markup.matchAll(/<\/?([a-z][\w-]*)\b/gi)) {
      assert.ok(['path', 'rect', 'circle'].includes(tag[1]), `Unexpected SVG tag ${tag[1]}`)
    }
  }
  assert.notEqual(iconMarkup.notes, iconMarkup.annotations, 'cross-book notes and book annotations differ')
  assert.notEqual(iconMarkup['search-library'], iconMarkup['search-in-book'])
  assert.notEqual(iconMarkup['currently-reading'], iconMarkup['reading-modes'])
})

for (const name of canonicalNames) test(`Vue renders supplied ${name} glyph at 28px with 2px round strokes`, async () => {
  const html = await render({ name })
  assert.ok(html.includes(iconMarkup[name]))
  assert.match(html, /viewBox="0 0 24 24"/i)
  assert.match(html, /width="28px"/)
  assert.match(html, /height="28px"/)
  assert.match(html, /fill="none"/)
  assert.match(html, /stroke="currentColor"/)
  assert.match(html, /stroke-width="2"/)
  assert.match(html, /stroke-linecap="round"/)
  assert.match(html, /stroke-linejoin="round"/)
  assert.match(html, /aria-hidden="true"/)
})

test('Vue renders 2.25px emphasis without filling non-bookmark glyphs', async () => {
  const html = await render({ name: 'reading', emphasis: true })
  assert.match(html, /data-icon="currently-reading"/)
  assert.match(html, /stroke-width="2.25"/)
  assert.ok(html.includes(iconMarkup['currently-reading']))
  assert.doesNotMatch(html, /fill="currentColor"/)
})

test('bookmark action uses the marked SVG only when saved; menu state remains outline', async () => {
  const outline = await render({ name: 'bookmarks', emphasis: true })
  assert.ok(outline.includes(iconMarkup.bookmarks))
  assert.doesNotMatch(outline, /fill="currentColor"/)
  for (const props of [{ name: 'bookmarks', marked: true }, { name: 'bookmark' }]) {
    assert.ok((await render(props)).includes(markedBookmarkMarkup))
  }
  assert.ok((await render({ name: 'bookmarkBorder' })).includes(iconMarkup.bookmarks))
})

test('utility glyphs, explicit dimensions, and unknown/prototype names preserve safe contracts', async () => {
  assert.match(await render({ name: 'back' }), /width="24px"/)
  assert.match(await render({ name: 'library', size: 32 }), /width="32px"/)
  assert.match(await render({ name: 'library', size: '2em' }), /width="2em"/)
  for (const name of ['unknown', '__proto__', 'constructor']) {
    const html = await render({ name })
    assert.match(html, /M12 2a10 10/, 'unknown glyphs fall back to information, not inherited properties')
    assert.doesNotMatch(html, /data-icon=/)
  }
  const accessible = await render({ name: 'library', ariaHidden: false, role: 'img', 'aria-label': 'Book library' })
  assert.match(accessible, /role="img"/)
  assert.match(accessible, /aria-label="Book library"/)
  assert.doesNotMatch(accessible, /aria-hidden=/)
})

test('menu names and related accessible titles use consistent Chinese and English terms', () => {
  for (const [messages, expected] of [[zh, {
    'nav.library': '书库', 'library.title': '书库', 'nav.notes': '笔记',
    'reader.annotationsBookmarks': '批注', 'reader.dockNotes': '批注', 'reader.highlightsTab': '批注',
    'tts.title': '朗读', 'ai.title': '阅读助手',
  }], [en, {
    'nav.library': 'Library', 'nav.notes': 'Notes', 'reader.annotationsBookmarks': 'Annotations',
    'reader.dockNotes': 'Annotations', 'reader.highlightsTab': 'Annotations',
    'tts.title': 'Read aloud', 'ai.title': 'Reading assistant',
  }]]) {
    for (const [key, text] of Object.entries(expected)) assert.equal(messages[key], text, key)
  }
  assert.doesNotMatch(Object.values(zh).join('\n'), /藏书|划线想法|听书|AI\s?助手/i)
})
