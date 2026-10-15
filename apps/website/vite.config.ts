import { resolve } from 'node:path'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { guideImageSizes } from './imageSizes'
import { seoPlugin } from './seo'
import { pageList } from './src/catalog'

const origin = process.env.PUBLIC_ORIGIN?.replace(/\/+$/, '') || ''
if (origin && (new URL(origin).origin !== origin || !/^https?:\/\//.test(origin))) {
  throw new Error('PUBLIC_ORIGIN must be an http(s) origin')
}
export default defineConfig({
  publicDir: '../web/public',
  resolve: {
    alias: { '@': resolve(import.meta.dirname, '../web/src') },
    dedupe: ['react', 'react-dom'],
  },
  define: {
    __GUIDE_IMAGE_SIZES__: JSON.stringify(
      guideImageSizes(resolve(import.meta.dirname, '../web/public')),
    ),
    __APP_VERSION__: JSON.stringify(process.env.APP_RELEASE || '0.4.0'),
    'import.meta.env.VITE_PUBLIC_ORIGIN': JSON.stringify(origin),
    'import.meta.env.VITE_SEARCH_INDEXING': JSON.stringify(process.env.SEARCH_INDEXING !== 'false'),
  },
  plugins: [
    tanstackStart({
      prerender: {
        enabled: true,
        autoStaticPathsDiscovery: false,
        crawlLinks: false,
        concurrency: 1,
        failOnError: true,
      },
      pages: pageList.map((page) => ({ path: page.path })),
    }),
    react(),
    seoPlugin(origin, process.env.SEARCH_INDEXING !== 'false'),
  ],
  build: { copyPublicDir: false, assetsDir: 'website-assets' },
})
