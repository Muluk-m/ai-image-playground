import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useLocation, useNavigate } from '@tanstack/react-router'
import {
  Activity,
  BookOpen,
  Bug,
  ClipboardList,
  HeartPulse,
  LogOut,
  type LucideIcon,
  ReceiptText,
  RefreshCw,
  ScrollText,
  Settings,
  Shapes,
  Sparkles,
  Tags,
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
import { ADMIN_REFRESH_EVENT } from '@/lib/queries'

export type NavTo =
  | '/overview'
  | '/tasks'
  | '/prompts'
  | '/users'
  | '/devices'
  | '/inspirations'
  | '/inspirations/skills'
  | '/inspirations/categories'
  | '/ops'
  | '/errors'
  | '/logs'
  | '/audit'
  | '/agent-models'

export interface NavEntry {
  to: NavTo
  icon: LucideIcon
  label: string
  /** 只有开了 accounts:login 才出现 */
  gated?: boolean
  /**
   * 选中态默认按路径前缀判断（`/users/u-1` 也算在「用户」里）。灵感库三个模块互为前缀，
   * 前缀判断会让「灵感库」跟着「技能目录」一起亮，所以它们只认完全相等。
   */
  exact?: boolean
}

export interface NavGroup {
  label: string
  entries: readonly NavEntry[]
}

/**
 * 左侧分组导航，也是 ⌘K 面板的模块清单（CommandPalette 直接读这份）。
 * 私有树的收款与计费不写在这份清单里：入口来自 /api/extensions。收费构建会把
 * overlay 的路由编进同一棵树，侧栏跟其他模块一样做客户端跳转，并带上选中态。
 */
export const NAV_GROUPS: readonly NavGroup[] = [
  {
    label: '经营',
    entries: [
      { to: '/overview', icon: Activity, label: '概览' },
      { to: '/users', icon: Users, label: '用户', gated: true },
      { to: '/tasks', icon: ClipboardList, label: '生成任务' },
      { to: '/prompts', icon: ScrollText, label: '提示词' },
      { to: '/devices', icon: ClipboardList, label: '设备' },
    ],
  },
  {
    label: '运营内容',
    entries: [
      { to: '/inspirations', icon: Sparkles, label: '灵感库', exact: true },
      { to: '/inspirations/skills', icon: Shapes, label: '技能目录', exact: true },
      { to: '/inspirations/categories', icon: Tags, label: '分类', exact: true },
    ],
  },
  {
    label: '运维',
    entries: [
      { to: '/logs', icon: ScrollText, label: '服务端日志' },
      { to: '/ops', icon: HeartPulse, label: '运维看板' },
      { to: '/errors', icon: Bug, label: '前端错误' },
    ],
  },
  {
    label: '设置',
    entries: [
      { to: '/agent-models', icon: Settings, label: 'Agent 模型' },
      { to: '/audit', icon: BookOpen, label: '审计' },
    ],
  },
]

/**
 * 私有导航项来自 /api/extensions，只有名称与链接；图标在这里按链接认领。
 * 认不出的新入口退回齿轮，不会因为私有树加了入口就让公开侧报错。
 */
const OVERLAY_NAV_ICONS: Readonly<Record<string, LucideIcon>> = {
  '/billing/orders': ReceiptText,
  '/billing/settings': Settings,
}

function overlayNavIcon(href: string): LucideIcon {
  return Object.prototype.hasOwnProperty.call(OVERLAY_NAV_ICONS, href)
    ? OVERLAY_NAV_ICONS[href]!
    : Settings
}

// 选中态用芽绿（tokens.css 的 --shell-nav-item-active-*），盖掉 shadcn 默认的中性 accent；
// hover 也一并钉住，否则鼠标扫过当前模块会把它变回灰的。
const NAV_ACTIVE_CLASS =
  'data-[active=true]:bg-shell-nav-active data-[active=true]:font-medium data-[active=true]:text-shell-nav-active-foreground data-[active=true]:hover:bg-shell-nav-active data-[active=true]:hover:text-shell-nav-active-foreground'

/** 扩展清单的 href 可能带查询串；选中态和跳转都只认路径。 */
export function overlayNavPath(href: string): string {
  const end = href.search(/[?#]/)
  const path = end === -1 ? href : href.slice(0, end)
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
}

/**
 * 公开路由类型里没有这些 path。运行时 `to` 仍是清单上的路径，收费构建的路由树能匹配到。
 * 断言成一个不带 search 的公开路由，只为通过公开树的类型检查。
 */
function overlayLinkTo(href: string): '/audit' {
  return overlayNavPath(href) as '/audit'
}

export function overlayNavIsActive(pathname: string, href: string): boolean {
  const path = overlayNavPath(href)
  if (pathname === path) return true
  if (path === '/') return false
  return pathname.startsWith(`${path}/`)
}

export function AppSidebar() {
  const navigate = useNavigate()
  const pathname = useLocation({ select: (location) => location.pathname })
  const queryClient = useQueryClient()
  const { data: adminSession } = useQuery(adminSessionQueryOptions)
  const privateNavigation = usePrivateAdminNavigation()

  function refresh(): void {
    const refreshEvent = new Event(ADMIN_REFRESH_EVENT, { cancelable: true })
    window.dispatchEvent(refreshEvent)
    // 刷新只重拉数据，'me' 留着：动它会把登录态重检也拖进来。
    void queryClient.invalidateQueries({
      predicate: (query) =>
        query.queryKey[0] !== 'me' &&
        !(refreshEvent.defaultPrevented && query.queryKey[0] === 'generation-tasks'),
    })
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
                  <img
                    src="/favicon.svg"
                    alt=""
                    width="32"
                    height="32"
                    className="size-8 rounded-lg"
                  />
                </div>
                <div className="grid flex-1 text-left leading-tight">
                  <span className="truncate text-sm font-semibold">幕芽 Muvloom</span>
                  <span className="truncate text-xs text-muted-foreground">admin</span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        {NAV_GROUPS.map((group) => {
          const entries = group.entries.filter(
            (entry) => !entry.gated || adminSession?.accounts_login,
          )
          const overlayEntries = group.label === '设置' ? privateNavigation : []
          if (!entries.length && !overlayEntries.length) return null
          return (
            <SidebarGroup key={group.label}>
              <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu aria-label={group.label}>
                  {overlayEntries.map((entry) => {
                    const Icon = overlayNavIcon(overlayNavPath(entry.href))
                    return (
                      <SidebarMenuItem key={entry.href}>
                        <SidebarMenuButton
                          asChild
                          tooltip={entry.label}
                          className={NAV_ACTIVE_CLASS}
                          isActive={overlayNavIsActive(pathname, entry.href)}
                        >
                          <Link to={overlayLinkTo(entry.href)}>
                            <Icon />
                            <span>{entry.label}</span>
                          </Link>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    )
                  })}
                  {entries.map((entry) => (
                    <SidebarMenuItem key={entry.to}>
                      <SidebarMenuButton
                        asChild
                        tooltip={entry.label}
                        className={NAV_ACTIVE_CLASS}
                        isActive={
                          entry.exact ? pathname === entry.to : pathname.startsWith(entry.to)
                        }
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
          )
        })}
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton aria-label="刷新" onClick={refresh}>
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
