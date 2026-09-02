import { createFileRoute, Outlet, redirect } from '@tanstack/react-router'

import { AppSidebar } from '@/components/AppSidebar'
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
    <div className="flex min-h-[60vh] flex-col items-center justify-center">
      <h2 className="text-lg font-semibold">页面不存在</h2>
      <p className="mt-1 text-sm text-muted-foreground">该功能未开启或链接已失效</p>
    </div>
  ),
})

function AuthedLayout() {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset className="min-w-0">
        <Outlet />
      </SidebarInset>
    </SidebarProvider>
  )
}
