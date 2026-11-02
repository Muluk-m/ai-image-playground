import { useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'
import { ErrorState, Page, PendingState } from '@/components/Page'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ApiError } from '@/lib/api-client'
import {
  clearOperatorSetting,
  operatorSettingsQueryKey,
  saveOperatorSetting,
  useOperatorSettings,
} from '@/lib/queries'
import type { OperatorSettingRow, OperatorSettingUnit } from '@/lib/types'

export const Route = createFileRoute('/_authed/operator-settings')({
  component: OperatorSettingsPage,
})

const DOMAIN_LABEL: Record<string, string> = {
  accounts: '账号',
  agent: '智能体',
  billing: '计费',
  generation: '生成',
  sync: '同步',
  quota: '配额',
  cli: '命令行',
}

export function formatSettingValue(value: boolean | number, unit?: OperatorSettingUnit): string {
  if (typeof value === 'boolean') return value ? '开启' : '关闭'
  if (unit === 'bytes') {
    if (value % 1024 ** 3 === 0) return `${value / 1024 ** 3} GB`
    if (value % 1024 ** 2 === 0) return `${value / 1024 ** 2} MB`
    return `${value} bytes`
  }
  if (unit === 'seconds' && value % 60 === 0) return `${value / 60} 分钟`
  return `${value}${unit === 'seconds' ? ' 秒' : unit === 'minutes' ? ' 分钟' : unit === 'tokens' ? ' tokens' : unit === 'count' ? ' 条' : unit === 'pixels' ? ' px' : unit === 'days' ? ' 天' : ''}`
}

/** Parse display units without rounding or accepting a unit from another quota. */
export function parseSettingInput(value: string, unit?: OperatorSettingUnit): number {
  const match = value
    .trim()
    .match(/^([0-9]+(?:\.[0-9]+)?)\s*(gb|mb|bytes|分钟|分|秒|s|m|天|d|px|像素|tokens|条)?$/i)
  if (!match) return Number.NaN
  const suffix = match[2]?.toLowerCase() ?? ''
  const multipliers: Record<string, number> = { '': 1 }
  if (unit === 'bytes') Object.assign(multipliers, { bytes: 1, mb: 1024 ** 2, gb: 1024 ** 3 })
  if (unit === 'seconds') Object.assign(multipliers, { s: 1, 秒: 1, m: 60, 分: 60, 分钟: 60 })
  if (unit === 'minutes') Object.assign(multipliers, { m: 1, 分: 1, 分钟: 1 })
  if (unit === 'days') Object.assign(multipliers, { d: 1, 天: 1 })
  if (unit === 'pixels') Object.assign(multipliers, { px: 1, 像素: 1 })
  if (unit === 'tokens') multipliers.tokens = 1
  if (unit === 'count') multipliers.条 = 1
  if (!Object.prototype.hasOwnProperty.call(multipliers, suffix)) return Number.NaN
  const result = Number(match[1]) * multipliers[suffix]!
  return Number.isSafeInteger(result) ? result : Number.NaN
}

function mutationError(cause: unknown): { message: string; stale: boolean } {
  if (!(cause instanceof ApiError)) {
    return { message: '操作失败，请稍后重试', stale: false }
  }
  const body = cause.body as {
    error?: string
    details?: { rule?: string; min?: number; max?: number; currentRevision?: number }
  } | null
  if (body?.error === 'stale_revision') {
    return { message: '配置已被其他操作更新，请刷新后重试。', stale: true }
  }
  if (body?.error === 'dependency_or_derived_rejected') {
    return { message: `保存会违反规则：${body.details?.rule ?? '依赖或派生校验'}`, stale: false }
  }
  if (body?.error === 'value_out_of_range') {
    const { min, max } = body.details ?? {}
    return { message: `数值超出允许范围（${min ?? '—'} 至 ${max ?? '—'}）`, stale: false }
  }
  if (body?.error === 'boot_time_only' || body?.error === 'read_only') {
    return { message: '该配置只能通过发布或只读查看，不能在线修改。', stale: false }
  }
  return { message: '操作失败，请稍后重试', stale: false }
}

export function OperatorSettingsPage() {
  const query = useOperatorSettings()
  const client = useQueryClient()
  const [search, setSearch] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [stale, setStale] = useState(false)
  const [pendingKey, setPendingKey] = useState<string | null>(null)
  const settings = query.data?.settings ?? []
  const grouped = useMemo(() => {
    const needle = search.trim().toLowerCase()
    const visible = settings.filter(
      (row) => !needle || `${row.key} ${row.name}`.toLowerCase().includes(needle),
    )
    return visible.reduce<Record<string, OperatorSettingRow[]>>((result, row) => {
      ;(result[row.domain] ??= []).push(row)
      return result
    }, {})
  }, [search, settings])

  async function save(row: OperatorSettingRow, value: boolean | number, reason: string) {
    // 写入共用全局版本号，同一时间只允许一个写请求。
    if (pendingKey !== null) return
    setError(null)
    setStale(false)
    setPendingKey(row.key)
    try {
      const snapshot = await saveOperatorSetting(row.key, {
        value,
        reason,
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

  async function clear(row: OperatorSettingRow, reason: string) {
    if (pendingKey !== null) return
    setError(null)
    setStale(false)
    setPendingKey(row.key)
    try {
      const snapshot = await clearOperatorSetting(row.key, {
        reason,
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

  return (
    <Page crumbs={[{ label: '能力与配额' }]} description="查看基线、运营覆盖与当前生效值">
      <div className="space-y-4">
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="搜索配置键或中文名"
          aria-label="搜索能力与配额"
        />
        {error ? (
          <div
            role="alert"
            className="flex items-center justify-between gap-3 rounded-md border border-destructive p-3 text-sm text-destructive"
          >
            <span>{error}</span>
            {stale ? (
              <Button size="sm" variant="outline" onClick={() => void refresh()}>
                刷新配置
              </Button>
            ) : null}
          </div>
        ) : null}
        {query.isPending ? <PendingState label="加载能力与配额" /> : null}
        {query.isError ? <ErrorState label="加载能力与配额失败" error={query.error} /> : null}
        {Object.entries(grouped).map(([domain, rows]) => (
          <section key={domain} aria-labelledby={`domain-${domain}`} className="space-y-2">
            <h2 id={`domain-${domain}`} className="text-base font-semibold">
              {DOMAIN_LABEL[domain] ?? domain}
            </h2>
            <div className="overflow-x-auto rounded-xl border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="p-3">名称 / 配置键</th>
                    <th className="p-3">基线</th>
                    <th className="p-3">覆盖</th>
                    <th className="p-3">生效</th>
                    <th className="p-3">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <SettingRowView
                      key={row.key}
                      row={row}
                      onSave={save}
                      onClear={clear}
                      pending={pendingKey !== null}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))}
      </div>
    </Page>
  )
}

function SettingRowView({
  row,
  onSave,
  onClear,
  pending,
}: {
  row: OperatorSettingRow
  onSave: (row: OperatorSettingRow, value: boolean | number, reason: string) => Promise<void>
  onClear: (row: OperatorSettingRow, reason: string) => Promise<void>
  pending: boolean
}) {
  const [value, setValue] = useState(String(row.override ?? row.effective))
  const [reason, setReason] = useState('')
  const [reasonOpen, setReasonOpen] = useState(false)
  const [impactOpen, setImpactOpen] = useState(false)
  const [action, setAction] = useState<'save' | 'clear' | null>(null)
  const readOnly = row.editability !== 'hot'
  const parsed = row.kind === 'capability' ? value === 'true' : parseSettingInput(value, row.unit)

  useEffect(() => {
    setValue(String(row.override ?? row.effective))
    setReason('')
    setReasonOpen(false)
    setImpactOpen(false)
    setAction(null)
    // 只跟随本行服务端值；其他行保存导致的全局版本号变化不应清掉这里的草稿。
  }, [row.override, row.effective])

  const submit = () => {
    const trimmed = reason.trim()
    setReasonOpen(false)
    if (row.risk) {
      setImpactOpen(true)
      return
    }
    if (action === 'save') void onSave(row, parsed, trimmed)
    if (action === 'clear') void onClear(row, trimmed)
  }
  const confirmImpact = () => {
    setImpactOpen(false)
    if (action === 'save') void onSave(row, parsed, reason.trim())
    if (action === 'clear') void onClear(row, reason.trim())
  }
  const openReason = (next: 'save' | 'clear') => {
    setAction(next)
    setReason('')
    setReasonOpen(true)
  }
  const impact = `这会改变「${row.name}」的生效值，可能影响线上流量或成本。`

  return (
    <tr className="border-b align-top last:border-0">
      <td className="p-3">
        <strong>{row.name}</strong>
        <code className="mt-1 block text-xs text-muted-foreground">{row.key}</code>
        <span className="mt-1 block text-xs text-muted-foreground">{row.description}</span>
        {row.baselineChanged ? (
          <span className="mt-1 block text-xs text-warning">基线已变（覆盖仍生效）</span>
        ) : null}
        {row.invalid ? (
          <span className="mt-1 block text-xs text-destructive">
            覆盖无效：{row.invalidReason ?? '已回退基线'}
          </span>
        ) : null}
      </td>
      <td className="p-3">{formatSettingValue(row.baseline, row.unit)}</td>
      <td className="p-3">
        {row.override === null ? '—' : formatSettingValue(row.override, row.unit)}
        {row.reason ? (
          <span className="mt-1 block text-xs text-muted-foreground">原因：{row.reason}</span>
        ) : null}
      </td>
      <td className="p-3 font-medium">{formatSettingValue(row.effective, row.unit)}</td>
      <td className="min-w-[220px] space-y-2 p-3">
        {readOnly ? (
          <span className="text-xs text-muted-foreground">只读（需发布修改）</span>
        ) : (
          <>
            {row.kind === 'capability' ? (
              <Select value={value} onValueChange={setValue} disabled={pending}>
                <SelectTrigger aria-label={`${row.name}值`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="true">开启</SelectItem>
                  <SelectItem value="false">关闭</SelectItem>
                </SelectContent>
              </Select>
            ) : (
              <Input
                aria-label={`${row.name}值`}
                value={value}
                onChange={(event) => setValue(event.target.value)}
                disabled={pending}
              />
            )}
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={pending || (typeof parsed === 'number' && !Number.isFinite(parsed))}
                onClick={() => openReason('save')}
              >
                保存
              </Button>
              {row.override !== null ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => openReason('clear')}
                >
                  清除覆盖
                </Button>
              ) : null}
            </div>
            <Dialog
              open={reasonOpen}
              onOpenChange={(open) => {
                if (!pending) setReasonOpen(open)
              }}
            >
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>{action === 'clear' ? '清除覆盖' : '保存覆盖'}</DialogTitle>
                  <DialogDescription>请填写本次配置变更的原因。</DialogDescription>
                </DialogHeader>
                <Input
                  autoFocus
                  aria-label="修改原因"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="修改原因（必填）"
                />
                <DialogFooter>
                  <Button variant="outline" onClick={() => setReasonOpen(false)} disabled={pending}>
                    取消
                  </Button>
                  <Button onClick={submit} disabled={pending || !reason.trim()}>
                    继续
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
            <Dialog
              open={impactOpen}
              onOpenChange={(open) => {
                if (!pending) setImpactOpen(open)
              }}
            >
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>确认成本与流量影响</DialogTitle>
                  <DialogDescription>{impact}</DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setImpactOpen(false)} disabled={pending}>
                    取消
                  </Button>
                  <Button onClick={confirmImpact} disabled={pending}>
                    {action === 'clear' ? '确认清除' : '确认保存'}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </>
        )}
      </td>
    </tr>
  )
}
