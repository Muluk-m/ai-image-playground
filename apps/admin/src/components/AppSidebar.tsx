import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useLocation, useNavigate } from '@tanstack/react-router'
import {
  Activity,
  LogOut,
  type LucideIcon,
  MonitorSmartphone,
  RefreshCw,
  Settings,
  Users,
} from 'lucide-react'

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '@/components/ui/sidebar'
import { adminSessionQueryOptions } from '@/lib/admin-session'
import { apiClient } from '@/lib/api-client'
import { usePrivateAdminNavigation } from '@/lib/private-overlay'

interface NavEntry {
  to: '/overview' | '/users' | '/devices'
  icon: LucideIcon
  label: string
  /** 只有开了 accounts:login 才出现 */
  gated?: boolean
}

const NAV: readonly NavEntry[] = [
  { to: '/overview', icon: Activity, label: '概览' },
  { to: '/users', icon: Users, label: '用户', gated: true },
  { to: '/devices', icon: MonitorSmartphone, label: '设备' },
]

export function AppSidebar() {
  const navigate = useNavigate()
  const pathname = useLocation({ select: (location) => location.pathname })
  const queryClient = useQueryClient()
  const { data: adminSession } = useQuery(adminSessionQueryOptions)
  const privateNavigation = usePrivateAdminNavigation()

  function refresh(): void {
    // 刷新只重拉数据，'me' 留着：动它会把登录态重检也拖进来。
    void queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] !== 'me' })
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
              {NAV.filter((entry) => !entry.gated || adminSession?.accounts_login).map((entry) => (
                <SidebarMenuItem key={entry.to}>
                  <SidebarMenuButton
                    asChild
                    tooltip={entry.label}
                    isActive={pathname.startsWith(entry.to)}
                  >
                    <Link to={entry.to}>
                      <entry.icon />
                      <span>{entry.label}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {privateNavigation.length ? (
          <SidebarGroup>
            <SidebarGroupLabel>配置</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {privateNavigation.map((entry) => (
                  <SidebarMenuItem key={entry.href}>
                    <SidebarMenuButton asChild tooltip={entry.label}>
                      <a href={entry.href}>
                        <Settings />
                        <span>{entry.label}</span>
                      </a>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ) : null}
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
