import type { ComponentType } from 'react'

export interface PrivateAdminUserSummary {
  primary: string
  secondary: string
  tone?: 'default' | 'warning'
}

export interface PrivateAdminOverlay {
  present: boolean
  userSummaryColumnTitle: string
  useUserSummaries(userIds: readonly string[]): Readonly<Record<string, PrivateAdminUserSummary>>
  OverviewPanel: ComponentType
  UserDetailPanel: ComponentType<{ userId: string; username: string }>
}

const EmptyComponent = () => null
const EMPTY_SUMMARIES: Readonly<Record<string, PrivateAdminUserSummary>> = Object.freeze({})
const EMPTY_OVERLAY: PrivateAdminOverlay = Object.freeze({
  present: false,
  userSummaryColumnTitle: '',
  useUserSummaries: () => EMPTY_SUMMARIES,
  OverviewPanel: EmptyComponent,
  UserDetailPanel: EmptyComponent,
})

// biome-ignore lint/style/noRestrictedImports: This audited seam is the only public-tree import of private/.
const privateModules = import.meta.glob('../../../../private/apps/admin/index.tsx', { eager: true })

function resolveOverlay(): PrivateAdminOverlay {
  const modules = Object.values(privateModules)
  if (modules.length === 0) return EMPTY_OVERLAY
  if (modules.length > 1) throw new Error('Only one private Admin overlay entry is allowed')

  const module = modules[0]
  if (!module || typeof module !== 'object' || !('privateAdminOverlay' in module)) {
    throw new Error('private/apps/admin/index.tsx must export privateAdminOverlay')
  }
  const overlay = module.privateAdminOverlay
  if (
    !overlay ||
    typeof overlay !== 'object' ||
    !('present' in overlay) ||
    overlay.present !== true ||
    !('userSummaryColumnTitle' in overlay) ||
    typeof overlay.userSummaryColumnTitle !== 'string' ||
    !('useUserSummaries' in overlay) ||
    typeof overlay.useUserSummaries !== 'function' ||
    !('OverviewPanel' in overlay) ||
    typeof overlay.OverviewPanel !== 'function' ||
    !('UserDetailPanel' in overlay) ||
    typeof overlay.UserDetailPanel !== 'function'
  ) {
    throw new Error('privateAdminOverlay does not implement the complete extension contract')
  }
  return overlay as PrivateAdminOverlay
}

const overlay = resolveOverlay()

export const privateAdminOverlayPresent = overlay.present
export const privateUserSummaryColumnTitle = overlay.userSummaryColumnTitle
export const PrivateAdminOverviewPanel = overlay.OverviewPanel
export const PrivateAdminUserDetailPanel = overlay.UserDetailPanel

export function usePrivateAdminUserSummaries(
  userIds: readonly string[],
): Readonly<Record<string, PrivateAdminUserSummary>> {
  return overlay.useUserSummaries(userIds)
}
