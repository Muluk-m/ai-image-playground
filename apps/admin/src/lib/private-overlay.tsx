import { useQuery } from '@tanstack/react-query'
import { notFound } from '@tanstack/react-router'
import { Settings } from 'lucide-react'
import type { ComponentType } from 'react'
import { apiClient } from './api-client'

export interface PrivateAdminUserSummary {
  primary: string
  secondary: string
  tone?: 'default' | 'warning'
}

export interface PrivateAdminOverlay {
  present: boolean
  userSummaryColumnTitle: string
  useUserSummaries(
    userIds: readonly string[],
    enabled: boolean,
  ): Readonly<Record<string, PrivateAdminUserSummary>>
  OverviewPanel: ComponentType
  SettingsPanel: ComponentType
  UserDetailPanel: ComponentType<{ userId: string; username: string }>
}

const EmptyComponent = () => null
const EMPTY_SUMMARIES: Readonly<Record<string, PrivateAdminUserSummary>> = Object.freeze({})
const EMPTY_OVERLAY: PrivateAdminOverlay = Object.freeze({
  present: false,
  userSummaryColumnTitle: '',
  useUserSummaries: () => EMPTY_SUMMARIES,
  OverviewPanel: EmptyComponent,
  SettingsPanel: EmptyComponent,
  UserDetailPanel: EmptyComponent,
})

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
    !('SettingsPanel' in overlay) ||
    typeof overlay.SettingsPanel !== 'function' ||
    !('UserDetailPanel' in overlay) ||
    typeof overlay.UserDetailPanel !== 'function'
  ) {
    throw new Error('privateAdminOverlay does not implement the complete extension contract')
  }
  return overlay as PrivateAdminOverlay
}

const overlay = resolveOverlay()

interface AdminExtensionManifest {
  navigation: Array<{ label: string; href: string }>
  user_links: Array<{ label: string; href_template: string }>
}

function useAdminExtensionManifest() {
  return useQuery({
    queryKey: ['admin-extensions'],
    queryFn: () => apiClient.get<AdminExtensionManifest>('/api/extensions'),
    enabled: overlay.present,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  })
}

function usePrivateAdminOverlayEnabled(): boolean {
  const query = useAdminExtensionManifest()
  return (
    overlay.present &&
    (query.data?.navigation.length ?? 0) + (query.data?.user_links.length ?? 0) > 0
  )
}

export const privateUserSummaryColumnTitle = overlay.userSummaryColumnTitle
export async function requirePrivateAdminRoute(path: string): Promise<void> {
  if (!overlay.present) throw notFound()
  try {
    const manifest = await apiClient.get<AdminExtensionManifest>('/api/extensions')
    if (!manifest.navigation.some((entry) => entry.href === path)) throw notFound()
  } catch {
    throw notFound()
  }
}

export function PrivateAdminNavigation() {
  const query = useAdminExtensionManifest()
  if (!overlay.present || !query.data) return null
  return query.data.navigation.map((entry) => (
    <a
      key={entry.href}
      href={entry.href}
      className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      <Settings className="h-3.5 w-3.5" />
      {entry.label}
    </a>
  ))
}

export function PrivateAdminOverviewPanel() {
  const enabled = usePrivateAdminOverlayEnabled()
  const Component = overlay.OverviewPanel
  return enabled ? <Component /> : null
}
export function PrivateAdminSettingsPanel() {
  const enabled = usePrivateAdminOverlayEnabled()
  const Component = overlay.SettingsPanel
  return enabled ? <Component /> : null
}

export function PrivateAdminUserDetailPanel(props: { userId: string; username: string }) {
  const enabled = usePrivateAdminOverlayEnabled()
  const Component = overlay.UserDetailPanel
  return enabled ? <Component {...props} /> : null
}

export function usePrivateAdminUserSummaries(userIds: readonly string[]): {
  enabled: boolean
  summaries: Readonly<Record<string, PrivateAdminUserSummary>>
} {
  const enabled = usePrivateAdminOverlayEnabled()
  return {
    enabled,
    summaries: overlay.useUserSummaries(userIds, enabled),
  }
}
