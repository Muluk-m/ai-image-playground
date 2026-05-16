import { useQueryClient } from '@tanstack/react-query'
import { Link, useLocation, useNavigate } from '@tanstack/react-router'
import { LogOut, RefreshCw } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { apiClient } from '@/lib/api-client'
import { parseRange, type Range } from '@/lib/search-params'
import { cn } from '@/lib/utils'

const RANGE_OPTIONS: Array<{ value: Range; label: string }> = [
  { value: '1d', label: '1 天' },
  { value: '7d', label: '7 天' },
  { value: '30d', label: '30 天' },
]

export function TopBar() {
  const location = useLocation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  // 哪些路由消费 range —— /devices 列表 + /devices/:id 详情。其它路由（/login、/）
  // 不显示 range 控件。
  const showRange = location.pathname.startsWith('/devices') || location.pathname === '/'
  const showAuthedActions = location.pathname !== '/login'

  // 从当前 URL search 解析 range；非法/缺省时回退 '7d'，跟 search-params helper 同语义。
  const currentRange: Range = parseRange((location.search as { range?: unknown })?.range)

  function setRange(next: Range): void {
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
        <Link
          to="/devices"
          className="text-sm font-semibold tracking-tight hover:text-foreground/80"
        >
          image-playground · admin
        </Link>

        <div className="flex items-center gap-2">
          {showRange ? (
            <div
              role="radiogroup"
              aria-label="时间范围"
              className="inline-flex h-8 items-center rounded-md border border-input bg-background p-0.5 text-xs"
            >
              {RANGE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  role="radio"
                  aria-checked={currentRange === opt.value}
                  onClick={() => setRange(opt.value)}
                  className={cn(
                    'rounded px-2.5 py-1 transition-colors',
                    currentRange === opt.value
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
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
