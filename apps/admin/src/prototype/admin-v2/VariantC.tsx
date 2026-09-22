import {
  Activity,
  AlertTriangle,
  BellRing,
  BookOpen,
  Check,
  ChevronRight,
  ClipboardList,
  CreditCard,
  Database,
  HardDrive,
  HeartPulse,
  ListTodo,
  LogOut,
  Plus,
  Search,
  Server,
  Settings,
  Sparkles,
  Tags,
  Users,
  Wrench,
} from 'lucide-react'
import { useMemo, useState } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import {
  ALERTS,
  AUDITS,
  FAILURES,
  HOST,
  INSPIRATIONS,
  type InspirationStatus,
  KPIS,
  MODEL_USAGE,
  PENDING_PAYMENTS,
  SERVICES,
  SKILLS,
  TASKS,
  USERS,
} from './mock-data'
import {
  AuditContent,
  BillingContent,
  CategoriesContent,
  InspirationEditor,
  SkillsContent,
  StatusDot,
  TaskDetail,
  UserDetail,
  VolumeBars,
} from './shared'

type Module = 'inbox' | 'overview' | 'inspirations' | 'users' | 'tasks' | 'ops' | 'settings'
type Selection = {
  kind:
    | 'alert'
    | 'payment'
    | 'inspiration'
    | 'task'
    | 'metric'
    | 'model'
    | 'failure'
    | 'user'
    | 'ops'
    | 'setting'
    | 'skill'
    | 'category'
  id: string
}
type InspirationView = 'items' | 'skills' | 'categories'

const MODULES = [
  { id: 'inbox', label: '待办', icon: ListTodo },
  { id: 'overview', label: '概览', icon: Activity },
  { id: 'inspirations', label: '灵感库', icon: Sparkles },
  { id: 'users', label: '用户', icon: Users },
  { id: 'tasks', label: '任务', icon: ClipboardList },
  { id: 'ops', label: '运维', icon: HeartPulse },
  { id: 'settings', label: '设置', icon: Settings },
] as const

const MODULE_TITLE: Record<Module, string> = {
  inbox: '待办',
  overview: '概览',
  inspirations: '灵感库',
  users: '用户',
  tasks: '任务',
  ops: '运维',
  settings: '设置',
}

export function VariantC(): React.JSX.Element {
  const [module, setModule] = useState<Module>('inbox')
  const [selection, setSelection] = useState<Selection | null>({ kind: 'alert', id: 'al-1' })
  const [resolved, setResolved] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [inspirationView, setInspirationView] = useState<InspirationView>('items')
  const [inspirationStatus, setInspirationStatus] = useState('all')
  const [deviceFilter, setDeviceFilter] = useState<string | null>(null)

  const todoCount =
    ALERTS.filter((item) => item.level !== 'info').length +
    PENDING_PAYMENTS.length +
    INSPIRATIONS.filter((item) => item.status === 'draft').length +
    TASKS.filter((item) => item.status === 'failed' || item.status === 'processing').length
  const setActiveModule = (next: Module) => {
    setModule(next)
    setSelection(null)
    setDeviceFilter(null)
  }
  const filteredInspirations = INSPIRATIONS.filter(
    (item) =>
      (inspirationStatus === 'all' || item.status === inspirationStatus) &&
      `${item.title} ${item.category}`.toLowerCase().includes(query.toLowerCase()),
  )

  return (
    <div className="flex h-screen min-h-[680px] overflow-hidden bg-background pb-20 text-foreground">
      <aside className="z-30 flex w-16 shrink-0 flex-col items-center border-r bg-shell-nav py-3 text-shell-nav-foreground">
        <div className="relative mb-5 grid size-9 place-items-center rounded-xl bg-white/10">
          <div className="size-4 rounded-md border-2 border-brand" />
          <span className="absolute right-2 top-2 size-1.5 rounded-full bg-brand-mint" />
        </div>
        <nav className="flex flex-1 flex-col gap-1">
          {MODULES.map((item) => {
            const Icon = item.icon
            const count =
              item.id === 'inbox'
                ? todoCount - resolved.length
                : item.id === 'ops'
                  ? ALERTS.filter((alert) => alert.level !== 'info').length
                  : 0
            return (
              <Tooltip key={item.id}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={item.label}
                    onClick={() => setActiveModule(item.id)}
                    className={cn(
                      'relative grid size-10 place-items-center rounded-xl hover:bg-white/10 hover:text-white',
                      module === item.id &&
                        'bg-brand text-brand-foreground hover:bg-brand hover:text-brand-foreground',
                    )}
                  >
                    <Icon className="size-[18px]" />
                    {count > 0 && (
                      <span className="absolute -right-1 -top-1 grid min-w-4 place-items-center rounded-full bg-rose-500 px-1 text-[9px] font-bold text-white">
                        {count}
                      </span>
                    )}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">{item.label}</TooltipContent>
              </Tooltip>
            )
          })}
        </nav>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="退出"
              className="grid size-10 place-items-center rounded-xl hover:bg-white/10"
            >
              <LogOut className="size-[18px]" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">退出</TooltipContent>
        </Tooltip>
      </aside>

      <section className="flex w-[360px] shrink-0 flex-col border-r bg-muted/20">
        <div className="border-b p-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="font-semibold">{MODULE_TITLE[module]}</h1>
              <p className="text-[11px] text-muted-foreground">Prototype C · 三栏收件箱</p>
            </div>
            {module === 'inspirations' && (
              <Button
                size="icon"
                className="size-8 bg-brand text-brand-foreground hover:bg-brand-hover"
              >
                <Plus className="size-4" />
              </Button>
            )}
          </div>
          <div className="mt-3 flex items-center gap-2 rounded-lg border bg-background px-2">
            <Search className="size-4 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="筛选当前列表"
              className="border-0 px-0 shadow-none focus-visible:ring-0"
            />
          </div>
          {module === 'inspirations' && (
            <>
              <Tabs
                value={inspirationView}
                onValueChange={(value) => {
                  setInspirationView(value as InspirationView)
                  setSelection(null)
                }}
                className="mt-3"
              >
                <TabsList className="grid w-full grid-cols-3">
                  <TabsTrigger value="items">条目</TabsTrigger>
                  <TabsTrigger value="skills">技能</TabsTrigger>
                  <TabsTrigger value="categories">分类</TabsTrigger>
                </TabsList>
              </Tabs>
              {inspirationView === 'items' && (
                <div className="mt-2 flex gap-1 overflow-x-auto">
                  {[
                    ['all', '全部'],
                    ['draft', '草稿'],
                    ['published', '已发布'],
                    ['archived', '已下架'],
                  ].map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setInspirationStatus(value)}
                      className={cn(
                        'rounded-full px-2.5 py-1 text-[11px]',
                        inspirationStatus === value
                          ? 'bg-foreground text-background'
                          : 'bg-muted text-muted-foreground',
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
        <div
          className="flex-1 overflow-y-auto"
          role="listbox"
          tabIndex={0}
          onKeyDown={(event) => {
            if (
              event.target instanceof HTMLInputElement ||
              event.target instanceof HTMLTextAreaElement
            )
              return
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
            event.preventDefault()
            const rows = getRows(module, inspirationView, inspirationStatus, query, deviceFilter)
            if (!rows.length) return
            const current = selection
              ? rows.findIndex((row) => row.kind === selection.kind && row.id === selection.id)
              : -1
            const next =
              event.key === 'ArrowDown'
                ? Math.min(rows.length - 1, current + 1)
                : Math.max(0, current - 1)
            setSelection(rows[next])
          }}
        >
          <ListPane
            module={module}
            selection={selection}
            setSelection={setSelection}
            resolved={resolved}
            query={query}
            inspirationView={inspirationView}
            inspirationStatus={inspirationStatus}
            deviceFilter={deviceFilter}
          />
        </div>
      </section>

      <main className="min-w-0 flex-1 overflow-y-auto bg-background">
        <div className="sticky top-0 z-20 flex min-h-16 items-center justify-between border-b bg-background/90 px-6 backdrop-blur">
          <div>
            <h2 className="font-semibold">
              {selection ? detailTitle(selection) : MODULE_TITLE[module]}
            </h2>
            <p className="text-xs text-muted-foreground">
              {selection ? '选择后在这里处理，不离开队列' : '从中栏选择一项'}
            </p>
          </div>
          {selection && <Badge variant="outline">{selection.kind}</Badge>}
        </div>
        <div className="mx-auto max-w-5xl p-6">
          <DetailPane
            selection={selection}
            module={module}
            resolved={resolved}
            resolve={(key) => {
              setResolved((items) => [...items, key])
              setSelection(null)
            }}
            setModule={setActiveModule}
            setSelection={setSelection}
            setDeviceFilter={setDeviceFilter}
          />
        </div>
      </main>
    </div>
  )
}

function getRows(
  module: Module,
  view: InspirationView,
  status: string,
  query: string,
  device: string | null,
): Selection[] {
  if (module === 'inbox')
    return [
      ...ALERTS.filter((item) => item.level !== 'info').map((item) => ({
        kind: 'alert' as const,
        id: item.id,
      })),
      ...PENDING_PAYMENTS.map((item) => ({ kind: 'payment' as const, id: item.id })),
      ...INSPIRATIONS.filter((item) => item.status === 'draft').map((item) => ({
        kind: 'inspiration' as const,
        id: item.id,
      })),
      ...TASKS.filter((item) => item.status === 'failed' || item.status === 'processing').map(
        (item) => ({ kind: 'task' as const, id: item.id }),
      ),
    ]
  if (module === 'overview')
    return [
      ...KPIS.map((item) => ({ kind: 'metric' as const, id: item.key })),
      ...MODEL_USAGE.map((item) => ({ kind: 'model' as const, id: item.model })),
      ...FAILURES.map((item) => ({ kind: 'failure' as const, id: item.reason })),
    ]
  if (module === 'inspirations') {
    if (view === 'skills') return SKILLS.map((item) => ({ kind: 'skill' as const, id: item.name }))
    if (view === 'categories')
      return INSPIRATIONS.map((item) => item.category)
        .filter((item, index, values) => values.indexOf(item) === index)
        .map((id) => ({ kind: 'category' as const, id }))
    return INSPIRATIONS.filter(
      (item) =>
        (status === 'all' || item.status === status) &&
        `${item.title} ${item.category}`.toLowerCase().includes(query.toLowerCase()),
    ).map((item) => ({ kind: 'inspiration' as const, id: item.id }))
  }
  if (module === 'users')
    return USERS.filter((item) =>
      `${item.displayName} ${item.email}`.toLowerCase().includes(query.toLowerCase()),
    ).map((item) => ({ kind: 'user' as const, id: item.id }))
  if (module === 'tasks')
    return TASKS.filter(
      (item) =>
        (!device || item.deviceId === device) &&
        `${item.id} ${item.model}`.toLowerCase().includes(query.toLowerCase()),
    ).map((item) => ({ kind: 'task' as const, id: item.id }))
  if (module === 'ops')
    return ['services', 'host', 'alerts', 'deployments', 'queue'].map((id) => ({
      kind: 'ops' as const,
      id,
    }))
  return ['billing', 'audit', 'categories'].map((id) => ({ kind: 'setting' as const, id }))
}

function ListPane({
  module,
  selection,
  setSelection,
  resolved,
  query,
  inspirationView,
  inspirationStatus,
  deviceFilter,
}: {
  module: Module
  selection: Selection | null
  setSelection: (value: Selection) => void
  resolved: string[]
  query: string
  inspirationView: InspirationView
  inspirationStatus: string
  deviceFilter: string | null
}) {
  const rows = getRows(module, inspirationView, inspirationStatus, query, deviceFilter).filter(
    (row) => !resolved.includes(`${row.kind}:${row.id}`),
  )
  let previousGroup = ''
  return (
    <div className="p-2">
      {rows.map((row) => {
        const meta = rowMeta(row)
        const group = module === 'inbox' ? inboxGroup(row.kind) : ''
        const showGroup = group && group !== previousGroup
        previousGroup = group
        return (
          <div key={`${row.kind}:${row.id}`}>
            {showGroup && (
              <p className="px-2 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {group}
              </p>
            )}
            <button
              type="button"
              onClick={() => setSelection(row)}
              className={cn(
                'mb-1 flex w-full items-center gap-3 rounded-xl p-2.5 text-left transition',
                selection?.kind === row.kind && selection.id === row.id
                  ? 'bg-brand/40 ring-1 ring-brand-mint'
                  : 'hover:bg-muted',
              )}
            >
              <div className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-lg bg-muted">
                {meta.image ? (
                  <img src={meta.image} alt="" className="size-full object-cover" />
                ) : (
                  meta.icon
                )}
              </div>
              <div className="min-w-0 flex-1">
                <strong className="block truncate text-sm">{meta.title}</strong>
                <p className="truncate text-xs text-muted-foreground">{meta.subtitle}</p>
              </div>
              {meta.badge && (
                <Badge variant={meta.danger ? 'destructive' : 'secondary'} className="shrink-0">
                  {meta.badge}
                </Badge>
              )}
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
            </button>
          </div>
        )
      })}
      {rows.length === 0 && (
        <p className="p-8 text-center text-sm text-muted-foreground">已处理完</p>
      )}
    </div>
  )
}

function inboxGroup(kind: Selection['kind']): string {
  if (kind === 'alert') return '告警'
  if (kind === 'payment') return '待确认收款 · 私有树'
  if (kind === 'inspiration') return '待发布灵感'
  return '卡住与失败任务'
}

function rowMeta(row: Selection): {
  title: string
  subtitle: string
  badge?: string
  danger?: boolean
  image?: string
  icon: React.ReactNode
} {
  if (row.kind === 'alert') {
    const item = ALERTS.find((value) => value.id === row.id)!
    return {
      title: item.title,
      subtitle: item.detail,
      badge: item.at,
      danger: item.level === 'critical',
      icon: <AlertTriangle className="size-4 text-amber-500" />,
    }
  }
  if (row.kind === 'payment') {
    const item = PENDING_PAYMENTS.find((value) => value.id === row.id)!
    return {
      title: item.kind,
      subtitle: item.email,
      badge: `¥${item.amountCents / 100}`,
      icon: <CreditCard className="size-4 text-violet-500" />,
    }
  }
  if (row.kind === 'inspiration') {
    const item = INSPIRATIONS.find((value) => value.id === row.id)!
    return {
      title: item.title,
      subtitle: `${item.category} · ${item.status}`,
      badge: item.featured ? '推荐' : undefined,
      image: item.thumbnailUrl,
      icon: <Sparkles className="size-4" />,
    }
  }
  if (row.kind === 'task') {
    const item = TASKS.find((value) => value.id === row.id)!
    return {
      title: item.id,
      subtitle: `${item.model} · ${item.deviceId}`,
      badge: item.status,
      danger: item.status === 'failed',
      image: item.thumbnailUrl,
      icon: <ClipboardList className="size-4" />,
    }
  }
  if (row.kind === 'user') {
    const item = USERS.find((value) => value.id === row.id)!
    return {
      title: item.displayName,
      subtitle: item.email,
      badge: item.plan,
      icon: <Users className="size-4" />,
    }
  }
  if (row.kind === 'metric') {
    const item = KPIS.find((value) => value.key === row.id)!
    return {
      title: item.label,
      subtitle: item.delta ?? '—',
      badge: item.value,
      icon: <Activity className="size-4" />,
    }
  }
  if (row.kind === 'model') {
    const item = MODEL_USAGE.find((value) => value.model === row.id)!
    return {
      title: item.model,
      subtitle: item.provider,
      badge: String(item.count),
      icon: <Database className="size-4" />,
    }
  }
  if (row.kind === 'failure') {
    const item = FAILURES.find((value) => value.reason === row.id)!
    return {
      title: item.reason,
      subtitle: `样本 ${item.sample}`,
      badge: String(item.count),
      danger: true,
      icon: <AlertTriangle className="size-4 text-rose-500" />,
    }
  }
  if (row.kind === 'skill') {
    const item = SKILLS.find((value) => value.name === row.id)!
    return {
      title: item.title,
      subtitle: `/${item.name} · ${item.summary}`,
      badge: String(item.linkedInspirations),
      icon: <Wrench className="size-4" />,
    }
  }
  if (row.kind === 'category')
    return { title: row.id, subtitle: '拖动调整主站顺序', icon: <Tags className="size-4" /> }
  if (row.kind === 'ops') {
    const labels: Record<string, string> = {
      services: '服务心跳',
      host: '宿主机',
      alerts: '告警',
      deployments: '部署记录',
      queue: '队列',
    }
    return {
      title: labels[row.id],
      subtitle: row.id === 'host' ? '磁盘 91% · 内存 74%' : '查看详细状态',
      badge: row.id === 'alerts' ? '3' : undefined,
      danger: row.id === 'alerts' || row.id === 'host',
      icon: row.id === 'host' ? <HardDrive className="size-4" /> : <Server className="size-4" />,
    }
  }
  const labels: Record<string, string> = {
    billing: '收款与计费',
    audit: '审计',
    categories: '分类',
  }
  return {
    title: labels[row.id],
    subtitle: row.id === 'billing' ? '私有树' : '运营设置',
    icon:
      row.id === 'billing' ? <CreditCard className="size-4" /> : <BookOpen className="size-4" />,
  }
}

function detailTitle(selection: Selection): string {
  return rowMeta(selection).title
}

function DetailPane({
  selection,
  module,
  resolved,
  resolve,
  setModule,
  setSelection,
  setDeviceFilter,
}: {
  selection: Selection | null
  module: Module
  resolved: string[]
  resolve: (key: string) => void
  setModule: (value: Module) => void
  setSelection: (value: Selection | null) => void
  setDeviceFilter: (value: string | null) => void
}) {
  if (!selection)
    return (
      <div className="flex min-h-[520px] flex-col items-center justify-center text-muted-foreground">
        <ListTodo className="mb-3 size-10 opacity-20" />
        <p className="text-sm">从中栏选择一项</p>
      </div>
    )
  const actionKey = `${selection.kind}:${selection.id}`
  if (selection.kind === 'inspiration')
    return <InspirationEditor key={selection.id} id={selection.id} />
  if (selection.kind === 'user') return <UserDetail id={selection.id} />
  if (selection.kind === 'task')
    return (
      <TaskDetail
        id={selection.id}
        onDevice={(device) => {
          setModule('tasks')
          setDeviceFilter(device)
          setSelection({ kind: 'task', id: selection.id })
        }}
      />
    )
  if (selection.kind === 'payment')
    return (
      <div className="max-w-xl space-y-5">
        <div className="rounded-xl border bg-card p-5">
          <Badge className="mb-3 bg-violet-600">私有树</Badge>
          <h3 className="text-xl font-semibold">确认实际收款</h3>
          <p className="mt-2 text-sm text-muted-foreground">
            核对金额后，由 BFF 原子记录实付事实、购买权益、积分流水与运营审计。
          </p>
        </div>
        <Button onClick={() => resolve(actionKey)}>
          <Check className="mr-2 size-4" />
          确认收款并移出待办
        </Button>
      </div>
    )
  if (selection.kind === 'alert') {
    const alert = ALERTS.find((item) => item.id === selection.id)!
    return (
      <div className="max-w-xl space-y-5">
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-5">
          <AlertTriangle className="mb-3 size-6 text-rose-500" />
          <h3 className="text-xl font-semibold">{alert.title}</h3>
          <p className="mt-2 text-sm text-muted-foreground">{alert.detail}</p>
        </div>
        <Button onClick={() => resolve(actionKey)}>已知晓并移出待办</Button>
      </div>
    )
  }
  if (selection.kind === 'metric')
    return (
      <div className="space-y-5">
        <div className="text-4xl font-semibold">
          {KPIS.find((item) => item.key === selection.id)?.value}
        </div>
        <div className="rounded-xl border bg-card p-5">
          <VolumeBars />
        </div>
      </div>
    )
  if (selection.kind === 'model') {
    const model = MODEL_USAGE.find((item) => item.model === selection.id)!
    return (
      <div className="max-w-xl space-y-4">
        <h3 className="text-2xl font-semibold">{model.model}</h3>
        <Progress value={model.share * 100} />
        <p className="text-sm text-muted-foreground">
          {model.count} 次 · P50 {(model.p50Ms / 1000).toFixed(1)}s
        </p>
      </div>
    )
  }
  if (selection.kind === 'failure') {
    const failure = FAILURES.find((item) => item.reason === selection.id)!
    return (
      <div className="rounded-xl border bg-card p-5">
        <h3 className="font-mono text-xl">{failure.reason}</h3>
        <p className="mt-2 text-sm text-muted-foreground">
          {failure.count} 次 · 样本 {failure.sample}
        </p>
      </div>
    )
  }
  if (selection.kind === 'skill') return <SkillsContent />
  if (selection.kind === 'category') return <CategoriesContent />
  if (selection.kind === 'ops') return <OpsDetail id={selection.id} />
  if (selection.kind === 'setting' && selection.id === 'billing') return <BillingContent />
  if (selection.kind === 'setting' && selection.id === 'audit') return <AuditContent />
  if (selection.kind === 'setting') return <CategoriesContent />
  return (
    <div>
      {module} · {resolved.length}
    </div>
  )
}

function OpsDetail({ id }: { id: string }) {
  if (id === 'host')
    return (
      <div className="space-y-5">
        <div className="grid grid-cols-3 gap-3">
          <Metric label="磁盘" value="91%" danger />
          <Metric label="内存" value="74%" />
          <Metric label="CPU" value="37%" />
        </div>
        <div className="rounded-xl border bg-card p-5">
          <h3 className="mb-4 font-semibold">24 小时资源趋势</h3>
          <VolumeBars />
        </div>
      </div>
    )
  if (id === 'services')
    return (
      <div className="overflow-hidden rounded-xl border bg-card">
        {SERVICES.map((service) => (
          <div key={service.name} className="flex items-center gap-3 border-b p-4 last:border-0">
            <StatusDot status={service.status} />
            <strong>{service.name}</strong>
            <code className="ml-auto text-xs text-muted-foreground">{service.version}</code>
            <span className="text-xs text-muted-foreground">{service.heartbeat}</span>
          </div>
        ))}
      </div>
    )
  if (id === 'alerts')
    return (
      <div className="space-y-3">
        {ALERTS.map((alert) => (
          <div key={alert.id} className="rounded-xl border p-4">
            <strong>{alert.title}</strong>
            <p className="mt-1 text-sm text-muted-foreground">{alert.detail}</p>
          </div>
        ))}
      </div>
    )
  return (
    <div className="rounded-xl border bg-card p-8 text-center text-muted-foreground">
      {id === 'deployments' ? '部署记录按时间倒序' : '4 条 processing · 1 条 queued'}
    </div>
  )
}

function Metric({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <span className="text-xs text-muted-foreground">{label}</span>
      <strong className={cn('mt-2 block text-2xl', danger && 'text-rose-500')}>{value}</strong>
    </div>
  )
}
