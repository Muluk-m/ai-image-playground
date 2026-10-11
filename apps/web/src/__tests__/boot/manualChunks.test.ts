import { expect, it } from 'vitest'
import { manualChunks } from '../../boot/manualChunks'

const pnpm = (pkg: string, file: string) =>
  `/repo/node_modules/.pnpm/${pkg.replace('/', '+')}@1.0.0/node_modules/${pkg}/${file}`

it('puts React itself in the vendor chunk, including deep imports', () => {
  expect(manualChunks(pnpm('react', 'index.js'))).toBe('react-vendor')
  expect(manualChunks(pnpm('react', 'jsx-runtime.js'))).toBe('react-vendor')
  expect(manualChunks(pnpm('react-dom', 'client.js'))).toBe('react-vendor')
  expect(manualChunks(pnpm('scheduler', 'index.js'))).toBe('react-vendor')
})

it('keeps packages that merely have react in their path out of the vendor chunk', () => {
  // `@xyflow/react` 依赖 zustand：并进 react-vendor 会和 zustand 块互相引用，整站起不来。
  expect(manualChunks(pnpm('@xyflow/react', 'dist/esm/index.js'))).toBeUndefined()
  expect(manualChunks(pnpm('lucide-react', 'dist/esm/lucide-react.js'))).toBeUndefined()
})

it('splits zustand and the polyfills, and leaves app code alone', () => {
  expect(manualChunks(pnpm('zustand', 'esm/index.mjs'))).toBe('zustand')
  expect(manualChunks('/repo/apps/web/src/boot/polyfills.ts')).toBe('polyfills')
  expect(manualChunks('/repo/apps/web/src/main.tsx')).toBeUndefined()
})
