import { describe, expect, it } from 'vitest'
import { chunkCycleGuardPlugin, findChunkCycles, vendorChunk } from '../../lib/buildChunks'

const pnpm = (pkg: string, version: string, file: string) =>
  `/repo/node_modules/.pnpm/${pkg.replace('/', '+')}@${version}/node_modules/${pkg}/${file}`

describe('vendorChunk', () => {
  it('puts react, react-dom and scheduler (including deep imports) into react-vendor', () => {
    expect(vendorChunk(pnpm('react', '19.2.6', 'index.js'))).toBe('react-vendor')
    expect(vendorChunk(pnpm('react', '19.2.6', 'cjs/react-jsx-runtime.production.js'))).toBe(
      'react-vendor',
    )
    expect(vendorChunk(pnpm('react-dom', '19.2.6', 'client.js'))).toBe('react-vendor')
    expect(vendorChunk(pnpm('scheduler', '0.27.0', 'index.js'))).toBe('react-vendor')
  })

  it('does not pull packages that merely live under a react/ directory into react-vendor', () => {
    // 回归：@xyflow/react 的路径含 `/react/`，曾让 react-vendor 与 zustand 两个分片互相 import。
    const xyflow = pnpm('@xyflow/react', '12.12.0', 'dist/esm/index.js')
    expect(xyflow).toContain('/react/')
    expect(vendorChunk(xyflow)).toBeUndefined()
    expect(vendorChunk(pnpm('@xyflow/system', '0.0.80', 'dist/esm/index.js'))).toBeUndefined()
    expect(vendorChunk(pnpm('@radix-ui/react-dialog', '1.1.15', 'dist/index.mjs'))).toBeUndefined()
  })

  it('keeps every zustand version and its runtime dependency in one chunk', () => {
    expect(vendorChunk(pnpm('zustand', '5.0.13', 'esm/index.mjs'))).toBe('zustand')
    expect(vendorChunk(pnpm('zustand', '4.5.7', 'esm/index.mjs'))).toBe('zustand')
    expect(vendorChunk(pnpm('use-sync-external-store', '1.6.0', 'shim/with-selector.js'))).toBe(
      'zustand',
    )
  })

  it('handles Windows separators and the polyfills entry', () => {
    expect(vendorChunk('C:\\repo\\node_modules\\react-dom\\client.js')).toBe('react-vendor')
    expect(vendorChunk('/repo/apps/web/src/boot/polyfills.ts')).toBe('polyfills')
    expect(vendorChunk('/repo/apps/web/src/App.tsx')).toBeUndefined()
  })
})

describe('findChunkCycles', () => {
  const chunk = (...imports: string[]) => ({ type: 'chunk', imports })

  it('reports nothing for an acyclic graph, including diamonds', () => {
    expect(
      findChunkCycles({
        'main.js': chunk('react-vendor.js', 'zustand.js'),
        'zustand.js': chunk('react-vendor.js'),
        'react-vendor.js': chunk(),
        'logo.svg': { type: 'asset' },
      }),
    ).toEqual([])
  })

  it('finds the react-vendor <-> zustand cycle', () => {
    expect(
      findChunkCycles({
        'main.js': chunk('react-vendor.js'),
        'zustand.js': chunk('react-vendor.js'),
        'react-vendor.js': chunk('zustand.js'),
      }),
    ).toEqual([['react-vendor.js', 'zustand.js']])
  })

  it('finds self imports and ignores imports of external modules', () => {
    expect(findChunkCycles({ 'a.js': chunk('a.js', 'https://cdn/x.js') })).toEqual([['a.js']])
  })

  it('makes the build fail with the cycle in the message', () => {
    const plugin = chunkCycleGuardPlugin()
    const ctx = {
      error(message: string): never {
        throw new Error(message)
      },
    }
    const bundle = { 'a.js': chunk('b.js'), 'b.js': chunk('a.js') }
    expect(() => plugin.generateBundle.call(ctx, {}, bundle)).toThrow(/a\.js <-> b\.js/)
  })
})
