import type { InlineConfig, ViteDevServer } from 'vite'

export declare const readerRoot: string
export declare function isolatedCacheDir(base?: string, root?: string): string
export declare function createServer(inlineConfig?: InlineConfig): Promise<ViteDevServer>
export { normalizePath } from 'vite'
