import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useLocation, useNavigate } from '@tanstack/react-router'
import { Activity, LogOut, MonitorSmartphone, RefreshCw, Users } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { adminSessionQueryOptions } from '@/lib/admin-session'
import { apiClient } from '@/lib/api-client'
import { PrivateAdminNavigation } from '@/lib/private-overlay'
import { parseRange, type Range } from '@/lib/search-params'

const RANGE_OPTIONS: Array<{ value: Range; label: string }> = [
  { value: '1d', label: '1 天' },
  { value: '7d', label: '7 天' },
  { value: '30d', label: '30 天' },
]

export function TopBar() {
  const location = useLocation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { data: adminSession } = useQuery({
    ...adminSessionQueryOptions,
    enabled: location.pathname !== '/login',
  })

  // 时间窗同时驱动系统概览、设备视图和用户详情趋势。
  const showRange =
    location.pathname === '/overview' ||
    location.pathname.startsWith('/devices') ||
    location.pathname.startsWith('/users/')
  const showAuthedActions = location.pathname !== '/login'

  // 从当前 URL search 解析 range；非法/缺省时回退 '7d'，跟 search-params helper 同语义。
  const currentRange: Range = parseRange((location.search as { range?: unknown })?.range)

  function setRange(next: Range): void {
    if (next === currentRange) return
    // navigate 在 root（pathname 未变）下，TanStack Router 会浅合并 search
    void navigate({
      to: location.pathname,
      search: (prev) => ({ ...(prev ?? {}), range: next }),
      replace: true,
    })
  }

  function refresh(): void {
    // 只 invalidate 数据 query，不动 me（避免 refresh 触发登录态重检）
    void queryClient.invalidateQueries({ queryKey: ['devices'] })
    void queryClient.invalidateQueries({ queryKey: ['device'] })
    void queryClient.invalidateQueries({ queryKey: ['task'] })
    void queryClient.invalidateQueries({ queryKey: ['users'] })
    void queryClient.invalidateQueries({ queryKey: ['user'] })
    void queryClient.invalidateQueries({ queryKey: ['overview'] })
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
    <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-12 max-w-7xl items-center justify-between px-4">
        <div className="flex items-center gap-5">
          <Link
            to="/overview"
            className="text-sm font-semibold tracking-tight hover:text-foreground/80"
          >
            image-playground · admin
          </Link>
          {showAuthedActions ? (
            <nav className="flex items-center gap-1" aria-label="后台导航">
              <Link
                to="/overview"
                className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground [&.active]:bg-muted [&.active]:font-medium [&.active]:text-foreground"
              >
                <Activity className="h-3.5 w-3.5" />
                概览
              </Link>
              {adminSession?.accounts_login ? (
                <Link
                  to="/users"
                  className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground [&.active]:bg-muted [&.active]:font-medium [&.active]:text-foreground"
                >
                  <Users className="h-3.5 w-3.5" />
                  用户
                </Link>
              ) : null}
              <Link
                to="/devices"
                className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground [&.active]:bg-muted [&.active]:font-medium [&.active]:text-foreground"
              >
                <MonitorSmartphone className="h-3.5 w-3.5" />
                设备
              </Link>
              <PrivateAdminNavigation />
            </nav>
          ) : null}
        </div>

        <div className="flex items-center gap-2">
          {showRange ? (
            <ToggleGroup
              type="single"
              aria-label="时间范围"
              value={currentRange}
              onValueChange={(next) => {
                // Radix 允许再次点击当前项取消选择，这里忽略空值以保证时间窗始终有效。
                if (next) setRange(next as Range)
              }}
              className="inline-flex h-8 items-center gap-0 rounded-md border border-input bg-background p-0.5 text-xs"
            >
              {RANGE_OPTIONS.map((opt) => (
                <ToggleGroupItem
                  key={opt.value}
                  value={opt.value}
                  className="h-auto min-w-0 rounded px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-transparent hover:text-foreground data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
                >
                  {opt.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          ) : null}

          {showAuthedActions ? (
            <>
              <Button size="icon" variant="ghost" aria-label="刷新" onClick={refresh}>
                <RefreshCw />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label="退出登录"
                onClick={() => {
                  void logout()
                }}
              >
                <LogOut />
              </Button>
            </>
          ) : null}
        </div>
      </div>
    </header>
  )
}
