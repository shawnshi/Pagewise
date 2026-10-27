import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import ts from 'typescript'

function readSrc(relPath) {
  return readFileSync(new URL(`../src/${relPath}`, import.meta.url), 'utf8')
}

test('AppIcon.vue: supports all contract-named monochrome 24x24 SVG icons', () => {
  const content = readSrc('components/AppIcon.vue')
  const { descriptor, errors } = parse(content)
  assert.equal(errors.length, 0, 'AppIcon.vue parses cleanly')

  const contractIcons = [
    'library', 'reading', 'notes', 'history', 'stats', 'settings',
    'folder', 'refresh', 'info', 'back', 'toc', 'typography',
    'search', 'ai', 'audio', 'fullscreen', 'more', 'close', 'delete',
  ]

  for (const name of contractIcons) {
    assert.match(content, new RegExp(`\\b${name}:`), `AppIcon has icon "${name}"`)
  }

  // Compile script and template in memory
  const script = compileScript(descriptor, { id: 'app-icon-test' })
  assert.ok(script, 'AppIcon script compiles')
  const template = compileTemplate({
    source: descriptor.template.content,
    filename: 'AppIcon.vue',
    id: 'app-icon-test',
    compilerOptions: { bindingMetadata: script.bindings },
  })
  assert.equal(template.errors.length, 0, 'AppIcon template compiles')
  assert.match(descriptor.template.content, /viewBox="0 0 24 24"/, 'SVG viewBox is 0 0 24 24')
})

test('router/index.ts: contains compatibility redirects for retired paper product routes', () => {
  const content = readSrc('router/index.ts')
  // /papers redirects to /library
  assert.match(content, /path:\s*['"]\/papers['"],\s*redirect:\s*['"]\/library['"]/, '/papers redirects to /library')
  const ast = ts.createSourceFile('router.ts', content, ts.ScriptTarget.Latest, true)
  let redirect
  function visit(node) {
    if (ts.isObjectLiteralExpression(node) && node.properties.some(p => ts.isPropertyAssignment(p) && p.name.getText(ast) === 'path' && p.initializer.text === '/read-paper/:id')) {
      redirect = node.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(ast) === 'redirect').initializer
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  assert.ok(redirect, 'legacy PDF redirect exists')
  const actualRedirect = runInNewContext(`(${redirect.getText(ast)})`)
  const query = { loc: 'page=3' }
  const target = actualRedirect({ params: { id: 'legacy/id' }, query, hash: '#anchor' })
  assert.equal(target.path, '/read-pdf/legacy%2Fid')
  assert.equal(target.query, query, 'note location survives compatibility redirect')
  assert.equal(target.hash, '#anchor')
  // /read-pdf/:id loads PdfReaderView
  assert.match(content, /path:\s*['"]\/read-pdf\/:id['"],\s*component:\s*\(\)\s*=>\s*import\(['"]\.\.\/views\/PdfReaderView\.vue['"]\)/, '/read-pdf/:id mapped to PdfReaderView')
  // beforeEach guard covers /read-pdf/
  assert.match(content, /to\.path\.startsWith\('\/read-pdf\/'\)/, 'beforeEach guard covers /read-pdf/')
})

test('App.vue: integrates useFolderLibrary lifecycle, expands immersive routes, uses AppIcon with visible labels', () => {
  const content = readSrc('App.vue')
  const { descriptor, errors } = parse(content)
  assert.equal(errors.length, 0, 'App.vue parses cleanly')

  // Immersive route check includes /read-pdf/
  assert.match(content, /immersive\s*=\s*computed\(\(\)\s*=>\s*\/\^\\\/read\(\?:\\\/\|-\(\?:paper\|pdf\)\\\/\)\/\.test\(route\.path\)\)/, 'App.vue immersive regex includes /read-pdf/')

  // useFolderLibrary monitoring integration
  assert.match(content, /useFolderLibrary/, 'App.vue imports/uses useFolderLibrary')
  assert.match(content, /stopFolderLibrary\s*=\s*folderLibrary\.start\(\)/, 'App.vue starts folder monitoring on mount')
  assert.match(content, /stopFolderLibrary\?\.?\(\)/, 'App.vue stops folder monitoring on unmount')
  assert.match(content, /folderLibrary\.status\.value\.generation/, 'App.vue watches folder generation to refresh library')

  // Global navigation uses AppIcon and visible labels
  assert.match(content, /<AppIcon\s+:name="n\.icon"/, 'App.vue nav uses AppIcon')
  assert.match(content, /<span class="nav-label">\{\{\s*navLabel\(n\)\s*\}\}<\/span>/, 'App.vue has visible text label for nav items')

  const navMinHeight = css => Number(css.match(/\.nav-item\s*\{[^}]*min-height:\s*(\d+)px/)?.[1] ?? 0)
  assert.ok(navMinHeight(content) >= 48, 'App.vue navigation target must be at least 48px; larger targets are valid')
  assert.ok(navMinHeight('.nav-item { min-height: 47px; }') < 48, 'The source oracle must still reject undersized navigation targets')

  // Script and template compile
  const script = compileScript(descriptor, { id: 'app-test' })
  assert.ok(script, 'App.vue script compiles')
})

test('BookCard.vue: compact rows show available author/topics without fabricated metadata and protect sourceRef deletion', () => {
  const content = readSrc('components/BookCard.vue')
  const { descriptor, errors } = parse(content)
  assert.equal(errors.length, 0, 'BookCard.vue parses cleanly')

  // Compact rows omit absent author fields; publication metadata remains in BookDetail.
  assert.match(content, /v-if="book\.author"[^>]*>\{\{ book\.author \}\}/, 'Author is displayed only when supplied')
  assert.match(content, /visibleBookTopics\(props\.book\)/, 'Visible topics use the bounded projection without truncating stored tags')
  assert.match(content, /v-for="tag in topics"/, 'BookCard displays its topic projection')
  const detail = readSrc('views/BookDetailView.vue')
  assert.match(detail, /book\.publisher/)
  assert.match(detail, /book\.publicationDate/)

  // SourceRef handling
  assert.match(content, /book\.sourceRef/, 'BookCard checks book.sourceRef')
  assert.match(content, /t\('book\.sourceManagedHint'\)/, 'BookCard explains sourceManagedHint')
  assert.match(content, /v-if="!book\.sourceRef"[\s\S]*t\('book\.removeFromLibrary'\)/, 'BookCard only renders remove button when not sourceRef')

  // No booklist or convert dependencies
  assert.doesNotMatch(content, /addToBooklist/, 'BookCard has no addToBooklist')
  assert.doesNotMatch(content, /convertToEpub/, 'BookCard has no manual convertToEpub')

  // Minimum hit target 48px
  assert.match(content, /min-height:\s*48px/, 'BookCard actions have min-height 48px')

  // Compile
  const script = compileScript(descriptor, { id: 'book-card-test' })
  assert.ok(script, 'BookCard script compiles')
})

test('BookDetailView.vue: displays metadata overview, sourceRef status, and explains source book deletion', () => {
  const content = readSrc('views/BookDetailView.vue')
  const { descriptor, errors } = parse(content)
  assert.equal(errors.length, 0, 'BookDetailView.vue parses cleanly')

  // Metadata overview
  assert.match(content, /book\.author\s*\|\|\s*t\('book\.unknownAuthor'\)/, 'BookDetailView displays author or placeholder')
  assert.match(content, /book\.publisher\s*\|\|\s*t\('book\.unknownPublisher'\)/, 'BookDetailView displays publisher or placeholder')
  assert.match(content, /book\.publicationDate\s*\|\|\s*t\('book\.unknownDate'\)/, 'BookDetailView displays publicationDate or placeholder')
  assert.match(content, /book\.tags/, 'BookDetailView displays tags')

  // Source reference display and deletion guard
  assert.match(content, /book\.sourceRef/, 'BookDetailView checks book.sourceRef')
  assert.match(content, /book\.sourceRef\.relativePath/, 'BookDetailView shows sourceRef relativePath')
  assert.match(content, /v-if="!book\.sourceRef"[\s\S]*removeBook/, 'BookDetailView only shows delete button for non-sourceRef books')
  assert.match(content, /source-managed-notice/, 'BookDetailView displays source-managed-notice for sourceRef books')

  // Back button has AppIcon and visible label
  assert.match(content, /<AppIcon\s+name="back"/, 'BookDetailView back button uses AppIcon')
  assert.match(content, /<span>\{\{\s*t\('common\.back'\)\s*\}\}<\/span>/, 'BookDetailView back button has visible text label')

  // Compile
  const script = compileScript(descriptor, { id: 'book-detail-test' })
  assert.ok(script, 'BookDetailView script compiles')
})

test('LibraryView.vue: removes retired actions and provides actionable file-health status and folder settings', () => {
  const content = readSrc('views/LibraryView.vue')
  const { descriptor, errors } = parse(content)
  assert.equal(errors.length, 0, 'LibraryView.vue parses cleanly')

  // No booklist UI
  assert.doesNotMatch(content, /BooklistWantedPanel/, 'LibraryView has no BooklistWantedPanel')
  assert.doesNotMatch(content, /BooklistShareDialog/, 'LibraryView has no BooklistShareDialog')
  assert.doesNotMatch(content, /BooklistImportDialog/, 'LibraryView has no BooklistImportDialog')
  assert.doesNotMatch(content, /booklist-section/, 'LibraryView has no booklist-section')
  assert.doesNotMatch(content, /openCreateBooklist/, 'LibraryView has no openCreateBooklist')

  // No manual convert to EPUB
  assert.doesNotMatch(content, /convertBooks/, 'LibraryView has no convertBooks')
  assert.doesNotMatch(content, /convertLibraryBook/, 'LibraryView has no convertLibraryBook')
  assert.doesNotMatch(content, /canConvertToEpub/, 'LibraryView has no canConvertToEpub')

  // No paperMode distinction
  assert.doesNotMatch(content, /paperMode/, 'LibraryView has no paperMode')
  assert.doesNotMatch(content, /batchMoveKind/, 'LibraryView has no batchMoveKind')

  // Folder control moved to Settings; the library exposes actionable availability errors.
  assert.match(content, /useFolderLibrary/, 'LibraryView integrates useFolderLibrary')
  assert.match(content, /class="library-notice" role="status"/, 'File-health errors have a status region')
  assert.match(content, /const folderStatus = computed\(\(\) => folderLibrary\.value\.status\.value\)/, 'LibraryView checks the reactive folder service state')
  assert.match(content, /folderStatus\.value\.state/, 'Folder state drives the notice and scan status')
  assert.match(content, /@click="showUnavailable"/, 'Unavailable books can be inspected')
  assert.match(content, /to="\/settings\?section=folder"/, 'Folder authorization and rescan remain accessible in Settings')

  // Batch delete protects source-ref books
  assert.match(content, /sourceRef/, 'LibraryView batchDelete checks sourceRef')
  assert.match(content, /t\('book\.sourceManagedHint'\)/, 'LibraryView batchDelete notifies if sourceRef books skipped')

  // Compile
  const script = compileScript(descriptor, { id: 'library-view-test' })
  assert.ok(script, 'LibraryView script compiles')
})

test('SettingsView.vue: integrates AiProviderSelector, removes onAiProviderChange, displays monitored folder section', () => {
  const content = readSrc('views/SettingsView.vue')
  const { descriptor, errors } = parse(content)
  assert.equal(errors.length, 0, 'SettingsView.vue parses cleanly')

  // AI Provider Selector integration
  assert.match(content, /<AiProviderSelector\s*\/>/, 'SettingsView embeds AiProviderSelector')
  assert.doesNotMatch(content, /function onAiProviderChange/, 'SettingsView removes onAiProviderChange')

  // Monitored folder section
  assert.match(content, /id="settings-folder"/, 'SettingsView has settings-folder section')
  assert.match(content, /useFolderLibrary/, 'SettingsView uses useFolderLibrary')
  assert.match(content, /settings\.monitoredFolderNotice/, 'SettingsView distinguishes source folder from database root')
  assert.match(content, /settings\.privacyNote/, 'About explains local data and AI data flow')
  assert.match(content, /github\.com\/shawnshi\/Pagewise/, 'About links the Pagewise source repository')
  assert.match(content, /function openExternal/, 'About links open through the native opener')
  assert.doesNotMatch(readSrc('services/aiProviders.ts'), /TxUlXG3u/, 'AI provider links carry no referral code')

  // Compile
  const script = compileScript(descriptor, { id: 'settings-view-test' })
  assert.ok(script, 'SettingsView script compiles')
})

test('ReaderView.vue: visible Chinese/English text labels on major reader actions, grouped More menu, >= 48px hit areas', () => {
  const content = readSrc('views/ReaderView.vue')
  const { descriptor, errors } = parse(content)
  assert.equal(errors.length, 0, 'ReaderView.vue parses cleanly')

  // Back button has visible label and AppIcon
  assert.match(content, /<button[^>]*reader-back-btn[^>]*>[\s\S]*?<AppIcon\s+name="back"[\s\S]*?\{\{\s*t\('common\.back'\)\s*\}\}/, 'ReaderView back button has visible label and AppIcon')

  // Major actions prioritized with visible labels: TOC, Typography, Notes, Search, AI
  assert.match(content, /t\('reader\.toc'\)/, 'TOC action present with visible label')
  assert.match(content, /t\('reader\.dockTypography'\)/, 'Typography action present with visible label')
  assert.match(content, /t\('reader\.dockNotes'\)/, 'Notes action present with visible label')
  assert.match(content, /t\('common\.search'\)/, 'Search action present with visible label')
  assert.match(content, /t\('ai\.title'\)/, 'AI action present with visible label')

  // Secondary actions in More menu
  assert.match(content, /readerMoreOpen/, 'ReaderView has readerMoreOpen state')
  assert.match(content, /reader-more-menu/, 'ReaderView has reader-more-menu')
  assert.match(content, /t\('reader\.bookmark'\)/, 'Primary toolbar contains bookmark')
  assert.match(content, /t\('tts\.title'\)/, 'Primary toolbar contains tts')
  assert.doesNotMatch(content, /ambient|AmbientPanel/, 'More menu and reader no longer expose ambient sound')
  const more = content.slice(content.indexOf('<div v-if="readerMoreOpen"'), content.indexOf('<!-- 正文 -->'))
  assert.match(more, /t\('readingMode\.title'\)/, 'More menu contains readingMode')
  assert.match(more, /toggleFullscreen/, 'More menu contains fullscreen')
  assert.doesNotMatch(more, /toggleBookmark|t\('tts\.title'\)/, 'Primary actions are not duplicated in More')

  // Dock buttons have AppIcon + text
  assert.match(content, /<AppIcon\s+name="toc"/, 'Dock has TOC AppIcon')
  assert.match(content, /<AppIcon\s+name="annotations"/, 'Dock has book annotations, distinct from global Notes')
  assert.match(content, /<AppIcon\s+name="audio"/, 'Dock has Audio AppIcon')
  assert.match(content, /<AppIcon\s+name="readingModes"/, 'Dock has Reading modes, distinct from currently reading')
  assert.match(content, /<AppIcon\s+name="typography"/, 'Dock has Typography AppIcon')

  // Minimum hit target area in styles
  assert.match(content, /\.icon-btn\s*\{[^}]*min-height:\s*48px/, '.icon-btn has min-height 48px')
  assert.match(content, /\.icon-btn\s*\{[^}]*min-width:\s*48px/, '.icon-btn has min-width 48px')

  // Preserved critical functions
  for (const fn of ['readerBack', 'handleNativeReaderBack', 'saveNote', 'navigateReader', 'onSectionLoad', 'setPrimaryPanel']) {
    assert.match(content, new RegExp(`function\\s+${fn}\\b`), `ReaderView retains ${fn}`)
  }

  // Compile
  const script = compileScript(descriptor, { id: 'reader-view-test' })
  assert.ok(script, 'ReaderView script compiles')
  assert.doesNotMatch(content, /TxUlXG3u/, 'ReaderView does not open a referral link')
})
