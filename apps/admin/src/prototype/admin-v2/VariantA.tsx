import {
  Activity,
  AlertTriangle,
  BookOpen,
  Boxes,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  CreditCard,
  FolderKanban,
  HeartPulse,
  LogOut,
  Menu,
  Plus,
  Search,
  Settings,
  Shapes,
  Sparkles,
  Tags,
  Users,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { ALERTS, INSPIRATIONS, TASKS, USERS } from './mock-data'
import {
  AuditContent,
  BillingContent,
  CategoriesContent,
  InspirationEditor,
  InspirationFilters,
  InspirationGrid,
  OpsContent,
  OverviewContent,
  SkillsContent,
  TaskDetail,
  TasksContent,
  UserDetail,
  UsersContent,
  useFilteredInspirations,
} from './shared'

type Screen =
  | 'overview'
  | 'users'
  | 'tasks'
  | 'inspirations'
  | 'skills'
  | 'categories'
  | 'ops'
  | 'deployments'
  | 'billing'
  | 'audit'
type Detail = { kind: 'user' | 'task' | 'inspiration' | 'alert'; id: string } | null

const NAV = [
  {
    group: '经营',
    items: [
      { id: 'overview', label: '概览', icon: Activity },
      { id: 'users', label: '用户', icon: Users },
      { id: 'tasks', label: '任务与设备', icon: ClipboardList },
    ],
  },
  {
    group: '运营内容',
    items: [
      { id: 'inspirations', label: '灵感库', icon: Sparkles },
      { id: 'skills', label: '技能目录', icon: Shapes },
      { id: 'categories', label: '分类', icon: Tags },
    ],
  },
  {
    group: '运维',
    items: [
      {
        id: 'ops',
        label: '运维看板',
        icon: HeartPulse,
        count: ALERTS.filter((item) => item.level !== 'info').length,
      },
      { id: 'deployments', label: '部署记录', icon: Boxes },
    ],
  },
  {
    group: '设置',
    items: [
      { id: 'billing', label: '收款与计费', icon: CreditCard, private: true },
      { id: 'audit', label: '审计', icon: BookOpen },
    ],
  },
] as const

const TITLES: Record<Screen, [string, string]> = {
  overview: ['概览', '任务量、成功率、耗时与模型用量'],
  users: ['用户', '登录账号、套餐、积分与最近任务'],
  tasks: ['任务与设备', '从任务出发，按设备或用户回溯'],
  inspirations: ['灵感库', '维护主站探索页，发布后用户可直接玩同款'],
  skills: ['技能目录', '随 BFF 镜像发布的只读技能'],
  categories: ['灵感分类', '控制主站筛选顺序与名称'],
  ops: ['运维看板', '宿主机、心跳、队列、备份与告警'],
  deployments: ['部署记录', '每次发布在宿主机追加的事实记录'],
  billing: ['收款与计费', '私有树：确认收款、充值与套餐设置'],
  audit: ['运营审计', '运营者执行的写操作'],
}

export function VariantA(): React.JSX.Element {
  const [screen, setScreen] = useState<Screen>('overview')
  const [collapsed, setCollapsed] = useState(false)
  const [detail, setDetail] = useState<Detail>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [paletteQuery, setPaletteQuery] = useState('')
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('all')
  const inspirations = useFilteredInspirations(query, status)
  const [title, description] = TITLES[screen]

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setPaletteOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const commands = useMemo(() => {
    const nav = NAV.flatMap((group) =>
      group.items.map((item) => ({ id: item.id, label: item.label, kind: 'screen' as const })),
    )
    const people = USERS.map((item) => ({
      id: item.id,
      label: `${item.displayName} · ${item.email}`,
      kind: 'user' as const,
    }))
    const tasks = TASKS.map((item) => ({
      id: item.id,
      label: `${item.id} · ${item.model}`,
      kind: 'task' as const,
    }))
    const content = INSPIRATIONS.map((item) => ({
      id: item.id,
      label: item.title,
      kind: 'inspiration' as const,
    }))
    return [...nav, ...people, ...tasks, ...content]
      .filter((item) => item.label.toLowerCase().includes(paletteQuery.toLowerCase()))
      .slice(0, 12)
  }, [paletteQuery])

  const selectCommand = (command: (typeof commands)[number]) => {
    setPaletteOpen(false)
    if (command.kind === 'screen') setScreen(command.id as Screen)
    else {
      const targetScreen =
        command.kind === 'user' ? 'users' : command.kind === 'task' ? 'tasks' : 'inspirations'
      setScreen(targetScreen)
      setDetail({ kind: command.kind, id: command.id })
    }
  }

  return (
    <div className="min-h-screen bg-muted/20 pb-24 text-foreground">
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-30 flex flex-col border-r bg-shell-nav text-shell-nav-foreground transition-all',
          collapsed ? 'w-[72px]' : 'w-64',
        )}
      >
        <div className="flex h-16 items-center gap-3 border-b border-white/10 px-4">
          <div className="relative grid size-9 shrink-0 place-items-center rounded-xl bg-white/10">
            <div className="size-4 rounded-md border-2 border-brand" />
            <span className="absolute right-2 top-2 size-1.5 rounded-full bg-brand-mint" />
          </div>
          {!collapsed && (
            <div>
              <strong className="block text-sm">幕芽 后台</strong>
              <span className="text-[11px] text-zinc-400">运营台 · Prototype A</span>
            </div>
          )}
        </div>
        <nav className="flex-1 overflow-y-auto px-2 py-3">
          {NAV.map((group) => (
            <div key={group.group} className="mb-4">
              {!collapsed && (
                <p className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-500">
                  {group.group}
                </p>
              )}
              {group.items.map((item) => {
                const Icon = item.icon
                const button = (
                  <button
                    type="button"
                    onClick={() => setScreen(item.id)}
                    className={cn(
                      'mb-1 flex h-10 w-full items-center gap-3 rounded-lg px-3 text-sm transition',
                      screen === item.id
                        ? 'bg-brand font-medium text-brand-foreground'
                        : 'text-zinc-300 hover:bg-white/10 hover:text-white',
                    )}
                  >
                    <Icon className="size-4 shrink-0" />
                    {!collapsed && (
                      <>
                        <span className="min-w-0 flex-1 truncate text-left">{item.label}</span>
                        {'private' in item && item.private && (
                          <span className="text-[9px] opacity-70">私有树</span>
                        )}
                        {'count' in item && item.count && (
                          <Badge variant="destructive" className="h-5 min-w-5 px-1">
                            {item.count}
                          </Badge>
                        )}
                      </>
                    )}
                  </button>
                )
                return collapsed ? (
                  <Tooltip key={item.id}>
                    <TooltipTrigger asChild>{button}</TooltipTrigger>
                    <TooltipContent side="right">{item.label}</TooltipContent>
                  </Tooltip>
                ) : (
                  <div key={item.id}>{button}</div>
                )
              })}
            </div>
          ))}
        </nav>
        <div className="border-t border-white/10 p-2">
          <button
            type="button"
            className="flex h-10 w-full items-center gap-3 rounded-lg px-3 text-sm text-zinc-400 hover:bg-white/10 hover:text-white"
          >
            <LogOut className="size-4" />
            {!collapsed && '退出'}
          </button>
        </div>
      </aside>
      <main className={cn('transition-[margin]', collapsed ? 'ml-[72px]' : 'ml-64')}>
        {ALERTS.some((item) => item.level === 'critical') && (
          <button
            type="button"
            onClick={() => {
              setScreen('ops')
              setDetail({ kind: 'alert', id: 'al-1' })
            }}
            className="flex w-full items-center justify-center gap-2 bg-rose-600 px-4 py-1.5 text-xs font-medium text-white"
          >
            <AlertTriangle className="size-3.5" />
            宿主机磁盘已达 91%，剩余空间低于发布阈值 <ChevronRight className="size-3.5" />
          </button>
        )}
        <header className="sticky top-0 z-20 flex h-16 items-center gap-4 border-b bg-background/90 px-5 backdrop-blur">
          <Button variant="ghost" size="icon" onClick={() => setCollapsed((value) => !value)}>
            {collapsed ? <ChevronRight className="size-4" /> : <ChevronLeft className="size-4" />}
          </Button>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg font-semibold">{title}</h1>
            <p className="truncate text-xs text-muted-foreground">{description}</p>
          </div>
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="hidden w-64 items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm text-muted-foreground hover:bg-muted md:flex"
          >
            <Search className="size-4" />
            搜索任何对象
            <span className="ml-auto rounded border bg-background px-1.5 text-[10px]">⌘K</span>
          </button>
          {screen === 'inspirations' && (
            <Button
              onClick={() => setDetail({ kind: 'inspiration', id: INSPIRATIONS[0].id })}
              className="bg-brand text-brand-foreground hover:bg-brand-hover"
            >
              <Plus className="mr-1 size-4" />
              新建条目
            </Button>
          )}
        </header>
        <div className="p-5 lg:p-7">
          {screen === 'overview' && <OverviewContent />}
          {screen === 'ops' && <OpsContent onAlert={(id) => setDetail({ kind: 'alert', id })} />}
          {screen === 'deployments' && <OpsContent />}
          {screen === 'users' && (
            <UsersContent onSelect={(id) => setDetail({ kind: 'user', id })} />
          )}
          {screen === 'tasks' && (
            <TasksContent onSelect={(id) => setDetail({ kind: 'task', id })} />
          )}
          {screen === 'inspirations' && (
            <div className="space-y-5">
              <InspirationFilters
                query={query}
                onQuery={setQuery}
                status={status}
                onStatus={setStatus}
              />
              <InspirationGrid
                items={inspirations}
                onSelect={(id) => setDetail({ kind: 'inspiration', id })}
              />
            </div>
          )}
          {screen === 'skills' && <SkillsContent />}
          {screen === 'categories' && <CategoriesContent />}
          {screen === 'billing' && <BillingContent />}
          {screen === 'audit' && <AuditContent />}
        </div>
      </main>

      <Sheet open={detail !== null} onOpenChange={(open) => !open && setDetail(null)}>
        <SheetContent
          className={cn(
            'overflow-y-auto sm:max-w-xl',
            detail?.kind === 'inspiration' && 'sm:max-w-2xl',
          )}
        >
          <SheetHeader className="mb-5">
            <SheetTitle>
              {detail?.kind === 'user'
                ? '用户详情'
                : detail?.kind === 'task'
                  ? '任务详情'
                  : detail?.kind === 'inspiration'
                    ? '编辑灵感条目'
                    : '告警详情'}
            </SheetTitle>
            <SheetDescription>保持列表上下文，在右侧检视与处理。</SheetDescription>
          </SheetHeader>
          {detail?.kind === 'user' && <UserDetail id={detail.id} />}
          {detail?.kind === 'task' && (
            <TaskDetail
              id={detail.id}
              onDevice={(deviceId) => {
                setScreen('tasks')
                setDetail(null)
                setQuery(deviceId)
              }}
            />
          )}
          {detail?.kind === 'inspiration' && <InspirationEditor key={detail.id} id={detail.id} />}
          {detail?.kind === 'alert' && (
            <div className="space-y-4">
              <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-4">
                <strong>{ALERTS.find((item) => item.id === detail.id)?.title}</strong>
                <p className="mt-2 text-sm text-muted-foreground">
                  {ALERTS.find((item) => item.id === detail.id)?.detail}
                </p>
              </div>
              <Button>标记已知晓</Button>
            </div>
          )}
        </SheetContent>
      </Sheet>

      <Dialog open={paletteOpen} onOpenChange={setPaletteOpen}>
        <DialogContent className="top-[18%] translate-y-0 p-0 sm:max-w-xl">
          <DialogHeader className="sr-only">
            <DialogTitle>全局搜索</DialogTitle>
          </DialogHeader>
          <div className="flex items-center gap-2 border-b px-4">
            <Search className="size-4 text-muted-foreground" />
            <Input
              autoFocus
              value={paletteQuery}
              onChange={(event) => setPaletteQuery(event.target.value)}
              placeholder="用户、任务、灵感或模块…"
              className="border-0 px-0 shadow-none focus-visible:ring-0"
            />
          </div>
          <div className="max-h-[420px] overflow-y-auto p-2">
            {commands.map((command) => (
              <button
                key={`${command.kind}-${command.id}`}
                type="button"
                onClick={() => selectCommand(command)}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-muted"
              >
                <Search className="size-3.5 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-sm">{command.label}</span>
                <Badge variant="outline">{command.kind}</Badge>
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
