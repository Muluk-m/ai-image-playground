import type { AgentProfileKey, ManagedModel, ManagedModelsView } from '@image-playground/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Search, SlidersHorizontal } from 'lucide-react'
import { useMemo, useState } from 'react'
import { DangerConfirmDialog } from '@/components/DangerConfirmDialog'
import { FuzzyTime } from '@/components/FuzzyTime'
import { Kpi } from '@/components/Kpi'
import { EmptyState } from '@/components/Page'
import { SegmentedControl } from '@/components/SegmentedControl'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { apiClient } from '@/lib/api-client'
import { PrivateAdminModelPricing, usePrivateAdminOverlayEnabled } from '@/lib/private-overlay'
import { cn } from '@/lib/utils'
import { type ModelState, modelState, sortModels } from './model-state'

export const modelsQueryKey = ['models']

export type ModelFilterKind = 'all' | 'chat' | 'image' | 'video' | 'paused'

const STATE_LABELS: Record<ModelState, string> = {
  active: '上架',
  paused: '自动暂停',
  inactive: '已下架',
}

const STATE_DOTS: Record<ModelState, string> = {
  active: 'bg-success',
  paused: 'bg-warning',
  inactive: 'bg-muted-foreground/40',
}

const KIND_LABELS: Record<ManagedModel['kind'], string> = {
  chat: '对话',
  image: '图片',
  video: '视频',
}

const PROFILE_LABELS: Record<AgentProfileKey, string> = {
  default: '默认',
  fast: '快速',
  medium: '普通',
  deep: '深度',
}

const CAPABILITY_LABELS: Record<string, string> = {
  vision: '视觉输入',
  generate: '生成',
  edit: '改图',
  mask: '局部遮罩',
  size: '多尺寸',
  quality: '画质档位',
  n: '多张并发',
  moderation: '内容审核',
  duration: '时长控制',
  aspect_ratio: '画幅比例',
  resolution: '分辨率',
  first_frame: '首帧参考',
  last_frame: '尾帧参考',
  reference_images: '多参考图',
  'openai-completions': 'Chat Completions',
  'openai-responses': 'Responses API',
  'anthropic-messages': 'Anthropic Messages',
}

function formatTokensCompact(tokens?: number): string | null {
  if (!tokens || tokens <= 0) return null
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`
  return String(tokens)
}

function ModelStatus({ model }: { model: ManagedModel }) {
  const state = modelState(model)
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2 text-sm">
        <span className={cn('size-2 shrink-0 rounded-full', STATE_DOTS[state])} aria-hidden />
        <span>{STATE_LABELS[state]}</span>
      </div>
      {state === 'paused' && model.paused_at ? (
        <div className="mt-0.5 text-xs text-muted-foreground">
          上游无可用账号 · <FuzzyTime ts={model.paused_at} />
        </div>
      ) : null}
    </div>
  )
}

function ModelSpecSummary({ model }: { model: ManagedModel }) {
  if (model.kind === 'chat') {
    const ctx = formatTokensCompact(model.context_window)
    const out = formatTokensCompact(model.max_tokens)
    const tokenSpec = [ctx ? `${ctx} 上下文` : null, out ? `${out} 输出` : null]
      .filter(Boolean)
      .join(' · ')
    return (
      <div className="space-y-1">
        {tokenSpec ? <div className="font-mono text-xs text-foreground">{tokenSpec}</div> : null}
        {model.agent_profiles?.length ? (
          <div className="flex flex-wrap gap-1">
            {model.agent_profiles.map((profile) => (
              <Badge key={profile} variant="secondary" className="px-1.5 py-0 text-[11px]">
                {PROFILE_LABELS[profile]}档
              </Badge>
            ))}
          </div>
        ) : (
          <div className="text-xs text-muted-foreground">未绑定思考档位</div>
        )}
      </div>
    )
  }

  const meta = [
    model.max_concurrency !== undefined ? `并发 ≤${model.max_concurrency}` : null,
    model.eta_seconds !== undefined ? `~${model.eta_seconds}s` : null,
  ]
    .filter(Boolean)
    .join(' · ')

  const caps = (model.capabilities ?? [])
    .slice(0, 4)
    .map((cap) => CAPABILITY_LABELS[cap] ?? cap)
    .join(' · ')

  return (
    <div className="space-y-0.5">
      {caps ? <div className="truncate text-xs text-foreground">{caps}</div> : null}
      {meta ? <div className="font-mono text-xs text-muted-foreground">{meta}</div> : null}
    </div>
  )
}

let availabilityMutationSeq = 0

function useModelAvailabilityToggle(model: ManagedModel) {
  const client = useQueryClient()
  const [pendingActive, setPendingActive] = useState<boolean | null>(null)
  const mutation = useMutation({
    mutationFn: async ({ active, reason }: { active: boolean; reason: string }) => {
      const seq = ++availabilityMutationSeq
      const data = await apiClient.put<ManagedModelsView>(
        `/api/models/${encodeURIComponent(model.id)}`,
        { active, reason },
      )
      return { seq, data }
    },
    onSuccess: ({ seq, data }) => {
      if (seq === availabilityMutationSeq) {
        client.setQueryData(modelsQueryKey, data)
      } else {
        // 并发快速切换多个模型时，丢弃旧快照并重新拉取最新目录，避免先发后到覆盖新状态。
        void client.invalidateQueries({ queryKey: modelsQueryKey })
      }
      setPendingActive(null)
    },
  })
  return {
    pendingActive,
    setPendingActive,
    mutation,
  }
}

function availabilityImpactText(model: ManagedModel, nextActive: boolean): string {
  if (model.kind === 'chat') {
    if (nextActive) {
      return `${model.label} 会恢复允许服务端对话调用。已在途请求不受影响。`
    }
    if (model.agent_profiles?.length) {
      const profiles = model.agent_profiles.map((key) => `${PROFILE_LABELS[key]}档`).join('、')
      return `${model.label} 当前正被 Agent 路由（${profiles}）引用；下架后服务端会直接拦截对应档位的新对话轮并返回不可用错误。若需平滑切换，请先在「Agent 路由与渠道」改绑模型再下架。`
    }
    return `${model.label} 下架后服务端会拒绝该对话模型的新调用；已在途请求不受影响。`
  }
  return nextActive
    ? `${model.label} 会重新出现在创作页模型选择器里。进行中的任务仍按原模型走完。`
    : `${model.label} 会从创作页模型选择器里消失。进行中的任务仍按原模型走完，新的生成不再使用它。`
}

function AvailabilityConfirm({
  model,
  pendingActive,
  setPendingActive,
  mutation,
}: {
  model: ManagedModel
  pendingActive: boolean | null
  setPendingActive: (value: boolean | null) => void
  mutation: ReturnType<typeof useModelAvailabilityToggle>['mutation']
}) {
  const nextActive = pendingActive ?? model.active
  return (
    <DangerConfirmDialog
      open={pendingActive !== null}
      onOpenChange={(open) => {
        if (!open) setPendingActive(null)
      }}
      title={`${nextActive ? '上架' : '下架'}模型 ${model.label}?`}
      impact={availabilityImpactText(model, nextActive)}
      versionNote="会写入审计日志。如果期间有人改过配置，刷新后再确认。"
      confirmLabel={nextActive ? '确认上架' : '确认下架'}
      destructive={!nextActive}
      pending={mutation.isPending}
      onConfirm={(reason) => {
        if (pendingActive === null) return
        mutation.mutate({ active: pendingActive, reason })
      }}
    />
  )
}

function ModelTableRow({
  model,
  billingEnabled,
  onInspect,
}: {
  model: ManagedModel
  billingEnabled: boolean
  onInspect: (modelId: string) => void
}) {
  const { pendingActive, setPendingActive, mutation } = useModelAvailabilityToggle(model)
  const paused = modelState(model) === 'paused'

  return (
    <TableRow>
      <TableCell className="min-w-[200px] align-top">
        <div className="font-medium text-foreground">{model.label}</div>
        <div className="mt-0.5 font-mono text-xs text-muted-foreground">{model.id}</div>
      </TableCell>
      <TableCell className="min-w-[160px] align-top">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline" className="px-2 py-0 text-xs font-medium">
            {KIND_LABELS[model.kind]}
          </Badge>
          {model.source_label ? (
            <span className="text-xs font-medium text-foreground">{model.source_label}</span>
          ) : null}
        </div>
        {model.source_id ? (
          <div className="mt-1 flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
            <span>{model.source_id}</span>
            {model.secret_configured === false ? (
              <span className="font-sans text-warning">· 密钥未配</span>
            ) : null}
          </div>
        ) : null}
      </TableCell>
      <TableCell className="min-w-[180px] align-top">
        <ModelSpecSummary model={model} />
      </TableCell>
      <TableCell className="w-[140px] align-top">
        <ModelStatus model={model} />
      </TableCell>
      {billingEnabled ? (
        <TableCell className="min-w-[240px] align-top">
          <PrivateAdminModelPricing model={model.id} kind={model.kind} />
        </TableCell>
      ) : null}
      <TableCell className="w-[148px] align-top">
        <div className="flex items-center justify-end gap-2">
          {paused ? (
            <Button
              size="sm"
              variant="outline"
              disabled={mutation.isPending}
              onClick={() => setPendingActive(true)}
            >
              恢复上架
            </Button>
          ) : (
            <Switch
              aria-label={`${model.label} 上架`}
              checked={model.active}
              disabled={mutation.isPending}
              onCheckedChange={(checked) => setPendingActive(checked)}
            />
          )}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => onInspect(model.id)}
            aria-label={`检视 ${model.label}`}
          >
            <SlidersHorizontal className="size-3.5" />
            详情
          </Button>
        </div>
        {mutation.isError ? (
          <div role="alert" className="mt-1 text-right text-xs text-danger">
            保存失败
          </div>
        ) : null}
        <AvailabilityConfirm
          model={model}
          pendingActive={pendingActive}
          setPendingActive={setPendingActive}
          mutation={mutation}
        />
      </TableCell>
    </TableRow>
  )
}

function ModelInspectorSheet({
  model,
  open,
  billingEnabled,
  onOpenChange,
}: {
  model: ManagedModel | null
  open: boolean
  billingEnabled: boolean
  onOpenChange: (open: boolean) => void
}) {
  if (!model) return null
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-[576px]">
        <SheetHeader className="border-b px-6 py-4 text-left">
          <div className="flex flex-wrap items-center gap-2 pr-6">
            <Badge variant="outline">{KIND_LABELS[model.kind]}</Badge>
            <ModelStatus model={model} />
          </div>
          <SheetTitle className="mt-1 text-lg">{model.label}</SheetTitle>
          <SheetDescription className="font-mono text-xs">{model.id}</SheetDescription>
        </SheetHeader>
        <div className="flex-1 space-y-5 overflow-y-auto p-6">
          <section className="space-y-3 rounded-xl border p-4">
            <h3 className="text-sm font-semibold">上游归属与密钥状态</h3>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-xs text-muted-foreground">上游来源</dt>
                <dd className="mt-0.5 font-medium">
                  {model.source_label ?? '—'}
                  {model.source_id ? (
                    <span className="ml-1.5 font-mono text-xs text-muted-foreground">
                      ({model.source_id})
                    </span>
                  ) : null}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">密钥环境变量</dt>
                <dd className="mt-0.5 font-mono text-xs">{model.secret_ref || '网关默认凭证'}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">运行时凭证</dt>
                <dd className="mt-0.5 flex items-center gap-2 text-sm">
                  <span
                    className={cn(
                      'size-2 rounded-full',
                      model.secret_configured === false ? 'bg-warning' : 'bg-success',
                    )}
                    aria-hidden
                  />
                  {model.secret_configured === false ? '未配置' : '已就绪'}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">运行限额 / 耗时</dt>
                <dd className="mt-0.5 font-mono text-xs">
                  {[
                    model.context_window
                      ? `${formatTokensCompact(model.context_window)} ctx`
                      : null,
                    model.max_tokens ? `${formatTokensCompact(model.max_tokens)} out` : null,
                    model.max_concurrency !== undefined ? `并发 ≤${model.max_concurrency}` : null,
                    model.eta_seconds !== undefined ? `预计 ~${model.eta_seconds}s` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ') || '默认配额'}
                </dd>
              </div>
            </dl>
          </section>

          <section className="space-y-3 rounded-xl border p-4">
            <h3 className="text-sm font-semibold">声明能力与路由引用</h3>
            {model.capabilities?.length ? (
              <div className="flex flex-wrap gap-1.5">
                {model.capabilities.map((cap) => (
                  <Badge key={cap} variant="secondary" className="font-normal">
                    {CAPABILITY_LABELS[cap] ?? cap}
                  </Badge>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">未声明特定能力标签</p>
            )}
            {model.kind === 'chat' ? (
              <div className="border-t pt-3">
                <p className="text-xs text-muted-foreground">绑定的 Agent 思考档位</p>
                {model.agent_profiles?.length ? (
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {model.agent_profiles.map((key) => (
                      <Badge key={key} variant="outline">
                        {PROFILE_LABELS[key]}档
                      </Badge>
                    ))}
                  </div>
                ) : (
                  <p className="mt-1 text-xs text-muted-foreground">
                    当前未被任何产品档位引用，可在「Agent 路由与渠道」页签中绑定。
                  </p>
                )}
              </div>
            ) : null}
          </section>

          {billingEnabled ? (
            <section className="space-y-3 rounded-xl border p-4">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">积分结算单价</h3>
                <Badge variant="private">商业计费</Badge>
              </div>
              <PrivateAdminModelPricing model={model.id} kind={model.kind} />
            </section>
          ) : null}

          <InspectorAvailabilitySection model={model} />
        </div>
      </SheetContent>
    </Sheet>
  )
}

function InspectorAvailabilitySection({ model }: { model: ManagedModel }) {
  const { pendingActive, setPendingActive, mutation } = useModelAvailabilityToggle(model)
  const state = modelState(model)
  const routedLabels = model.agent_profiles?.map((key) => `${PROFILE_LABELS[key]}档`).join('、')

  return (
    <section className="space-y-3 rounded-xl border p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">可用性与上下架</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {model.kind === 'chat'
              ? routedLabels
                ? `正被 ${routedLabels} 引用；下架会直接拦截该档位新对话轮，请先切路由再下架。`
                : '下架后服务端拒绝该对话模型的新调用，已在途请求不受影响。'
              : '下架后从创作页模型选择器隐藏，已在途生成任务仍按原模型走完。'}
          </p>
        </div>
        {state === 'paused' ? (
          <Button
            size="sm"
            variant="brand"
            disabled={mutation.isPending}
            onClick={() => setPendingActive(true)}
          >
            恢复上架
          </Button>
        ) : (
          <Button
            size="sm"
            variant={model.active ? 'destructive' : 'brand'}
            disabled={mutation.isPending}
            onClick={() => setPendingActive(!model.active)}
          >
            {model.active ? '手动下架' : '重新上架'}
          </Button>
        )}
      </div>
      {mutation.isError ? (
        <div role="alert" className="text-xs text-danger">
          保存失败
        </div>
      ) : null}
      <AvailabilityConfirm
        model={model}
        pendingActive={pendingActive}
        setPendingActive={setPendingActive}
        mutation={mutation}
      />
    </section>
  )
}

export function ModelCatalogWorkspace({
  models,
  kind = 'all',
  onKindChange,
}: {
  models: readonly ManagedModel[]
  kind?: ModelFilterKind
  onKindChange?: (next: ModelFilterKind) => void
}) {
  const billingEnabled = usePrivateAdminOverlayEnabled()
  const [search, setSearch] = useState('')
  const [localKind, setLocalKind] = useState<ModelFilterKind>(kind)
  const [inspectedId, setInspectedId] = useState<string | null>(null)

  const activeKind = onKindChange ? kind : localKind
  const setKind = (next: ModelFilterKind) => {
    if (onKindChange) onKindChange(next)
    else setLocalKind(next)
  }

  const stats = useMemo(() => {
    let active = 0
    let paused = 0
    let inactive = 0
    let chat = 0
    let image = 0
    let video = 0
    let routed = 0
    for (const model of models) {
      const state = modelState(model)
      if (state === 'active') active++
      else if (state === 'paused') paused++
      else inactive++
      if (model.kind === 'chat') {
        chat++
        if (model.agent_profiles?.length) routed++
      } else if (model.kind === 'image') image++
      else video++
    }
    return { active, paused, inactive, chat, image, video, routed }
  }, [models])

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return sortModels(
      models.filter((model) => {
        if (activeKind === 'paused' && modelState(model) !== 'paused') return false
        if (activeKind !== 'all' && activeKind !== 'paused' && model.kind !== activeKind) {
          return false
        }
        if (!needle) return true
        return `${model.label} ${model.id} ${model.source_label ?? ''} ${model.source_id ?? ''}`
          .toLowerCase()
          .includes(needle)
      }),
    )
  }, [activeKind, models, search])

  const inspectedModel = useMemo(
    () => models.find((item) => item.id === inspectedId) ?? null,
    [inspectedId, models],
  )

  const filterOptions: Array<{ value: ModelFilterKind; label: string }> = [
    { value: 'all', label: `全部 (${models.length})` },
    { value: 'chat', label: `对话 (${stats.chat})` },
    { value: 'image', label: `图片 (${stats.image})` },
    { value: 'video', label: `视频 (${stats.video})` },
    ...(stats.paused > 0 || activeKind === 'paused'
      ? [{ value: 'paused' as const, label: `自动暂停 (${stats.paused})` }]
      : []),
  ]

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi
          label="在架模型"
          value={`${stats.active} / ${models.length}`}
          note={`对话 ${stats.chat} · 图片 ${stats.image} · 视频 ${stats.video}`}
        />
        <Kpi
          label="异常自动暂停"
          value={stats.paused}
          tone={stats.paused > 0 ? 'danger' : 'default'}
          note={stats.paused > 0 ? '上游容量耗尽，补齐后可恢复' : '全部上游通道正常'}
        />
        <Kpi
          label="Agent 路由引用"
          value={stats.routed}
          note="已绑定到默认 / 快速 / 普通 / 深度档位"
        />
        <Kpi label="手动下架" value={stats.inactive} note="选模器隐藏，在途任务照旧完成" />
      </div>

      <Card>
        <CardContent className="space-y-4 p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <SegmentedControl
              label="模型模态筛选"
              options={filterOptions}
              value={activeKind}
              onChange={setKind}
            />
            <div className="relative w-full sm:max-w-xs">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="搜索模型名称、ID 或渠道…"
                aria-label="搜索模型"
                className="pl-9"
              />
            </div>
          </div>

          {filtered.length === 0 ? (
            <EmptyState label="没有匹配的模型记录" />
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>模型</TableHead>
                    <TableHead>模态 / 归属</TableHead>
                    <TableHead>规格与路由</TableHead>
                    <TableHead>状态</TableHead>
                    {billingEnabled ? <TableHead>积分计价</TableHead> : null}
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((model) => (
                    <ModelTableRow
                      key={model.id}
                      model={model}
                      billingEnabled={billingEnabled}
                      onInspect={setInspectedId}
                    />
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <ModelInspectorSheet
        model={inspectedModel}
        open={inspectedModel !== null}
        billingEnabled={billingEnabled}
        onOpenChange={(open) => {
          if (!open) setInspectedId(null)
        }}
      />
    </div>
  )
}

export function ModelTable({ title, models }: { title?: string; models: readonly ManagedModel[] }) {
  const billingEnabled = usePrivateAdminOverlayEnabled()
  const [inspectedId, setInspectedId] = useState<string | null>(null)
  if (!models.length) return null
  const inspectedModel = models.find((item) => item.id === inspectedId) ?? null
  return (
    <section className="space-y-2">
      {title ? <h3 className="text-sm font-medium text-muted-foreground">{title}</h3> : null}
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>模型</TableHead>
              <TableHead>模态 / 归属</TableHead>
              <TableHead>规格与路由</TableHead>
              <TableHead>状态</TableHead>
              {billingEnabled ? <TableHead>积分计价</TableHead> : null}
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortModels(models).map((model) => (
              <ModelTableRow
                key={model.id}
                model={model}
                billingEnabled={billingEnabled}
                onInspect={setInspectedId}
              />
            ))}
          </TableBody>
        </Table>
      </div>
      <ModelInspectorSheet
        model={inspectedModel}
        open={inspectedModel !== null}
        billingEnabled={billingEnabled}
        onOpenChange={(open) => {
          if (!open) setInspectedId(null)
        }}
      />
    </section>
  )
}
