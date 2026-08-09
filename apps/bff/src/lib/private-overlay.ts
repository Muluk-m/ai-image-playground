import { Elysia } from 'elysia'
// biome-ignore lint/style/noRestrictedImports: This audited seam is the only public-tree import of private/.
import type { privateBffRoutes as privateBffRoutesContract } from '../../../../private/apps/bff/index.ts'

type PrivateBffModule = {
  readonly privateBffRoutes: typeof privateBffRoutesContract
}

export interface PrivateBffOverlay {
  readonly present: boolean
  readonly routes: Elysia
}

export const EMPTY_PRIVATE_BFF_OVERLAY: PrivateBffOverlay = Object.freeze({
  present: false,
  routes: new Elysia({ name: 'private-bff-empty' }),
})

const privateEntryUrl = new URL('../../../../private/apps/bff/index.ts', import.meta.url)

export async function loadPrivateBffOverlay(): Promise<PrivateBffOverlay> {
  if (!(await Bun.file(privateEntryUrl).exists())) return EMPTY_PRIVATE_BFF_OVERLAY
  const privateModule: PrivateBffModule = await import(privateEntryUrl.href)

  if (!(privateModule.privateBffRoutes instanceof Elysia)) {
    throw new Error('private/apps/bff/index.ts must export privateBffRoutes as an Elysia plugin')
  }
  return Object.freeze({ present: true, routes: privateModule.privateBffRoutes })
}
