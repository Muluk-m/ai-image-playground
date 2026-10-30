import type { IndexHtmlTransformContext } from 'vite'
import { describe, expect, it } from 'vitest'
import { appPreloadLinks } from '../../boot/appPreload'

type Bundle = NonNullable<IndexHtmlTransformContext['bundle']>

function chunk(
  fileName: string,
  opts: {
    imports?: string[]
    dynamicImports?: string[]
    modules?: string[]
    css?: string[]
    dynamic?: boolean
  } = {},
) {
  return {
    type: 'chunk',
    fileName,
    imports: opts.imports ?? [],
    dynamicImports: opts.dynamicImports ?? [],
    moduleIds: opts.modules ?? [],
    isDynamicEntry: opts.dynamic ?? false,
    viteMetadata: { importedCss: new Set(opts.css ?? []), importedAssets: new Set() },
  }
}

function bundle(...chunks: ReturnType<typeof chunk>[]): Bundle {
  return Object.fromEntries(chunks.map((c) => [c.fileName, c])) as unknown as Bundle
}

// 入口静态依赖 vendor，动态 import AuthGate；AuthGate 再动态 import App；App 和入口共用 vendor，另有自己的 shared。
const graph = () =>
  bundle(
    chunk('assets/index.js', {
      imports: ['assets/vendor.js'],
      dynamicImports: ['assets/AuthGate.js'],
    }),
    chunk('assets/vendor.js'),
    chunk('assets/AuthGate.js', {
      dynamic: true,
      imports: ['assets/vendor.js', 'assets/zustand.js'],
      dynamicImports: ['assets/App.js'],
      modules: ['/repo/apps/web/src/auth/AuthGate.tsx'],
      css: ['assets/AuthGate.css'],
    }),
    chunk('assets/zustand.js'),
    chunk('assets/App.js', {
      dynamic: true,
      imports: ['assets/vendor.js', 'assets/shared.js'],
      dynamicImports: ['assets/Lazy.js'],
      modules: ['/repo/apps/web/src/App.tsx'],
      css: ['assets/App.css'],
    }),
    chunk('assets/shared.js'),
    chunk('assets/Lazy.js', { dynamic: true }),
  )

describe('appPreloadLinks', () => {
  it('预取从入口到 App 一路上的分片及其静态依赖，跳过入口已加载的和 App 里再懒加载的', () => {
    const links = appPreloadLinks(graph(), 'assets/index.js')
    const hrefs = links.map((l) => /href="([^"]+)"/.exec(l)?.[1])
    expect(hrefs).toEqual([
      '/assets/AuthGate.js',
      '/assets/zustand.js',
      '/assets/App.js',
      '/assets/shared.js',
      '/assets/AuthGate.css',
      '/assets/App.css',
    ])
    expect(links.filter((l) => l.includes('rel="modulepreload"'))).toHaveLength(4)
    expect(links.filter((l) => l.includes('rel="preload" as="style"'))).toHaveLength(2)
    expect(links.every((l) => l.includes('crossorigin'))).toBe(true)
    expect(hrefs).not.toContain('/assets/vendor.js')
    expect(hrefs).not.toContain('/assets/Lazy.js')
  })

  it('找不到 App 分片就什么都不加，不猜', () => {
    const b = graph()
    delete (b as Record<string, unknown>)['assets/App.js']
    expect(appPreloadLinks(b, 'assets/index.js')).toEqual([])
    expect(appPreloadLinks(undefined, 'assets/index.js')).toEqual([])
    expect(appPreloadLinks(graph(), undefined)).toEqual([])
  })
})
