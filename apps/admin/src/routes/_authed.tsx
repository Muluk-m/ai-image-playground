import { createFileRoute, Link, Outlet, redirect } from '@tanstack/react-router'
import { AlertTriangle, ChevronRight } from 'lucide-react'

import { AppSidebar } from '@/components/AppSidebar'
import { CommandPalette } from '@/components/CommandPalette'
import { NotFound } from '@/components/NotFound'
import { opsAlerts } from '@/components/ops/OpsBoard'
import { Page } from '@/components/Page'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { adminSessionQueryOptions } from '@/lib/admin-session'
import { useOps } from '@/lib/queries'

// 鉴权守卫：layout route，beforeLoad 探 /api/me（cookie 校验），失败 redirect /login。
// 用 ensureQueryData 走 queryClient cache 避免每次 prefetch 都打一次后端。
export const Route = createFileRoute('/_authed')({
  beforeLoad: async ({ context, location }) => {
    try {
      const adminSession = await context.queryClient.ensureQueryData(adminSessionQueryOptions)
      return { adminSession }
    } catch {
      throw redirect({
        to: '/login',
        search: { redirect: location.pathname + location.searchStr },
      })
    }
  },
  component: AuthedLayout,
  notFoundComponent: () => (
    <Page crumbs={[{ label: '页面不存在' }]}>
      <NotFound hint="该功能未开启或链接已失效" />
    </Page>
  ),
})

// SidebarProvider 只写 sidebar_state，不读；不回读的话每次刷新侧栏都弹回展开。
function sidebarDefaultOpen(): boolean {
  if (typeof document === 'undefined') return true
  return !/(?:^|;\s*)sidebar_state=false(?:;|$)/.test(document.cookie)
}

function AuthedLayout() {
  return (
    <SidebarProvider defaultOpen={sidebarDefaultOpen()}>
      <AppSidebar />
      <SidebarInset className="min-w-0">
        <OpsAlertBanner />
        <Outlet />
        <CommandPalette />
      </SidebarInset>
    </SidebarProvider>
  )
}

/**
 * 出事了就在内容区顶上挂一条窄横幅，点进运维看板看详情——不把运维数据混进当前这页。
 * 用的是运维看板那把 query（30 秒自己重拉一次），所以这里不额外发请求；
 * 还没取到或取失败时什么都不显示：横幅是「有事」的信号，不是「取数状态」的展示位。
 */
function OpsAlertBanner() {
  const { data } = useOps()
  const alerts = data ? opsAlerts(data) : []
  if (!alerts.length) return null
  return (
    <Link
      to="/ops"
      // tokens.css 的 --shell-alert-banner-* 就是 destructive 这对色；横幅要一眼看见，所以实心。
      className="flex items-center gap-2 bg-destructive px-4 py-1.5 text-xs font-medium text-destructive-foreground md:px-6"
    >
      <AlertTriangle className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{alerts[0]}</span>
      {alerts.length > 1 ? (
        <span className="shrink-0 opacity-80">另有 {alerts.length - 1} 项</span>
      ) : null}
      <ChevronRight className="size-3.5 shrink-0" />
    </Link>
  )
}
