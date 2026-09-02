import { createFileRoute, Outlet, redirect } from '@tanstack/react-router'

import { AppSidebar } from '@/components/AppSidebar'
import { NotFound } from '@/components/NotFound'
import { Page } from '@/components/Page'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { adminSessionQueryOptions } from '@/lib/admin-session'

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
        <Outlet />
      </SidebarInset>
    </SidebarProvider>
  )
}
