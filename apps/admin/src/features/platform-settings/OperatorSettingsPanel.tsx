import { useQueryClient } from '@tanstack/react-query'
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCheck,
  History,
  Layers,
  Link2,
  Lock,
  PencilLine,
  Pin,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldAlert,
  SlidersHorizontal,
  X,
  Zap,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { ErrorState, PendingState } from '@/components/Page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
  clearOperatorSetting,
  operatorSettingsQueryKey,
  saveOperatorSetting,
  useOperatorSettings,
} from '@/lib/queries'
import type { OperatorSettingRow } from '@/lib/types'
import { cn } from '@/lib/utils'
import {
  DOMAIN_ORDER,
  formatRangeHint,
  formatSettingValue,
  getDomainMeta,
  getSettingIcon,
  mutationError,
  parseSettingInput,
} from './settings-meta'

export { formatSettingValue, parseSettingInput }

type StatusFilter = 'all' | 'overridden' | 'hot' | 'locked' | 'risk'

interface PendingDialogState {
  row: OperatorSettingRow
  action: 'save' | 'clear'
  nextValue?: boolean | number
  step: 'reason' | 'impact'
}

export function OperatorSettingsPanel() {
  const query = useOperatorSettings()
  const client = useQueryClient()
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [domainFilter, setDomainFilter] = useState<string>('all')
  const [error, setError] = useState<string | null>(null)
  const [stale, setStale] = useState(false)
  const [pendingKey, setPendingKey] = useState<string | null>(null)
  const [dialog, setDialog] = useState<PendingDialogState | null>(null)
  const [reason, setReason] = useState('')

  const settings = query.data?.settings ?? []

  const stats = useMemo(() => {
    let overridden = 0
    let hot = 0
    let locked = 0
    let risk = 0
    for (const row of settings) {
      if (row.override !== null) overridden++
      if (row.editability === 'hot') hot++
      else locked++
      if (row.risk) risk++
    }
    return { total: settings.length, overridden, hot, locked, risk }
  }, [settings])

  const domainSummaries = useMemo(() => {
    const map = new Map<string, { total: number; overridden: number }>()
    for (const row of settings) {
      const current = map.get(row.domain) ?? { total: 0, overridden: 0 }
      current.total++
      if (row.override !== null) current.overridden++
      map.set(row.domain, current)
    }
    const orderIndex = (domain: string) => {
      const idx = DOMAIN_ORDER.indexOf(domain as (typeof DOMAIN_ORDER)[number])
      return idx === -1 ? DOMAIN_ORDER.length : idx
    }
    return [...map.entries()]
      .sort(([a], [b]) => {
        const diff = orderIndex(a) - orderIndex(b)
        return diff !== 0 ? diff : a.localeCompare(b)
      })
      .map(([domain, counts]) => ({ domain, ...counts }))
  }, [settings])

  const grouped = useMemo(() => {
    const needle = search.trim().toLowerCase()
    const visible = settings.filter((row) => {
      if (domainFilter !== 'all' && row.domain !== domainFilter) return false
      if (statusFilter === 'overridden' && row.override === null) return false
      if (statusFilter === 'hot' && row.editability !== 'hot') return false
      if (statusFilter === 'locked' && row.editability === 'hot') return false
      if (statusFilter === 'risk' && !row.risk) return false
      if (needle) {
        const haystack = `${row.key} ${row.name} ${row.description}`.toLowerCase()
        if (!haystack.includes(needle)) return false
      }
      return true
    })

    const map = new Map<string, OperatorSettingRow[]>()
    for (const row of visible) {
      const list = map.get(row.domain)
      if (list) list.push(row)
      else map.set(row.domain, [row])
    }
    const orderIndex = (domain: string) => {
      const idx = DOMAIN_ORDER.indexOf(domain as (typeof DOMAIN_ORDER)[number])
      return idx === -1 ? DOMAIN_ORDER.length : idx
    }
    return [...map.entries()].sort(([a], [b]) => {
      const diff = orderIndex(a) - orderIndex(b)
      return diff !== 0 ? diff : a.localeCompare(b)
    })
  }, [search, settings, statusFilter, domainFilter])

  async function executeSave(row: OperatorSettingRow, value: boolean | number, nextReason: string) {
    if (pendingKey !== null) return
    setError(null)
    setStale(false)
    setPendingKey(row.key)
    try {
      const snapshot = await saveOperatorSetting(row.key, {
        value,
        reason: nextReason,
        expectedRevision: row.revision,
      })
      await client.cancelQueries({ queryKey: operatorSettingsQueryKey })
      client.setQueryData(operatorSettingsQueryKey, snapshot)
    } catch (cause) {
      const result = mutationError(cause)
      setError(result.message)
      setStale(result.stale)
    } finally {
      setPendingKey(null)
    }
  }

  async function executeClear(row: OperatorSettingRow, nextReason: string) {
    if (pendingKey !== null) return
    setError(null)
    setStale(false)
    setPendingKey(row.key)
    try {
      const snapshot = await clearOperatorSetting(row.key, {
        reason: nextReason,
        expectedRevision: row.revision,
      })
      await client.cancelQueries({ queryKey: operatorSettingsQueryKey })
      client.setQueryData(operatorSettingsQueryKey, snapshot)
    } catch (cause) {
      const result = mutationError(cause)
      setError(result.message)
      setStale(result.stale)
    } finally {
      setPendingKey(null)
    }
  }

  async function refresh() {
    setError(null)
    setStale(false)
    await query.refetch()
  }

  function requestSave(row: OperatorSettingRow, nextValue: boolean | number) {
    if (pendingKey !== null) return
    setReason('')
    setDialog({ row, action: 'save', nextValue, step: 'reason' })
  }

  function requestClear(row: OperatorSettingRow) {
    if (pendingKey !== null) return
    setReason('')
    setDialog({ row, action: 'clear', step: 'reason' })
  }

  function submitReason() {
    if (!dialog || !reason.trim()) return
    if (dialog.row.risk) {
      setDialog({ ...dialog, step: 'impact' })
      return
    }
    const current = dialog
    const trimmed = reason.trim()
    setDialog(null)
    setReason('')
    if (current.action === 'save' && current.nextValue !== undefined) {
      void executeSave(current.row, current.nextValue, trimmed)
    } else if (current.action === 'clear') {
      void executeClear(current.row, trimmed)
    }
  }

  function confirmImpact() {
    if (!dialog) return
    const current = dialog
    const trimmed = reason.trim()
    setDialog(null)
    setReason('')
    if (current.action === 'save' && current.nextValue !== undefined) {
      void executeSave(current.row, current.nextValue, trimmed)
    } else if (current.action === 'clear') {
      void executeClear(current.row, trimmed)
    }
  }

  const hasActiveFilter = search.trim() !== '' || statusFilter !== 'all' || domainFilter !== 'all'
  const resetFilters = () => {
    setSearch('')
    setStatusFilter('all')
    setDomainFilter('all')
  }

  const statusTabs: {
    id: StatusFilter
    label: string
    count: number
    icon: typeof SlidersHorizontal
    accent?: string
  }[] = [
    { id: 'all', label: '全部', count: stats.total, icon: SlidersHorizontal },
    {
      id: 'overridden',
      label: '已覆盖',
      count: stats.overridden,
      icon: PencilLine,
      accent: stats.overridden > 0 ? 'text-info' : undefined,
    },
    { id: 'hot', label: '可热更新', count: stats.hot, icon: Zap },
    { id: 'locked', label: '仅发布修改', count: stats.locked, icon: Lock },
    ...(stats.risk > 0
      ? [
          {
            id: 'risk' as const,
            label: '高风险',
            count: stats.risk,
            icon: ShieldAlert,
            accent: 'text-warning',
          },
        ]
      : []),
  ]

  return (
    <div className="space-y-5">
      {/* Control Toolbar */}
      <div className="space-y-3 rounded-xl border bg-card p-3">
        <div className="flex flex-wrap items-center gap-2.5">
          {/* Search Input */}
          <div className="relative min-w-[220px] flex-1 sm:max-w-sm">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索名称、配置键或说明"
              aria-label="搜索能力与配额"
              className="h-9 pl-9 pr-8"
            />
            {search ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="清空搜索"
                className="absolute right-1.5 top-1/2 h-6 w-6 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                onClick={() => setSearch('')}
              >
                <X className="size-3.5" />
              </Button>
            ) : null}
          </div>

          {/* Quick State Filters */}
          <div
            role="group"
            aria-label="配置状态筛选"
            className="flex flex-wrap items-center gap-1 rounded-lg border bg-muted/35 p-1"
          >
            {statusTabs.map((tab) => {
              const Icon = tab.icon
              const active = statusFilter === tab.id
              return (
                <button
                  key={tab.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setStatusFilter(tab.id)}
                  className={cn(
                    'inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors',
                    active
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <Icon className={cn('size-3.5', !active && tab.accent)} />
                  <span>{tab.label}</span>
                  <span
                    className={cn(
                      'font-mono text-[11px] tabular-nums',
                      active ? 'text-muted-foreground' : (tab.accent ?? 'text-muted-foreground/80'),
                    )}
                  >
                    {tab.count}
                  </span>
                </button>
              )
            })}
          </div>

          {/* Revision + Refresh */}
          <div className="ml-auto flex items-center gap-2">
            {query.data ? (
              <span className="inline-flex h-8 items-center gap-1.5 rounded-md border bg-muted/30 px-2.5 font-mono text-xs tabular-nums text-muted-foreground">
                <History className="size-3.5" />
                rev #{query.data.revision}
              </span>
            ) : null}
            <Button
              type="button"
              size="icon-sm"
              variant="outline"
              aria-label="刷新配置"
              disabled={query.isFetching || pendingKey !== null}
              onClick={() => void refresh()}
            >
              <RefreshCw className={cn('size-3.5', query.isFetching && 'animate-spin')} />
            </Button>
          </div>
        </div>

        {/* Domain Filter Strip */}
        {domainSummaries.length > 1 ? (
          <div
            role="group"
            aria-label="领域筛选"
            className="flex flex-wrap items-center gap-1.5 border-t border-border/60 pt-2.5"
          >
            <button
              type="button"
              aria-pressed={domainFilter === 'all'}
              onClick={() => setDomainFilter('all')}
              className={cn(
                'inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors',
                domainFilter === 'all'
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-transparent bg-muted/40 text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <Layers className="size-3.5" />
              <span>全部领域</span>
              <span className="font-mono text-[11px] tabular-nums opacity-75">{stats.total}</span>
            </button>
            {domainSummaries.map(({ domain, total, overridden }) => {
              const meta = getDomainMeta(domain)
              const DomainIcon = meta.icon
              const active = domainFilter === domain
              return (
                <button
                  key={domain}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setDomainFilter(active ? 'all' : domain)}
                  className={cn(
                    'inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors',
                    active
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-transparent bg-muted/40 text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  <DomainIcon
                    className={cn('size-3.5', !active && meta.isPrivate && 'text-private')}
                  />
                  <span>{meta.label}</span>
                  <span className="font-mono text-[11px] tabular-nums opacity-75">{total}</span>
                  {overridden > 0 ? (
                    <span
                      aria-hidden="true"
                      className={cn(
                        'size-1.5 rounded-full',
                        active ? 'bg-primary-foreground' : 'bg-info',
                      )}
                    />
                  ) : null}
                </button>
              )
            })}
          </div>
        ) : null}
      </div>

      {/* Mutation Error Alert */}
      {error ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
        >
          <span className="flex items-center gap-2">
            <AlertCircle className="size-4 shrink-0" />
            <span>{error}</span>
          </span>
          {stale ? (
            <Button size="sm" variant="outline" onClick={() => void refresh()}>
              <RefreshCw className="size-3.5" />
              刷新配置
            </Button>
          ) : null}
        </div>
      ) : null}

      {query.isPending ? <PendingState label="加载能力与配额" /> : null}
      {query.isError ? <ErrorState label="加载能力与配额失败" error={query.error} /> : null}

      {/* Empty Filter Result */}
      {!query.isPending && !query.isError && grouped.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border bg-card px-6 py-12 text-center">
          <div className="flex size-10 items-center justify-center rounded-xl border bg-muted/40 text-muted-foreground">
            <Search className="size-5" />
          </div>
          <p className="text-sm text-muted-foreground">没有匹配的配置项</p>
          {hasActiveFilter ? (
            <Button type="button" size="sm" variant="outline" onClick={resetFilters}>
              重置筛选
            </Button>
          ) : null}
        </div>
      ) : null}

      {/* Domain Sections */}
      {grouped.map(([domain, rows]) => {
        const meta = getDomainMeta(domain)
        const DomainIcon = meta.icon
        const overriddenCount = rows.filter((r) => r.override !== null).length
        const hotCount = rows.filter((r) => r.editability === 'hot').length
        const lockedCount = rows.length - hotCount

        return (
          <section
            key={domain}
            aria-labelledby={`domain-${domain}`}
            className="overflow-hidden rounded-xl border bg-card"
          >
            <header className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/25 px-4 py-2.5">
              <div className="flex items-center gap-2.5">
                <div
                  className={cn(
                    'flex size-7 items-center justify-center rounded-lg border',
                    meta.isPrivate
                      ? 'border-private/30 bg-private/10 text-private'
                      : 'border-border/80 bg-background text-foreground',
                  )}
                >
                  <DomainIcon className="size-4" />
                </div>
                <h2 id={`domain-${domain}`} className="text-sm font-semibold text-foreground">
                  {meta.label}
                </h2>
                <span className="font-mono text-xs tabular-nums text-muted-foreground">
                  {rows.length} 项
                </span>
              </div>
              <div className="flex items-center gap-3 font-mono text-xs tabular-nums text-muted-foreground">
                {overriddenCount > 0 ? (
                  <span className="inline-flex items-center gap-1 text-info">
                    <PencilLine className="size-3" />
                    {overriddenCount} 已覆盖
                  </span>
                ) : null}
                {hotCount > 0 ? (
                  <span className="inline-flex items-center gap-1">
                    <Zap className="size-3" />
                    {hotCount} 热更新
                  </span>
                ) : null}
                {lockedCount > 0 ? (
                  <span className="inline-flex items-center gap-1">
                    <Lock className="size-3" />
                    {lockedCount} 锁定
                  </span>
                ) : null}
              </div>
            </header>

            <ul className="divide-y divide-border/60">
              {rows.map((row) => (
                <SettingRowView
                  key={row.key}
                  row={row}
                  pending={pendingKey !== null}
                  saving={pendingKey === row.key}
                  onRequestSave={requestSave}
                  onRequestClear={requestClear}
                />
              ))}
            </ul>
          </section>
        )
      })}

      {/* Reason Dialog (Step 1) */}
      <Dialog
        open={dialog?.step === 'reason'}
        onOpenChange={(open) => {
          if (!open && pendingKey === null) {
            setDialog(null)
            setReason('')
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {dialog?.action === 'clear' ? (
                <RotateCcw className="size-4 text-muted-foreground" />
              ) : (
                <SlidersHorizontal className="size-4 text-muted-foreground" />
              )}
              {dialog?.action === 'clear' ? '清除覆盖' : '保存覆盖'}
            </DialogTitle>
            <DialogDescription>请填写本次配置变更的原因，变更将写入操作审计。</DialogDescription>
          </DialogHeader>

          {dialog ? (
            <div className="space-y-2 rounded-lg border bg-muted/35 px-3 py-2.5 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium text-foreground">{dialog.row.name}</span>
                <code className="rounded bg-background px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                  {dialog.row.key}
                </code>
              </div>
              <div className="flex flex-wrap items-center gap-1.5 font-mono">
                {dialog.action === 'save' && dialog.nextValue === dialog.row.effective ? (
                  <strong className="text-foreground">
                    {dialog.row.baselineChanged
                      ? `保持覆盖值 ${formatSettingValue(dialog.nextValue, dialog.row.unit)}（同步新基线 ${formatSettingValue(dialog.row.baseline, dialog.row.unit)}）`
                      : `固定当前值 ${formatSettingValue(dialog.nextValue, dialog.row.unit)} 为覆盖`}
                  </strong>
                ) : (
                  <>
                    <span className="text-muted-foreground">
                      {formatSettingValue(
                        dialog.action === 'clear'
                          ? (dialog.row.override ?? dialog.row.effective)
                          : dialog.row.effective,
                        dialog.row.unit,
                      )}
                    </span>
                    <ArrowRight className="size-3 text-muted-foreground" />
                    <strong className="text-foreground">
                      {dialog.action === 'clear'
                        ? `${formatSettingValue(dialog.row.baseline, dialog.row.unit)}（恢复基线）`
                        : formatSettingValue(dialog.nextValue!, dialog.row.unit)}
                    </strong>
                  </>
                )}
              </div>
            </div>
          ) : null}

          <form
            onSubmit={(event) => {
              event.preventDefault()
              submitReason()
            }}
            className="space-y-4"
          >
            <Input
              autoFocus
              aria-label="修改原因"
              maxLength={1000}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="修改原因（必填）"
            />
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setDialog(null)
                  setReason('')
                }}
                disabled={pendingKey !== null}
              >
                取消
              </Button>
              <Button type="submit" disabled={pendingKey !== null || !reason.trim()}>
                继续
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* High-Risk Impact Confirmation Dialog (Step 2) */}
      <Dialog
        open={dialog?.step === 'impact'}
        onOpenChange={(open) => {
          if (!open && pendingKey === null) {
            setDialog(null)
            setReason('')
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldAlert className="size-4 text-warning" />
              确认成本与流量影响
            </DialogTitle>
            <DialogDescription>
              {dialog
                ? `这会改变「${dialog.row.name}」的生效值，可能影响线上流量或成本。`
                : '这可能影响线上流量或成本。'}
            </DialogDescription>
          </DialogHeader>
          {dialog ? (
            <div className="space-y-1.5 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5 text-xs">
              <div className="flex flex-wrap items-center gap-1.5 font-mono">
                <span className="text-muted-foreground">{dialog.row.key}</span>
                <span className="text-muted-foreground">·</span>
                <span className="text-muted-foreground">
                  {formatSettingValue(
                    dialog.action === 'clear'
                      ? (dialog.row.override ?? dialog.row.effective)
                      : dialog.row.effective,
                    dialog.row.unit,
                  )}
                </span>
                <ArrowRight className="size-3 text-muted-foreground" />
                <strong className="text-foreground">
                  {dialog.action === 'clear'
                    ? formatSettingValue(dialog.row.baseline, dialog.row.unit)
                    : formatSettingValue(dialog.nextValue!, dialog.row.unit)}
                </strong>
              </div>
              <p className="text-muted-foreground">原因：{reason.trim()}</p>
            </div>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setDialog(null)
                setReason('')
              }}
              disabled={pendingKey !== null}
            >
              取消
            </Button>
            <Button type="button" onClick={confirmImpact} disabled={pendingKey !== null}>
              {dialog?.action === 'clear' ? '确认清除' : '确认保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function SettingRowView({
  row,
  pending,
  saving,
  onRequestSave,
  onRequestClear,
}: {
  row: OperatorSettingRow
  pending: boolean
  saving: boolean
  onRequestSave: (row: OperatorSettingRow, nextValue: boolean | number) => void
  onRequestClear: (row: OperatorSettingRow) => void
}) {
  const baseQuotaValue = row.invalid ? row.effective : (row.override ?? row.effective)
  const initialQuotaText = row.kind === 'quota' ? formatSettingValue(baseQuotaValue, row.unit) : ''
  const [draft, setDraft] = useState(initialQuotaText)

  useEffect(() => {
    setDraft(row.kind === 'quota' ? formatSettingValue(baseQuotaValue, row.unit) : '')
  }, [row.kind, baseQuotaValue, row.unit])

  const readOnly = row.editability !== 'hot'
  const Icon = getSettingIcon(row)
  const effectiveBool = Boolean(row.effective)
  const rangeHint = formatRangeHint(row)

  const currentNumeric = row.kind === 'quota' ? Number(baseQuotaValue) : Number.NaN
  const parsedQuota = row.kind === 'quota' ? parseSettingInput(draft, row.unit) : Number.NaN
  const quotaInvalid = row.kind === 'quota' && !Number.isFinite(parsedQuota)
  const quotaOutOfRange =
    row.kind === 'quota' &&
    !quotaInvalid &&
    ((typeof row.min === 'number' && parsedQuota < row.min) ||
      (typeof row.max === 'number' && parsedQuota > row.max))
  const draftModified = row.kind === 'quota' && draft.trim() !== initialQuotaText.trim()
  const quotaDirty =
    row.kind === 'quota' && draftModified && (quotaInvalid || parsedQuota !== currentNumeric)

  const iconTileClass = row.invalid
    ? 'border-danger/30 bg-danger/10 text-danger'
    : row.override !== null
      ? 'border-info/30 bg-info/10 text-info'
      : readOnly
        ? 'border-border/60 bg-muted/35 text-muted-foreground'
        : row.kind === 'capability' && effectiveBool
          ? 'border-success/25 bg-success/10 text-success'
          : 'border-border/70 bg-muted/40 text-muted-foreground'

  return (
    <li
      data-setting-key={row.key}
      className={cn(
        'group flex flex-col gap-3 px-4 py-3.5 transition-colors hover:bg-muted/20 sm:flex-row sm:items-center sm:justify-between sm:gap-6',
        row.invalid && 'bg-danger/[0.04]',
        !row.invalid && row.override !== null && 'bg-info/[0.03]',
      )}
    >
      {/* Left: Icon + Identity + Description + Metadata */}
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <div
          className={cn(
            'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border',
            iconTileClass,
          )}
        >
          <Icon className="size-4" />
        </div>

        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm font-medium text-foreground">{row.name}</span>
            <code className="rounded bg-muted/70 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
              {row.key}
            </code>
            {row.override !== null ? (
              <Badge variant="info" className="gap-1 px-1.5 py-0 text-[11px] font-medium">
                <PencilLine className="size-3" />
                已覆盖
              </Badge>
            ) : null}
            {row.risk ? (
              <Badge variant="warning" className="gap-1 px-1.5 py-0 text-[11px] font-medium">
                <ShieldAlert className="size-3" />
                高风险
              </Badge>
            ) : null}
            {row.baselineChanged ? (
              <Badge variant="warning" className="gap-1 px-1.5 py-0 text-[11px] font-medium">
                <AlertTriangle className="size-3" />
                基线已变（覆盖仍生效）
              </Badge>
            ) : null}
            {row.invalid ? (
              <Badge variant="danger" className="gap-1 px-1.5 py-0 text-[11px] font-medium">
                <AlertCircle className="size-3" />
                覆盖无效
              </Badge>
            ) : null}
          </div>

          <p className="text-xs text-muted-foreground">{row.description}</p>

          {/* Contextual secondary metadata (only shown when meaningful) */}
          {row.override !== null ||
          row.invalid ||
          (row.dependencies && row.dependencies.length > 0) ||
          rangeHint ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-0.5 text-xs text-muted-foreground">
              {row.override !== null ? (
                <span className="inline-flex items-center gap-1 font-mono text-[11px]">
                  <span>基线 {formatSettingValue(row.baseline, row.unit)}</span>
                  <ArrowRight className="size-3" />
                  <span className="font-medium text-foreground">
                    覆盖 {formatSettingValue(row.override, row.unit)}
                  </span>
                </span>
              ) : null}
              {row.reason ? (
                <span className="truncate text-[11px]" title={row.reason}>
                  原因：{row.reason}
                </span>
              ) : null}
              {row.invalid ? (
                <span className="text-[11px] font-medium text-danger">
                  覆盖无效：{row.invalidReason ?? '已回退基线'}
                </span>
              ) : null}
              {row.dependencies && row.dependencies.length > 0 ? (
                <span className="inline-flex items-center gap-1 font-mono text-[11px]">
                  <Link2 className="size-3 shrink-0" />
                  依赖 {row.dependencies.join('、')}
                </span>
              ) : null}
              {rangeHint ? (
                <span className="font-mono text-[11px] tabular-nums">范围 {rangeHint}</span>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {/* Right: Quiet, Direct Control */}
      <div className="flex shrink-0 flex-col items-end gap-1 sm:min-w-[220px]">
        <div className="flex items-center justify-end gap-2">
          {saving ? (
            <RefreshCw aria-hidden="true" className="size-3.5 animate-spin text-muted-foreground" />
          ) : null}

          {readOnly ? (
            <>
              <span className="inline-flex items-center gap-1.5 font-mono text-xs font-medium text-foreground">
                {row.kind === 'capability' ? (
                  <span
                    aria-hidden="true"
                    className={cn(
                      'size-2 rounded-full',
                      effectiveBool ? 'bg-success' : 'bg-muted-foreground/40',
                    )}
                  />
                ) : null}
                <span>{formatSettingValue(row.effective, row.unit)}</span>
              </span>
              <span className="inline-flex items-center gap-1 rounded-md border border-border/70 bg-muted/40 px-2 py-1 text-xs text-muted-foreground">
                <Lock className="size-3" />
                {row.editability === 'boot-time' ? '仅发布修改' : '系统只读'}
              </span>
            </>
          ) : row.kind === 'capability' ? (
            <>
              {row.override === null ? (
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`固定${row.name}当前值为覆盖`}
                  aria-description="将当前基线值保存为显式覆盖，后续发布变更基线时不受影响"
                  className="text-muted-foreground/60 transition-opacity hover:text-foreground [@media(hover:hover)_and_(pointer:fine)]:opacity-0 [@media(hover:hover)_and_(pointer:fine)]:group-hover:opacity-100 [@media(hover:hover)_and_(pointer:fine)]:focus-visible:opacity-100"
                  disabled={pending}
                  onClick={() => onRequestSave(row, row.effective)}
                >
                  <Pin className="size-3.5" />
                </Button>
              ) : null}
              {row.baselineChanged && row.override !== null && !row.invalid ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-8 gap-1 px-2 text-xs text-warning hover:text-warning"
                  disabled={pending}
                  onClick={() => onRequestSave(row, row.override!)}
                >
                  <CheckCheck className="size-3.5" />
                  重新确认覆盖
                </Button>
              ) : null}
              {row.override !== null ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-8 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
                  disabled={pending}
                  onClick={() => onRequestClear(row)}
                >
                  <RotateCcw className="size-3.5" />
                  清除覆盖
                </Button>
              ) : null}
              <div className="flex items-center gap-2.5 pl-1">
                <span
                  className={cn(
                    'w-8 text-right text-xs font-medium',
                    effectiveBool ? 'text-success' : 'text-muted-foreground',
                  )}
                >
                  {effectiveBool ? '开启' : '关闭'}
                </span>
                <Switch
                  aria-label={row.name}
                  checked={effectiveBool}
                  disabled={pending}
                  className="data-[state=checked]:bg-success"
                  onCheckedChange={(checked) => onRequestSave(row, checked)}
                />
              </div>
            </>
          ) : (
            <>
              {!quotaDirty && row.override === null ? (
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`固定${row.name}当前值为覆盖`}
                  aria-description="将当前基线值保存为显式覆盖，后续发布变更基线时不受影响"
                  className="text-muted-foreground/60 transition-opacity hover:text-foreground [@media(hover:hover)_and_(pointer:fine)]:opacity-0 [@media(hover:hover)_and_(pointer:fine)]:group-hover:opacity-100 [@media(hover:hover)_and_(pointer:fine)]:focus-visible:opacity-100"
                  disabled={pending}
                  onClick={() => onRequestSave(row, row.effective)}
                >
                  <Pin className="size-3.5" />
                </Button>
              ) : null}
              {!quotaDirty && row.baselineChanged && row.override !== null && !row.invalid ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-8 gap-1 px-2 text-xs text-warning hover:text-warning"
                  disabled={pending}
                  onClick={() => onRequestSave(row, row.override!)}
                >
                  <CheckCheck className="size-3.5" />
                  重新确认覆盖
                </Button>
              ) : null}
              {row.override !== null && (row.invalid || !quotaDirty) ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-8 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
                  disabled={pending}
                  onClick={() => onRequestClear(row)}
                >
                  <RotateCcw className="size-3.5" />
                  清除覆盖
                </Button>
              ) : null}
              <Input
                aria-label={`${row.name}值`}
                aria-invalid={quotaDirty && (quotaInvalid || quotaOutOfRange)}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing || event.keyCode === 229) return
                  if (event.key === 'Enter' && quotaDirty && !quotaInvalid && !quotaOutOfRange) {
                    event.preventDefault()
                    onRequestSave(row, parsedQuota)
                  } else if (event.key === 'Escape' && quotaDirty) {
                    event.preventDefault()
                    setDraft(initialQuotaText)
                  }
                }}
                disabled={pending}
                className={cn(
                  'h-8 w-36 text-right font-mono text-xs tabular-nums',
                  quotaDirty && (quotaInvalid || quotaOutOfRange) && 'border-destructive',
                )}
              />
              {quotaDirty ? (
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    size="sm"
                    className="h-8 gap-1 px-2.5 text-xs"
                    disabled={pending || quotaInvalid || quotaOutOfRange}
                    onClick={() => onRequestSave(row, parsedQuota)}
                  >
                    <Check className="size-3.5" />
                    保存
                  </Button>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`撤销${row.name}修改`}
                    className="text-muted-foreground hover:text-foreground"
                    disabled={pending}
                    onClick={() => setDraft(initialQuotaText)}
                  >
                    <X className="size-3.5" />
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </div>

        {!readOnly && row.kind === 'quota' && quotaDirty && (quotaInvalid || quotaOutOfRange) ? (
          <p className="text-[11px] text-destructive">
            {quotaInvalid
              ? '数值或单位无效'
              : `超出允许范围（${rangeHint ?? `${row.min ?? '—'} 至 ${row.max ?? '—'}`}）`}
          </p>
        ) : null}
      </div>
    </li>
  )
}
