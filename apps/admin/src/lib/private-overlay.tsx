import type { ManagedModelKind } from '@image-playground/shared'
import { useQuery } from '@tanstack/react-query'
import { Navigate, notFound } from '@tanstack/react-router'
import type { ComponentType, ReactNode } from 'react'
import { Page } from '@/components/Page'
import { privateAdminOverlay } from '../features/billing'
import { apiClient } from './api-client'

export interface PrivateAdminUserSummary {
  primary: string
  secondary: string
  tone?: 'default' | 'warning'
  /** 会员视觉由收费 overlay 提供，公开 Admin 只负责排版，避免复制档位配色与图标。 */
  accent?: string
  badge?: ReactNode
  registrationSource?: 'invited' | 'direct_or_unknown'
  inviter?: {
    userId: string
    username: string
  } | null
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
  OrdersPanel?: ComponentType
  /** 「模型」页每一行的单价摘要与抽屉编辑；上下架归公开侧，这里只管价格。缺席即不收费。 */
  ModelPricing?: ComponentType<{
    model: string
    kind: ManagedModelKind
    mode?: 'summary' | 'editor'
    onEdit?: () => void
  }>
  userDetailProfile?: true
  UserDetailPanel: ComponentType<{
    userId: string
    username: string
    children?: ReactNode
    profile?: ReactNode
  }>
}

const overlay: PrivateAdminOverlay = privateAdminOverlay

interface AdminExtensionManifest {
  navigation: Array<{ label: string; href: string }>
  user_links: Array<{ label: string; href_template: string }>
}

function normalizeExtensionPath(href: string): string {
  const end = href.search(/[?#]/)
  const path = end === -1 ? href : href.slice(0, end)
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
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

export function usePrivateAdminOverlayEnabled(): boolean {
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

const NO_NAVIGATION: ReadonlyArray<{ label: string; href: string }> = Object.freeze([])

export function usePrivateAdminNavigation(): ReadonlyArray<{ label: string; href: string }> {
  const query = useAdminExtensionManifest()
  if (!overlay.present) return NO_NAVIGATION
  return query.data?.navigation ?? NO_NAVIGATION
}

/** 是否启用了商业计费设置扩展（用于「模型与计费」合并工作台页签与导航文案）。 */
export function usePrivateAdminBillingSettingsEnabled(): boolean {
  const navigation = usePrivateAdminNavigation()
  return navigation.some((entry) => normalizeExtensionPath(entry.href) === '/billing/settings')
}

export function PrivateAdminOverviewPanel() {
  const enabled = usePrivateAdminOverlayEnabled()
  const Component = overlay.OverviewPanel
  return enabled ? <Component /> : null
}

/** 嵌入 `/providers?tab=billing` 的商业计费配置面板。 */
export function PrivateAdminBillingPanel() {
  const enabled = usePrivateAdminOverlayEnabled()
  const Component = overlay.SettingsPanel
  if (!enabled) return null
  return <Component />
}

/** 旧 `/billing/settings` 路由入口：重定向至统一的「模型与计费 → 套餐与收款」页签。 */
export function PrivateAdminSettingsPanel() {
  const enabled = usePrivateAdminOverlayEnabled()
  if (!enabled) return null
  return <Navigate to="/providers" search={{ tab: 'billing' }} replace />
}

export function PrivateAdminUserDetailPanel(props: {
  userId: string
  username: string
  children?: ReactNode
  profile?: ReactNode
}) {
  const enabled = usePrivateAdminOverlayEnabled()
  const Component = overlay.UserDetailPanel
  if (enabled && overlay.userDetailProfile) return <Component {...props} />

  const content = enabled ? <Component {...props} /> : props.children
  return (
    <div
      className={
        enabled
          ? 'space-y-4'
          : 'grid items-start gap-4 lg:grid-cols-[248px_minmax(0,1fr)] xl:grid-cols-[280px_minmax(0,1fr)]'
      }
    >
      {props.profile}
      <div className={enabled ? undefined : 'order-first min-w-0 lg:order-none'}>{content}</div>
    </div>
  )
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

export function PrivateAdminOrdersPanel() {
  const enabled = usePrivateAdminOverlayEnabled()
  const Component = overlay.OrdersPanel
  if (!enabled || !Component) return null
  return (
    <Page crumbs={[{ label: '订单核款' }]} description="对照收款凭证核验到账并执行套餐开通或续期">
      <Component />
    </Page>
  )
}

export function PrivateAdminModelPricing(props: {
  model: string
  kind: ManagedModelKind
  mode?: 'summary' | 'editor'
  onEdit?: () => void
}) {
  const enabled = usePrivateAdminOverlayEnabled()
  const Component = overlay.ModelPricing
  if (!enabled || !Component) return null
  return <Component {...props} />
}
