import type { InlineConfig, ViteDevServer } from 'vite'

export declare const readerRoot: string
export declare function isolatedCacheDir(base?: string, root?: string): string
export declare function createServer(inlineConfig?: InlineConfig): Promise<ViteDevServer>
export declare const build: typeof import('vite').build
export declare const preview: typeof import('vite').preview
export { normalizePath } from 'vite'
