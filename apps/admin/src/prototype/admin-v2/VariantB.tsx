import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Bell,
  BookOpen,
  ChevronDown,
  ClipboardList,
  CreditCard,
  HeartPulse,
  LayoutDashboard,
  Menu,
  Plus,
  Search,
  Settings,
  Sparkles,
  Users,
} from 'lucide-react'
import { useMemo, useState } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Progress } from '@/components/ui/progress'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import {
  ALERTS,
  DEPLOYMENTS,
  HOST,
  INSPIRATIONS,
  type Inspiration,
  type InspirationStatus,
  KPIS,
  MODEL_USAGE,
  PENDING_PAYMENTS,
  SERVICES,
} from './mock-data'
import {
  AuditContent,
  BillingContent,
  CategoriesContent,
  InspirationEditor,
  InspirationGrid,
  OpsContent,
  SitePreview,
  SkillsContent,
  StatusDot,
  TaskDetail,
  TasksContent,
  UserDetail,
  UsersContent,
  VolumeBars,
} from './shared'

type Tab = 'home' | 'users' | 'tasks' | 'inspirations' | 'ops' | 'settings'
type Detail = { kind: 'user' | 'task' | 'inspiration'; id: string } | null

const TOP_NAV = [
  { id: 'home', label: '首页', icon: LayoutDashboard },
  { id: 'users', label: '用户', icon: Users },
  { id: 'tasks', label: '任务', icon: ClipboardList },
  { id: 'inspirations', label: '灵感库', icon: Sparkles },
  { id: 'ops', label: '运维', icon: HeartPulse },
  { id: 'settings', label: '设置', icon: Settings },
] as const

export function VariantB(): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('home')
  const [detail, setDetail] = useState<Detail>(null)
  const [search, setSearch] = useState('')
  const [boardView, setBoardView] = useState<'board' | 'skills' | 'categories'>('board')
  const [statuses, setStatuses] = useState<Record<string, InspirationStatus>>(() =>
    Object.fromEntries(INSPIRATIONS.map((item) => [item.id, item.status])),
  )

  const boardItems = useMemo(
    () =>
      INSPIRATIONS.filter((item) =>
        `${item.title} ${item.category}`.toLowerCase().includes(search.toLowerCase()),
      ).map((item) => ({ ...item, status: statuses[item.id] ?? item.status })),
    [search, statuses],
  )

  const openDetail = (
    kind: Detail extends infer _ ? 'user' | 'task' | 'inspiration' : never,
    id: string,
  ) => setDetail({ kind, id })
  const go = (next: Tab) => {
    setTab(next)
    setDetail(null)
  }

  return (
    <div className="min-h-screen bg-muted/20 pb-24 text-foreground">
      <header className="sticky top-0 z-40 border-b bg-background/90 backdrop-blur">
        <div className="flex h-16 items-center gap-4 px-5">
          <button
            type="button"
            onClick={() => go('home')}
            className="flex shrink-0 items-center gap-2"
          >
            <div className="relative grid size-9 place-items-center rounded-xl bg-brand-ink">
              <div className="size-4 rounded-md border-2 border-brand" />
              <span className="absolute right-2 top-2 size-1.5 rounded-full bg-brand-mint" />
            </div>
            <span className="hidden text-sm font-semibold lg:inline">幕芽 后台</span>
          </button>
          <nav className="hidden h-full items-center md:flex">
            {TOP_NAV.map((item) => {
              const Icon = item.icon
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => go(item.id)}
                  className={cn(
                    'relative flex h-full items-center gap-2 px-3 text-sm text-muted-foreground hover:text-foreground',
                    tab === item.id &&
                      'font-medium text-foreground after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:bg-brand-mint',
                  )}
                >
                  <Icon className="size-4" />
                  {item.label}
                </button>
              )
            })}
          </nav>
          <Button variant="ghost" size="icon" className="md:hidden">
            <Menu className="size-5" />
          </Button>
          <div className="ml-auto hidden w-64 items-center gap-2 rounded-lg border bg-muted/30 px-3 md:flex">
            <Search className="size-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="全局搜索"
              className="border-0 px-0 shadow-none focus-visible:ring-0"
            />
          </div>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="icon" className="relative">
                <Bell className="size-5" />
                <span className="absolute right-1 top-1 size-2 rounded-full bg-rose-500" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-96">
              <h3 className="mb-3 font-semibold">告警</h3>
              <div className="space-y-2">
                {ALERTS.map((alert) => (
                  <button
                    key={alert.id}
                    type="button"
                    onClick={() => go('ops')}
                    className="flex w-full gap-3 rounded-lg border p-3 text-left hover:bg-muted"
                  >
                    <AlertTriangle
                      className={cn(
                        'mt-0.5 size-4',
                        alert.level === 'critical' ? 'text-rose-500' : 'text-amber-500',
                      )}
                    />
                    <span>
                      <strong className="block text-sm">{alert.title}</strong>
                      <span className="text-xs text-muted-foreground">{alert.at}</span>
                    </span>
                  </button>
                ))}
              </div>
            </PopoverContent>
          </Popover>
          <button
            type="button"
            className="flex items-center gap-2 rounded-lg px-2 py-1 hover:bg-muted"
          >
            <span className="grid size-8 place-items-center rounded-full bg-brand text-xs font-bold text-brand-foreground">
              Q
            </span>
            <ChevronDown className="size-3 text-muted-foreground" />
          </button>
        </div>
      </header>

      {detail ? (
        <DetailPage detail={detail} back={() => setDetail(null)} />
      ) : (
        <main className="mx-auto max-w-[1680px] p-5 lg:p-7">
          {tab === 'home' && (
            <CommandHome onOps={() => go('ops')} onBilling={() => go('settings')} />
          )}
          {tab === 'users' && (
            <PageBlock title="用户" description="账号、套餐与运营操作">
              <UsersContent onSelect={(id) => openDetail('user', id)} />
            </PageBlock>
          )}
          {tab === 'tasks' && (
            <PageBlock title="任务" description="状态、模型、设备与失败原因">
              <TasksContent onSelect={(id) => openDetail('task', id)} />
            </PageBlock>
          )}
          {tab === 'inspirations' && (
            <PageBlock
              title="灵感库"
              description="按发布状态管理主站探索内容"
              action={
                <Button
                  onClick={() => openDetail('inspiration', INSPIRATIONS[0].id)}
                  className="bg-brand text-brand-foreground hover:bg-brand-hover"
                >
                  <Plus className="mr-1 size-4" />
                  新建条目
                </Button>
              }
            >
              <div className="mb-5 flex flex-wrap gap-3">
                <Tabs
                  value={boardView}
                  onValueChange={(value) => setBoardView(value as typeof boardView)}
                >
                  <TabsList>
                    <TabsTrigger value="board">看板</TabsTrigger>
                    <TabsTrigger value="skills">技能目录</TabsTrigger>
                    <TabsTrigger value="categories">分类</TabsTrigger>
                  </TabsList>
                </Tabs>
                <Select defaultValue="all">
                  <SelectTrigger className="w-36">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部类型</SelectItem>
                    <SelectItem value="showcase">效果图</SelectItem>
                    <SelectItem value="template">模板</SelectItem>
                    <SelectItem value="skill">技能示例</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {boardView === 'board' && (
                <Kanban
                  items={boardItems}
                  statuses={statuses}
                  setStatuses={setStatuses}
                  open={(id) => openDetail('inspiration', id)}
                />
              )}
              {boardView === 'skills' && <SkillsContent />}
              {boardView === 'categories' && <CategoriesContent />}
            </PageBlock>
          )}
          {tab === 'ops' && (
            <PageBlock title="运维看板" description="部署本身有没有出事">
              <OpsContent />
            </PageBlock>
          )}
          {tab === 'settings' && (
            <PageBlock title="设置" description="私有树计费、审计与内容分类">
              <Tabs defaultValue="billing">
                <TabsList>
                  <TabsTrigger value="billing">收款与计费</TabsTrigger>
                  <TabsTrigger value="audit">审计</TabsTrigger>
                  <TabsTrigger value="categories">分类</TabsTrigger>
                </TabsList>
                <TabsContent value="billing" className="mt-5">
                  <BillingContent />
                </TabsContent>
                <TabsContent value="audit" className="mt-5">
                  <AuditContent />
                </TabsContent>
                <TabsContent value="categories" className="mt-5">
                  <CategoriesContent />
                </TabsContent>
              </Tabs>
            </PageBlock>
          )}
        </main>
      )}
    </div>
  )
}

function PageBlock({
  title,
  description,
  action,
  children,
}: {
  title: string
  description: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div>
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        </div>
        {action}
      </div>
      {children}
    </div>
  )
}

function CommandHome({ onOps, onBilling }: { onOps: () => void; onBilling: () => void }) {
  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">早上好，运营者</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          今天有 3 个告警、2 笔待确认收款、1 条灵感草稿。
        </p>
      </div>
      <div className="grid gap-5 xl:grid-cols-[1.35fr_1fr]">
        <section className="space-y-4">
          <h2 className="text-base font-semibold">今天业务</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {KPIS.map((item) => (
              <Card key={item.key}>
                <CardContent className="p-4">
                  <span className="text-xs text-muted-foreground">{item.label}</span>
                  <div className="mt-2 flex items-end justify-between">
                    <strong className="text-2xl">{item.value}</strong>
                    <span
                      className={
                        item.tone === 'up' ? 'text-xs text-emerald-500' : 'text-xs text-rose-500'
                      }
                    >
                      {item.delta}
                    </span>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">24 小时任务量</CardTitle>
            </CardHeader>
            <CardContent>
              <VolumeBars compact />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">模型用量</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {MODEL_USAGE.map((model) => (
                <div key={model.model}>
                  <div className="mb-1 flex justify-between text-xs">
                    <span>{model.model}</span>
                    <span>{model.count}</span>
                  </div>
                  <Progress value={model.share * 100} className="h-1.5" />
                </div>
              ))}
            </CardContent>
          </Card>
        </section>
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold">部署状态</h2>
            <Button variant="ghost" size="sm" onClick={onOps}>
              完整看板
            </Button>
          </div>
          <Card>
            <CardContent className="divide-y p-4">
              {SERVICES.map((service) => (
                <div
                  key={service.name}
                  className="flex items-center gap-3 py-2 first:pt-0 last:pb-0"
                >
                  <StatusDot status={service.status} />
                  <span className="flex-1 text-sm font-medium">{service.name}</span>
                  <code className="text-[10px] text-muted-foreground">
                    {service.version.split('+')[0]}
                  </code>
                  <span className="text-xs text-muted-foreground">{service.heartbeat}</span>
                </div>
              ))}
            </CardContent>
          </Card>
          <Card>
            <CardContent className="space-y-3 p-4">
              <div className="flex justify-between text-sm">
                <span>磁盘</span>
                <strong className="text-rose-500">91%</strong>
              </div>
              <Progress
                value={(HOST.disk.used / HOST.disk.total) * 100}
                className="h-2 [&>div]:bg-rose-500"
              />
              <div className="flex justify-between text-sm">
                <span>内存</span>
                <span>{Math.round((HOST.memory.used / HOST.memory.total) * 100)}%</span>
              </div>
              <Progress value={(HOST.memory.used / HOST.memory.total) * 100} className="h-2" />
            </CardContent>
          </Card>
          <div className="space-y-2">
            {ALERTS.slice(0, 3).map((alert) => (
              <button
                key={alert.id}
                type="button"
                onClick={onOps}
                className="flex w-full gap-3 rounded-xl border bg-card p-3 text-left"
              >
                <AlertTriangle
                  className={cn(
                    'size-4',
                    alert.level === 'critical' ? 'text-rose-500' : 'text-amber-500',
                  )}
                />
                <span className="min-w-0 flex-1">
                  <strong className="block truncate text-sm">{alert.title}</strong>
                  <span className="text-xs text-muted-foreground">{alert.at}</span>
                </span>
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={onBilling}
            className="w-full rounded-xl border border-violet-500/30 bg-violet-500/10 p-4 text-left"
          >
            <div className="flex items-center justify-between">
              <strong>待确认收款</strong>
              <Badge className="bg-violet-600">私有树 · {PENDING_PAYMENTS.length}</Badge>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">点击进入收款与计费</p>
          </button>
          <Card>
            <CardContent className="p-4">
              <strong className="text-sm">最近部署</strong>
              {DEPLOYMENTS.slice(0, 3).map((item) => (
                <div key={item.id} className="mt-3 flex items-center gap-2 text-xs">
                  <StatusDot status={item.result === 'ok' ? 'up' : 'down'} />
                  <span>{item.edition}</span>
                  <code>{item.publicSha}</code>
                  <span className="ml-auto text-muted-foreground">{item.at}</span>
                </div>
              ))}
            </CardContent>
          </Card>
        </section>
      </div>
    </div>
  )
}

function Kanban({
  items,
  statuses,
  setStatuses,
  open,
}: {
  items: readonly Inspiration[]
  statuses: Record<string, InspirationStatus>
  setStatuses: React.Dispatch<React.SetStateAction<Record<string, InspirationStatus>>>
  open: (id: string) => void
}) {
  const columns: readonly [InspirationStatus, string][] = [
    ['draft', '草稿'],
    ['published', '已发布'],
    ['archived', '已下架'],
  ]
  return (
    <div className="grid gap-4 xl:grid-cols-3">
      {columns.map(([status, label]) => (
        <div
          key={status}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            const id = event.dataTransfer.getData('text/plain')
            if (id) setStatuses((current) => ({ ...current, [id]: status }))
          }}
          className="min-h-[560px] rounded-xl border bg-muted/30 p-3"
        >
          <div className="mb-3 flex items-center justify-between">
            <strong>{label}</strong>
            <Badge variant="secondary">
              {items.filter((item) => (statuses[item.id] ?? item.status) === status).length}
            </Badge>
          </div>
          <div className="space-y-3">
            {items
              .filter((item) => (statuses[item.id] ?? item.status) === status)
              .map((item) => (
                <button
                  key={item.id}
                  type="button"
                  draggable
                  onDragStart={(event) => event.dataTransfer.setData('text/plain', item.id)}
                  onClick={() => open(item.id)}
                  className="w-full overflow-hidden rounded-xl border bg-card text-left shadow-sm hover:shadow-md"
                >
                  <div className="flex gap-3 p-3">
                    <img
                      src={item.thumbnailUrl}
                      alt=""
                      className="size-16 rounded-lg object-cover"
                    />
                    <div className="min-w-0 flex-1">
                      <strong className="block truncate text-sm">{item.title}</strong>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {item.category} · 7 天 {item.plays7d} 次
                      </p>
                      <div className="mt-2 flex gap-1">
                        <Badge variant="outline">
                          {item.kind === 'showcase'
                            ? '效果图'
                            : item.kind === 'template'
                              ? '模板'
                              : '技能'}
                        </Badge>
                        {item.featured && (
                          <Badge className="bg-brand text-brand-foreground">推荐</Badge>
                        )}
                      </div>
                    </div>
                  </div>
                </button>
              ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function DetailPage({ detail, back }: { detail: Exclude<Detail, null>; back: () => void }) {
  return (
    <main className="mx-auto max-w-[1500px] p-5 pb-28 lg:p-7">
      <button
        type="button"
        onClick={back}
        className="mb-5 flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        返回列表
      </button>
      {detail.kind === 'inspiration' ? (
        <div className="grid gap-7 xl:grid-cols-[minmax(0,1.1fr)_minmax(360px,.8fr)]">
          <section>
            <h1 className="mb-1 text-2xl font-semibold">编辑灵感条目</h1>
            <p className="mb-6 text-sm text-muted-foreground">左边编辑，右边实时看主站效果。</p>
            <InspirationEditor key={detail.id} id={detail.id} />
          </section>
          <aside className="hidden xl:block">
            <div className="sticky top-24">
              <SitePreview
                item={INSPIRATIONS.find((item) => item.id === detail.id) ?? INSPIRATIONS[0]}
              />
            </div>
          </aside>
        </div>
      ) : detail.kind === 'user' ? (
        <div className="mx-auto max-w-3xl">
          <UserDetail id={detail.id} />
        </div>
      ) : (
        <div className="mx-auto max-w-3xl">
          <TaskDetail id={detail.id} />
        </div>
      )}
    </main>
  )
}
