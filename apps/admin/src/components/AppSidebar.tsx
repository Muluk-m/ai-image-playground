import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useLocation, useNavigate } from '@tanstack/react-router'
import { Activity, LogOut, MonitorSmartphone, RefreshCw, Users } from 'lucide-react'

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '@/components/ui/sidebar'
import { adminSessionQueryOptions } from '@/lib/admin-session'
import { apiClient } from '@/lib/api-client'
import { PrivateAdminNavigation } from '@/lib/private-overlay'
import { DATA_QUERY_KEYS } from '@/lib/queries'

export function AppSidebar() {
  const navigate = useNavigate()
  const location = useLocation()
  const queryClient = useQueryClient()
  const { data: adminSession } = useQuery(adminSessionQueryOptions)
  const isActive = (prefix: string): boolean => location.pathname.startsWith(prefix)

  function refresh(): void {
    // 只 invalidate 数据 query，不动 me（避免 refresh 触发登录态重检）
    for (const key of DATA_QUERY_KEYS) {
      void queryClient.invalidateQueries({ queryKey: [key] })
    }
  }

  async function logout(): Promise<void> {
    try {
      await apiClient.post('/api/logout')
    } catch {
      // 即便失败也清本地态 + 跳登录页
    }
    queryClient.clear()
    void navigate({ to: '/login' })
  }

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link to="/overview">
                <div className="flex aspect-square size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                  <Activity className="size-4" />
                </div>
                <div className="grid flex-1 text-left leading-tight">
                  <span className="truncate text-sm font-semibold">image-playground</span>
                  <span className="truncate text-xs text-muted-foreground">admin</span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu aria-label="后台导航">
              <SidebarMenuItem>
                <SidebarMenuButton asChild tooltip="概览" isActive={isActive('/overview')}>
                  <Link to="/overview">
                    <Activity />
                    <span>概览</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              {adminSession?.accounts_login ? (
                <SidebarMenuItem>
                  <SidebarMenuButton asChild tooltip="用户" isActive={isActive('/users')}>
                    <Link to="/users">
                      <Users />
                      <span>用户</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ) : null}
              <SidebarMenuItem>
                <SidebarMenuButton asChild tooltip="设备" isActive={isActive('/devices')}>
                  <Link to="/devices">
                    <MonitorSmartphone />
                    <span>设备</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <PrivateAdminNavigation />
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton tooltip="刷新" onClick={refresh}>
              <RefreshCw />
              <span>刷新</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="退出登录"
              onClick={() => {
                void logout()
              }}
            >
              <LogOut />
              <span>退出登录</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
