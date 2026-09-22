import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  ChevronRight,
  Circle,
  Clock3,
  Eye,
  GripVertical,
  HeartPulse,
  ImagePlus,
  Layers3,
  MoreHorizontal,
  Play,
  Server,
  Sparkles,
  Star,
  XCircle,
} from 'lucide-react'
import { useMemo, useState } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import {
  ALERTS,
  AUDITS,
  CATEGORIES,
  DEPLOYMENTS,
  FAILURES,
  formatCents,
  HOST,
  INSPIRATIONS,
  type Inspiration,
  type InspirationKind,
  type InspirationStatus,
  KPIS,
  MODEL_USAGE,
  PENDING_PAYMENTS,
  pct,
  SERVICES,
  SKILLS,
  TASKS,
  type TaskStatus,
  USERS,
  VOLUME_SERIES,
} from './mock-data'

export const KIND_LABEL: Record<InspirationKind, string> = {
  showcase: '效果图',
  template: '模板',
  skill: '技能示例',
}

export const STATUS_LABEL: Record<InspirationStatus, string> = {
  draft: '草稿',
  published: '已发布',
  archived: '已下架',
}

const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  queued: '排队中',
  processing: '生成中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

export function StatusDot({ status }: { status: string }) {
  const good =
    status === 'up' || status === 'published' || status === 'completed' || status === 'active'
  const bad =
    status === 'down' || status === 'failed' || status === 'critical' || status === 'disabled'
  return (
    <span
      className={cn(
        'inline-block size-2 rounded-full',
        good && 'bg-emerald-500',
        bad && 'bg-rose-500',
        !good && !bad && 'bg-amber-500',
      )}
    />
  )
}

export function SectionTitle({
  title,
  hint,
  action,
}: {
  title: string
  hint?: string
  action?: React.ReactNode
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        {hint && <p className="mt-0.5 text-sm text-muted-foreground">{hint}</p>}
      </div>
      {action}
    </div>
  )
}

export function KpiStrip() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
      {KPIS.map((item) => (
        <Card key={item.key} className="overflow-hidden">
          <CardContent className="p-4">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{item.label}</span>
              {item.hint && <Badge variant="outline">{item.hint}</Badge>}
            </div>
            <div className="mt-2 flex items-end justify-between gap-2">
              <strong className="text-2xl tracking-tight">{item.value}</strong>
              {item.delta && (
                <span
                  className={cn(
                    'flex items-center gap-0.5 text-xs font-medium',
                    item.tone === 'up'
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : 'text-rose-600 dark:text-rose-400',
                  )}
                >
                  {item.tone === 'up' ? (
                    <ArrowUp className="size-3" />
                  ) : (
                    <ArrowDown className="size-3" />
                  )}
                  {item.delta}
                </span>
              )}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

export function VolumeBars({ compact = false }: { compact?: boolean }) {
  const max = Math.max(...VOLUME_SERIES.map((point) => point.ok + point.failed))
  return (
    <div className={cn('flex items-end gap-1', compact ? 'h-32' : 'h-48')}>
      {VOLUME_SERIES.map((point) => (
        <div
          key={point.t}
          className="group flex h-full min-w-0 flex-1 flex-col justify-end"
          title={`${point.t} 成功 ${point.ok} / 失败 ${point.failed}`}
        >
          <div
            className="rounded-t-sm bg-rose-400"
            style={{ height: `${(point.failed / max) * 100}%`, minHeight: point.failed ? 2 : 0 }}
          />
          <div className="bg-emerald-400/80" style={{ height: `${(point.ok / max) * 100}%` }} />
          {!compact && Number(point.t.slice(0, 2)) % 4 === 0 && (
            <span className="mt-1 text-center text-[9px] text-muted-foreground">
              {point.t.slice(0, 2)}
            </span>
          )}
        </div>
      ))}
    </div>
  )
}

export function OverviewContent() {
  return (
    <div className="space-y-5">
      <KpiStrip />
      <div className="grid gap-4 xl:grid-cols-[1.45fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">24 小时任务量</CardTitle>
          </CardHeader>
          <CardContent>
            <VolumeBars />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">模型用量</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {MODEL_USAGE.map((item) => (
              <div key={item.model}>
                <div className="mb-1.5 flex justify-between gap-3 text-sm">
                  <span className="truncate font-medium">{item.model}</span>
                  <span className="text-muted-foreground">
                    {item.count} · {pct(item.share)}
                  </span>
                </div>
                <Progress value={item.share * 100} className="h-2" />
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">失败分布</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {FAILURES.map((failure) => (
            <div key={failure.reason} className="rounded-lg border p-3">
              <div className="flex items-center justify-between">
                <code className="text-xs">{failure.reason}</code>
                <Badge variant="destructive">{failure.count}</Badge>
              </div>
              <p className="mt-3 text-xs text-muted-foreground">样本 {failure.sample}</p>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  )
}

export function OpsContent({ onAlert }: { onAlert?: (id: string) => void }) {
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Server className="size-4" />
            服务心跳
          </CardTitle>
        </CardHeader>
        <CardContent className="divide-y">
          {SERVICES.map((service) => (
            <div key={service.name} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
              <StatusDot status={service.status} />
              <span className="min-w-0 flex-1 font-medium">{service.name}</span>
              <code className="hidden text-xs text-muted-foreground sm:block">
                {service.version}
              </code>
              <span className="text-xs text-muted-foreground">{service.heartbeat}</span>
            </div>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <HeartPulse className="size-4" />
            宿主机
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Gauge
            label="磁盘"
            value={(HOST.disk.used / HOST.disk.total) * 100}
            meta={`${HOST.disk.used} / ${HOST.disk.total} GB`}
            danger
          />
          <Gauge
            label="内存"
            value={(HOST.memory.used / HOST.memory.total) * 100}
            meta={`${HOST.memory.used} / ${HOST.memory.total} GB`}
          />
          <Gauge label="CPU" value={HOST.cpu * 100} meta={`${Math.round(HOST.cpu * 100)}%`} />
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>负载 {HOST.load}</span>
            <span>运行 {HOST.uptime}</span>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <AlertTriangle className="size-4" />
            告警
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {ALERTS.map((alert) => (
            <button
              key={alert.id}
              type="button"
              onClick={() => onAlert?.(alert.id)}
              className="flex w-full items-start gap-3 rounded-lg border p-3 text-left hover:bg-muted/50"
            >
              {alert.level === 'critical' ? (
                <XCircle className="mt-0.5 size-4 text-rose-500" />
              ) : alert.level === 'warning' ? (
                <AlertTriangle className="mt-0.5 size-4 text-amber-500" />
              ) : (
                <CheckCircle2 className="mt-0.5 size-4 text-emerald-500" />
              )}
              <span className="min-w-0 flex-1">
                <strong className="block text-sm">{alert.title}</strong>
                <span className="block truncate text-xs text-muted-foreground">{alert.detail}</span>
              </span>
              <span className="whitespace-nowrap text-[11px] text-muted-foreground">
                {alert.at}
              </span>
            </button>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">部署记录</CardTitle>
        </CardHeader>
        <CardContent className="divide-y">
          {DEPLOYMENTS.map((deployment) => (
            <div key={deployment.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
              <StatusDot status={deployment.result === 'ok' ? 'up' : 'down'} />
              <span className="font-medium">{deployment.edition}</span>
              <code className="text-xs">{deployment.publicSha}</code>
              <span className="ml-auto text-xs text-muted-foreground">{deployment.at}</span>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  )
}

function Gauge({
  label,
  value,
  meta,
  danger,
}: {
  label: string
  value: number
  meta: string
  danger?: boolean
}) {
  return (
    <div>
      <div className="mb-1.5 flex justify-between text-sm">
        <span>{label}</span>
        <span
          className={
            danger ? 'font-medium text-rose-600 dark:text-rose-400' : 'text-muted-foreground'
          }
        >
          {meta}
        </span>
      </div>
      <Progress value={value} className={cn('h-2', danger && '[&>div]:bg-rose-500')} />
    </div>
  )
}

export function UsersContent({ onSelect }: { onSelect: (id: string) => void }) {
  const [query, setQuery] = useState('')
  const filtered = USERS.filter((user) =>
    `${user.displayName} ${user.email}`.toLowerCase().includes(query.toLowerCase()),
  )
  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索邮箱或昵称"
          className="max-w-sm"
        />
        <Button>新建用户</Button>
      </div>
      <div className="overflow-hidden rounded-xl border bg-card">
        {filtered.map((user) => (
          <button
            key={user.id}
            type="button"
            onClick={() => onSelect(user.id)}
            className="grid w-full grid-cols-[1fr_auto] gap-4 border-b p-4 text-left last:border-0 hover:bg-muted/50 md:grid-cols-[1.4fr_1fr_auto_auto]"
          >
            <span>
              <strong className="block text-sm">{user.displayName}</strong>
              <span className="text-xs text-muted-foreground">{user.email}</span>
            </span>
            <span className="hidden text-sm md:block">
              <Badge variant="outline">{user.plan}</Badge>
              <span className="ml-2 text-muted-foreground">
                {user.credits.toLocaleString()} 积分
              </span>
            </span>
            <span className="hidden text-sm text-muted-foreground md:block">
              30 天 {user.tasks30d} 次
            </span>
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              <StatusDot status={user.status} />
              {user.lastActiveAt}
              <ChevronRight className="size-4" />
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

export function UserDetail({ id }: { id: string }) {
  const user = USERS.find((item) => item.id === id) ?? USERS[0]
  const tasks = TASKS.filter((task) => task.userId === user.id)
  return (
    <div className="space-y-5">
      <div className="rounded-xl border bg-card p-5">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-xl font-semibold">{user.displayName}</h3>
            <p className="text-sm text-muted-foreground">
              {user.email} · {user.id}
            </p>
          </div>
          <Badge variant={user.status === 'active' ? 'success' : 'destructive'}>
            {user.status === 'active' ? '正常' : '停用'}
          </Badge>
        </div>
        <div className="mt-5 grid grid-cols-3 gap-3">
          <MiniStat label="套餐" value={user.plan} />
          <MiniStat label="积分" value={user.credits.toLocaleString()} />
          <MiniStat label="30 天任务" value={String(user.tasks30d)} />
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline">重置密码</Button>
        <Button variant="outline">撤销会话</Button>
        <Button variant="destructive">停用</Button>
        <Button className="bg-brand text-brand-foreground hover:bg-brand-hover">
          赠送积分 · 私有树
        </Button>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">最近任务</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {tasks.length ? (
            tasks.map((task) => <TaskCompact key={task.id} task={task} />)
          ) : (
            <p className="text-sm text-muted-foreground">没有任务</p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-muted p-3">
      <span className="block text-xs text-muted-foreground">{label}</span>
      <strong className="mt-1 block">{value}</strong>
    </div>
  )
}

export function TasksContent({
  onSelect,
  deviceFilter,
}: {
  onSelect: (id: string) => void
  deviceFilter?: string
}) {
  const [status, setStatus] = useState('all')
  const filtered = TASKS.filter(
    (task) =>
      (!deviceFilter || task.deviceId === deviceFilter) &&
      (status === 'all' || task.status === status),
  )
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部状态</SelectItem>
            {Object.entries(TASK_STATUS_LABEL).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {deviceFilter && <Badge variant="outline">设备 {deviceFilter}</Badge>}
      </div>
      <div className="overflow-hidden rounded-xl border bg-card">
        {filtered.map((task) => (
          <button
            key={task.id}
            type="button"
            onClick={() => onSelect(task.id)}
            className="w-full border-b p-3 text-left last:border-0 hover:bg-muted/50"
          >
            <TaskCompact task={task} />
          </button>
        ))}
      </div>
    </div>
  )
}

function TaskCompact({ task }: { task: (typeof TASKS)[number] }) {
  return (
    <div className="flex items-center gap-3">
      <div className="size-12 shrink-0 overflow-hidden rounded-lg bg-muted">
        {task.thumbnailUrl ? (
          <img src={task.thumbnailUrl} alt="" className="size-full object-cover" />
        ) : (
          <Clock3 className="m-3 size-6 text-muted-foreground" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <code className="text-xs font-semibold">{task.id}</code>
          <Badge
            variant={
              task.status === 'failed'
                ? 'destructive'
                : task.status === 'completed'
                  ? 'success'
                  : 'warning'
            }
          >
            {TASK_STATUS_LABEL[task.status]}
          </Badge>
        </div>
        <p className="mt-1 truncate text-xs text-muted-foreground">{task.prompt}</p>
      </div>
      <div className="hidden text-right text-xs text-muted-foreground sm:block">
        <span className="block">{task.model}</span>
        <span>{task.createdAt}</span>
      </div>
    </div>
  )
}

export function TaskDetail({
  id,
  onDevice,
}: {
  id: string
  onDevice?: (deviceId: string) => void
}) {
  const task = TASKS.find((item) => item.id === id) ?? TASKS[0]
  return (
    <div className="space-y-4">
      {task.thumbnailUrl && (
        <img
          src={task.thumbnailUrl}
          alt="任务结果"
          className="aspect-video w-full rounded-xl object-cover"
        />
      )}
      <div className="flex items-center gap-2">
        <Badge
          variant={
            task.status === 'failed'
              ? 'destructive'
              : task.status === 'completed'
                ? 'success'
                : 'warning'
          }
        >
          {TASK_STATUS_LABEL[task.status]}
        </Badge>
        <code className="text-xs">{task.id}</code>
      </div>
      <div>
        <span className="text-xs text-muted-foreground">完整提示词</span>
        <p className="mt-1 rounded-lg bg-muted p-3 text-sm leading-6">{task.prompt}</p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <MiniStat label="模型" value={task.model} />
        <MiniStat
          label="耗时"
          value={task.durationMs ? `${(task.durationMs / 1000).toFixed(1)}s` : '—'}
        />
        <button
          type="button"
          onClick={() => onDevice?.(task.deviceId)}
          className="rounded-lg bg-muted p-3 text-left hover:ring-2 hover:ring-ring"
        >
          <span className="block text-xs text-muted-foreground">设备</span>
          <strong className="mt-1 block">{task.deviceId}</strong>
        </button>
        <MiniStat label="错误码" value={task.errorCode ?? '—'} />
      </div>
    </div>
  )
}

export function InspirationGrid({
  items = INSPIRATIONS,
  onSelect,
}: {
  items?: readonly Inspiration[]
  onSelect: (id: string) => void
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={() => onSelect(item.id)}
          className="group overflow-hidden rounded-xl border bg-card text-left transition hover:-translate-y-0.5 hover:shadow-md"
        >
          <div className="relative aspect-[4/3] overflow-hidden bg-muted">
            <img
              src={item.thumbnailUrl}
              alt=""
              className="size-full object-cover transition duration-300 group-hover:scale-[1.03]"
            />
            <div className="absolute inset-x-2 top-2 flex justify-between">
              <Badge className="bg-background/90 text-foreground shadow-none backdrop-blur">
                {KIND_LABEL[item.kind]}
              </Badge>
              {item.featured && (
                <span className="rounded-full bg-brand p-1 text-brand-foreground">
                  <Star className="size-3 fill-current" />
                </span>
              )}
            </div>
          </div>
          <div className="p-3">
            <div className="flex items-start gap-2">
              <StatusDot status={item.status} />
              <strong className="line-clamp-1 flex-1 text-sm">{item.title}</strong>
              <MoreHorizontal className="size-4 text-muted-foreground" />
            </div>
            <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
              <span>{item.category}</span>
              <span className="flex items-center gap-1">
                <Play className="size-3" />
                {item.plays7d}
              </span>
            </div>
          </div>
        </button>
      ))}
    </div>
  )
}

export function InspirationFilters({
  query,
  onQuery,
  status,
  onStatus,
}: {
  query: string
  onQuery: (value: string) => void
  status: string
  onStatus: (value: string) => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        value={query}
        onChange={(event) => onQuery(event.target.value)}
        placeholder="搜索标题、分类或标签"
        className="w-72"
      />
      <Select value={status} onValueChange={onStatus}>
        <SelectTrigger className="w-36">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">全部状态</SelectItem>
          <SelectItem value="draft">草稿</SelectItem>
          <SelectItem value="published">已发布</SelectItem>
          <SelectItem value="archived">已下架</SelectItem>
        </SelectContent>
      </Select>
    </div>
  )
}

export function useFilteredInspirations(query: string, status: string) {
  return useMemo(
    () =>
      INSPIRATIONS.filter((item) => {
        const matchesQuery = `${item.title} ${item.category} ${item.tags.join(' ')}`
          .toLowerCase()
          .includes(query.toLowerCase())
        return matchesQuery && (status === 'all' || item.status === status)
      }),
    [query, status],
  )
}

export function InspirationEditor({
  id,
  previewFirst = false,
}: {
  id: string
  previewFirst?: boolean
}) {
  const source = INSPIRATIONS.find((item) => item.id === id) ?? INSPIRATIONS[0]
  const [title, setTitle] = useState(source.title)
  const [prompt, setPrompt] = useState(source.prompt)
  const [description, setDescription] = useState(source.description ?? '')
  const [featured, setFeatured] = useState(source.featured)
  const [status, setStatus] = useState<InspirationStatus>(source.status)
  const preview = { ...source, title, prompt, description, featured, status }
  return (
    <Tabs defaultValue={previewFirst ? 'preview' : 'content'} className="space-y-4">
      <TabsList className="grid w-full grid-cols-4">
        <TabsTrigger value="content">内容</TabsTrigger>
        <TabsTrigger value="params">参数与参考图</TabsTrigger>
        <TabsTrigger value="preview">主站预览</TabsTrigger>
        <TabsTrigger value="history">发布历史</TabsTrigger>
      </TabsList>
      <TabsContent value="content" className="space-y-4">
        <FormField label="标题">
          <Input value={title} onChange={(event) => setTitle(event.target.value)} />
        </FormField>
        <FormField label="说明">
          <Textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={2}
          />
        </FormField>
        <FormField label="提示词">
          <Textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            rows={9}
            className="font-mono text-xs leading-5"
          />
          {source.kind === 'template' && (
            <div className="mt-2 flex gap-2">
              <Badge variant="info">槽位 主题</Badge>
              <span className="text-xs text-muted-foreground">主站会渲染为可填写 chip</span>
            </div>
          )}
        </FormField>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="类型">
            <Select defaultValue={source.kind}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="showcase">效果图</SelectItem>
                <SelectItem value="template">模板</SelectItem>
                <SelectItem value="skill">技能示例</SelectItem>
              </SelectContent>
            </Select>
          </FormField>
          <FormField label="分类">
            <Select defaultValue={source.category}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CATEGORIES.map((category) => (
                  <SelectItem key={category} value={category}>
                    {category}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
        </div>
        {source.kind === 'skill' && (
          <FormField label="关联技能（正文只读）">
            <Select defaultValue={source.skill}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SKILLS.map((skill) => (
                  <SelectItem key={skill.name} value={skill.name}>
                    /{skill.name} · {skill.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
        )}
        <label className="flex items-center justify-between rounded-lg border p-3">
          <span>
            <strong className="block text-sm">首页推荐位</strong>
            <span className="text-xs text-muted-foreground">进入创作页冷启动卡片候选</span>
          </span>
          <Switch checked={featured} onCheckedChange={setFeatured} />
        </label>
      </TabsContent>
      <TabsContent value="params" className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Provider">
            <Select defaultValue={source.recommendedProvider}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="openai-compat">OpenAI compatible</SelectItem>
                <SelectItem value="gemini">Gemini</SelectItem>
              </SelectContent>
            </Select>
          </FormField>
          <FormField label="推荐模型">
            <Input defaultValue={source.recommendedModel} />
          </FormField>
          <FormField label="尺寸">
            <Input defaultValue={source.params.size} />
          </FormField>
          <FormField label="数量">
            <Input defaultValue={source.params.n ?? 1} type="number" />
          </FormField>
        </div>
        <FormField label="标签">
          <Input defaultValue={source.tags.join(', ')} />
        </FormField>
        <div>
          <p className="mb-2 text-sm font-medium">参考图</p>
          <div className="flex gap-3">
            {source.referenceImages.map((image) => (
              <div key={image.url} className="w-24">
                <img
                  src={image.url}
                  alt=""
                  className="aspect-square w-full rounded-lg object-cover"
                />
                <span className="mt-1 block truncate text-xs text-muted-foreground">
                  {image.name}
                </span>
              </div>
            ))}
            <button
              type="button"
              className="flex aspect-square w-24 flex-col items-center justify-center rounded-lg border border-dashed text-muted-foreground hover:bg-muted"
            >
              <ImagePlus className="size-5" />
              <span className="mt-1 text-xs">添加</span>
            </button>
          </div>
        </div>
      </TabsContent>
      <TabsContent value="preview">
        <SitePreview item={preview} />
      </TabsContent>
      <TabsContent value="history">
        <div className="space-y-3">
          {AUDITS.filter((audit) => audit.action.includes('灵感')).map((audit) => (
            <div key={audit.id} className="flex gap-3 rounded-lg border p-3 text-sm">
              <Clock3 className="size-4 text-muted-foreground" />
              <div>
                <strong>{audit.action}</strong>
                <p className="text-xs text-muted-foreground">
                  {audit.operator} · {audit.at}
                </p>
              </div>
            </div>
          ))}
          <div className="rounded-lg border border-dashed p-5 text-center text-sm text-muted-foreground">
            每次发布保存 manifest 版本与内容哈希
          </div>
        </div>
      </TabsContent>
      <div className="sticky bottom-0 flex justify-end gap-2 border-t bg-background/95 py-3 backdrop-blur">
        <Button variant="outline" onClick={() => setStatus('draft')}>
          存为草稿
        </Button>
        <Button variant="outline" onClick={() => setStatus('archived')}>
          下架
        </Button>
        <Button
          onClick={() => setStatus('published')}
          className="bg-brand text-brand-foreground hover:bg-brand-hover"
        >
          发布到主站
        </Button>
      </div>
    </Tabs>
  )
}

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  )
}

export function SitePreview({ item }: { item: Inspiration }) {
  return (
    <div className="rounded-2xl bg-brand-ink p-5 text-white">
      <div className="mb-4 flex items-center gap-2 text-xs text-white/60">
        <Eye className="size-4" />
        主站 /explore 预览
      </div>
      <div className="mx-auto max-w-sm overflow-hidden rounded-2xl bg-white text-brand-foreground shadow-2xl">
        <img src={item.thumbnailUrl} alt="" className="aspect-[4/3] w-full object-cover" />
        <div className="p-4">
          <div className="flex items-center gap-2">
            <Badge className="bg-brand text-brand-foreground">{KIND_LABEL[item.kind]}</Badge>
            {item.featured && <Star className="size-4 fill-amber-400 text-amber-400" />}
          </div>
          <h3 className="mt-3 text-lg font-semibold">{item.title}</h3>
          <p className="mt-1 line-clamp-2 text-sm text-zinc-500">
            {item.description || item.prompt}
          </p>
          {item.skill && (
            <code className="mt-3 block rounded bg-zinc-100 p-2 text-xs">/{item.skill}</code>
          )}
          <Button className="mt-4 w-full bg-brand text-brand-foreground hover:bg-brand-hover">
            <Sparkles className="mr-2 size-4" />
            玩同款
          </Button>
        </div>
      </div>
    </div>
  )
}

export function SkillsContent() {
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
        <strong>技能正文只读</strong>
        <p className="mt-1 text-muted-foreground">
          技能来自 BFF 镜像里的 SKILL.md；这里能查看和挂到灵感条目，改正文需要发新版镜像。
        </p>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {SKILLS.map((skill) => (
          <Card key={skill.name}>
            <CardContent className="flex items-start gap-3 p-4">
              <div className="rounded-lg bg-brand/20 p-2 text-emerald-700 dark:text-emerald-300">
                <Layers3 className="size-5" />
              </div>
              <div className="min-w-0 flex-1">
                <strong>{skill.title}</strong>
                <code className="ml-2 text-xs text-muted-foreground">/{skill.name}</code>
                <p className="mt-1 text-sm text-muted-foreground">{skill.summary}</p>
                <div className="mt-3 flex gap-2">
                  <Badge variant="outline">{skill.mode}</Badge>
                  <Badge variant="secondary">关联 {skill.linkedInspirations} 条</Badge>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}

export function CategoriesContent() {
  return (
    <div className="max-w-xl overflow-hidden rounded-xl border bg-card">
      {CATEGORIES.map((category, index) => (
        <div key={category} className="flex items-center gap-3 border-b p-3 last:border-0">
          <GripVertical className="size-4 text-muted-foreground" />
          <span className="w-6 text-xs text-muted-foreground">{index + 1}</span>
          <Input defaultValue={category} className="h-8" />
          <Badge variant="secondary">
            {INSPIRATIONS.filter((item) => item.category === category).length}
          </Badge>
        </div>
      ))}
    </div>
  )
}

export function BillingContent() {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Badge className="bg-violet-500/15 text-violet-700 dark:text-violet-300">私有树</Badge>
        <span className="text-sm text-muted-foreground">免费部署不显示本模块</span>
      </div>
      {PENDING_PAYMENTS.map((payment) => (
        <Card key={payment.id}>
          <CardContent className="flex flex-wrap items-center gap-4 p-4">
            <div className="rounded-full bg-violet-500/10 p-2 text-violet-600">
              <Circle className="size-5" />
            </div>
            <div className="min-w-0 flex-1">
              <strong>
                {payment.kind} · {formatCents(payment.amountCents)}
              </strong>
              <p className="text-xs text-muted-foreground">
                {payment.email} · {payment.createdAt}
              </p>
            </div>
            <Button>确认收款</Button>
          </CardContent>
        </Card>
      ))}
      <Button variant="outline">打开计费设置</Button>
    </div>
  )
}

export function AuditContent() {
  return (
    <div className="max-w-3xl overflow-hidden rounded-xl border bg-card">
      {AUDITS.map((audit) => (
        <div
          key={audit.id}
          className="grid grid-cols-[80px_1fr] gap-3 border-b p-4 last:border-0 sm:grid-cols-[100px_140px_1fr]"
        >
          <span className="text-xs text-muted-foreground">{audit.at}</span>
          <span className="hidden text-sm sm:block">{audit.operator}</span>
          <span className="text-sm">
            <strong>{audit.action}</strong>
            <span className="ml-2 text-muted-foreground">{audit.target}</span>
          </span>
        </div>
      ))}
    </div>
  )
}

export function EmptyDetail({ label = '从左边选择一项查看详情' }: { label?: string }) {
  return (
    <div className="flex min-h-[360px] flex-col items-center justify-center text-center text-muted-foreground">
      <Circle className="mb-3 size-8 opacity-30" />
      <p className="text-sm">{label}</p>
    </div>
  )
}
