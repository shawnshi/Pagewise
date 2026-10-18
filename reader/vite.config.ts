import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isolatedCacheDir } from './scripts/vite-isolated.mjs'

import { BROWSER_TARGET, legacyCssFallbacks, legacyRegexRewrite } from './vite.legacy.ts'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'))

/**
 * 跨章连续滚动: foliate-js 的 view.js 用 `import('./paginator.js')` 加载渲染器,
 * 这里把它 (以及直接 import 的 foliate-js/paginator.js) 指向 src/vendor/foliate/paginator.js 的 fork。
 * 设计见 docs/continuous-scroll.md。
 */
function foliatePaginatorFork(): Plugin {
  const fork = fileURLToPath(new URL('./src/vendor/foliate/paginator.js', import.meta.url))
  return {
    name: 'lightread:foliate-paginator-fork',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source === 'foliate-js/paginator.js') return fork
      if (source === './paginator.js' && importer
        && /[\\/]foliate-js[\\/]view\.js(?:\?|$)/.test(importer)) return fork
      return null
    },
  }
}

export default defineConfig({
  cacheDir: isolatedCacheDir(),
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  // Android WebView assets only; the browser server is a development preview, not a PWA.
  plugins: [foliatePaginatorFork(), legacyRegexRewrite(), vue()],
  css: {
    postcss: { plugins: [legacyCssFallbacks()] },
  },
  build: {
    // 旧 WebView 兼容目标 (依据见 vite.legacy.ts); CSS 目标默认跟随, lightningcss 据此补前缀
    target: BROWSER_TARGET,
    chunkSizeWarningLimit: 2048,
    rolldownOptions: {
      output: {
        codeSplitting: {
          // polyfill 单独成块: 入口 chunk 的第一条 import, 先于 vue/设置等共享块求值
          groups: [{ name: 'polyfills', test: /[\\/]src[\\/]polyfills\.ts$/, priority: 100 }],
        },
      },
    },
  },
  worker: {
    // 目前没有模块 Worker (DjVu.js 的 Worker 由函数源码拼成 Blob, 走主包降级结果);
    // 显式写明, 以后新增 `new Worker(new URL(..., import.meta.url))` 时沿用同一目标的 ES 模块产物
    format: 'es',
  },
  // 开发模式不预构建 foliate-js: 预构建产物里 view.js 的 ./paginator.js 不经过上面的 fork 重定向
  optimizeDeps: {
    exclude: ['foliate-js'],
  },
  // Tauri 开发时使用固定端口
  server: {
    port: 5173,
    strictPort: true,
  },
})
