import type {
  GptDirectAdminView,
  GptDirectKeyStatus,
  GptDirectKeyView,
} from '@image-playground/shared'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, Plus } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { FuzzyTime } from '@/components/FuzzyTime'
import { Kpi } from '@/components/Kpi'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { modelsQueryKey } from '@/features/models/ModelTable'
import { ApiError } from '@/lib/api-client'
import {
  createGptDirectKey,
  deleteGptDirectKey,
  gptDirectQueryKey,
  reorderGptDirectKeys,
  restoreGptDirectKey,
  updateGptDirectKey,
} from '@/lib/queries'
import { cn } from '@/lib/utils'

const STATUS_LABEL: Record<GptDirectKeyStatus, string> = {
  available: '可用',
  cooldown: '429 冷却',
  disabled: '额度耗尽或失效',
  budget: '预算用满',
  off: '已停用',
}

function usd(micro: number): string {
  return `$${(micro / 1_000_000).toFixed(2)}`
}

function failureMessage(cause: unknown): string {
  if (!(cause instanceof ApiError)) return '操作失败'
  const body = cause.body as { error?: string; message?: string } | null
  if (body?.error === 'master_key_missing' || body?.error === 'master_key_invalid') {
    return body.message || '主密钥未配置，不能写入'
  }
  if (body?.error === 'invalid_secret') return '密钥无效'
  if (body?.error === 'invalid_budget') return body.message || '月预算无效'
  if (body?.error === 'duplicate_key') return '这把密钥已经在列表里'
  if (body?.error === 'fingerprint_secret_missing') return body.message || '未配置指纹密钥'
  if (body?.error === 'stale_revision') return '顺序已变化'
  return '操作失败'
}

export function GptDirectPanel({
  view,
  rangeControl,
}: {
  view: GptDirectAdminView
  rangeControl?: ReactNode
}) {
  const client = useQueryClient()
  const [draftKey, setDraftKey] = useState('')
  const [draftBudget, setDraftBudget] = useState('200')
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function run(id: string, task: () => Promise<GptDirectAdminView>) {
    if (pending) return
    setPending(id)
    setError(null)
    try {
      await task()
      setDraftKey('')
      await Promise.all([
        client.invalidateQueries({ queryKey: gptDirectQueryKey }),
        client.invalidateQueries({ queryKey: modelsQueryKey }),
      ])
    } catch (cause) {
      setError(failureMessage(cause))
    } finally {
      setPending(null)
    }
  }

  const adminIds = view.keys.flatMap((key) => (key.id ? [key.id] : []))
  const budgetPercent =
    view.total_budget_micro_usd > 0
      ? Math.min(100, Math.round((view.total_spent_micro_usd / view.total_budget_micro_usd) * 100))
      : 0

  const windowEstimatedTotal = view.daily.reduce((sum, item) => sum + item.cost_micro_usd, 0)
  const windowOfficialTotal = view.official?.ok
    ? view.official.days.reduce((sum, item) => sum + item.cost_micro_usd, 0)
    : null

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Kpi
          label="直连本月花费"
          value={usd(view.total_spent_micro_usd)}
          note={`已用预算 ${budgetPercent}%`}
        />
        <Kpi
          label="直连月度预算"
          value={usd(view.total_budget_micro_usd)}
          note="80% 告警 · 满额回退 sub2api"
        />
        <Kpi
          label="直连可用余量"
          value={usd(view.remaining_micro_usd)}
          tone={view.remaining_micro_usd === 0 ? 'danger' : 'default'}
          note={view.source === 'admin' ? '后台密钥池' : '环境变量'}
        />
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="text-base">OpenAI GPT Image 直连密钥池</CardTitle>
            <div className="flex items-center gap-3 font-mono text-xs text-muted-foreground">
              {view.total_budget_micro_usd > 0 ? (
                <span className="tabular-nums">
                  {usd(view.total_spent_micro_usd)} / {usd(view.total_budget_micro_usd)} (
                  {budgetPercent}%)
                </span>
              ) : null}
              <span>HMAC: {view.fingerprint_mac_source}</span>
            </div>
          </div>
          {view.total_budget_micro_usd > 0 ? (
            <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={cn(
                  'h-full transition-all',
                  budgetPercent >= 100
                    ? 'bg-danger'
                    : budgetPercent >= 80
                      ? 'bg-warning'
                      : 'bg-success',
                )}
                style={{ width: `${budgetPercent}%` }}
              />
            </div>
          ) : null}
        </CardHeader>
        <CardContent className="space-y-4">
          {view.fingerprint_mac_source === 'unset' ? (
            <p className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
              未配置指纹密钥，直连不可用
            </p>
          ) : null}
          {view.disabled_reason ? (
            <p className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
              {view.disabled_reason}
            </p>
          ) : null}
          {view.source === 'env' ? (
            <p className="text-xs text-muted-foreground">
              当前读取部署环境变量；添加后台密钥后将只走后台密钥池。
            </p>
          ) : null}

          <form
            className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 p-3"
            onSubmit={(event) => {
              event.preventDefault()
              const budgetUsd = Number(draftBudget)
              if (!draftKey.trim() || !Number.isInteger(budgetUsd) || budgetUsd <= 0) return
              void run('create', () => createGptDirectKey({ apiKey: draftKey.trim(), budgetUsd }))
            }}
          >
            <Input
              type="password"
              name="gpt-direct-key"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              value={draftKey}
              placeholder="输入新 OpenAI API Key…"
              aria-label="新密钥"
              className="h-8 max-w-xs flex-1 bg-background text-xs"
              onChange={(event) => setDraftKey(event.target.value)}
            />
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground">月预算 $</span>
              <Input
                type="number"
                name="gpt-direct-budget"
                min={1}
                step={1}
                value={draftBudget}
                aria-label="月预算"
                className="h-8 w-24 bg-background font-mono text-xs tabular-nums"
                onChange={(event) => setDraftBudget(event.target.value)}
              />
            </div>
            <Button
              type="submit"
              size="sm"
              variant="brand"
              disabled={!view.writable || !draftKey.trim() || pending !== null}
            >
              <Plus className="size-3.5" />
              {pending === 'create' ? '保存中' : '添加'}
            </Button>
          </form>

          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-24 pl-4">优先级</TableHead>
                  <TableHead>安全指纹</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead className="pr-6 text-right">本月消耗</TableHead>
                  <TableHead>月预算（$）</TableHead>
                  <TableHead>最近异常</TableHead>
                  <TableHead className="pr-4 text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {view.keys.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                      没有配置直连密钥
                    </TableCell>
                  </TableRow>
                ) : (
                  view.keys.map((key, index) => (
                    <KeyRow
                      key={key.fingerprint}
                      row={key}
                      pending={pending}
                      writable={view.writable}
                      first={index === 0}
                      last={index === view.keys.length - 1}
                      onMove={(direction) => {
                        if (!key.id) return
                        const ids = [...adminIds]
                        const from = ids.indexOf(key.id)
                        const to = from + direction
                        if (from < 0 || to < 0 || to >= ids.length) return
                        const [moved] = ids.splice(from, 1)
                        if (!moved) return
                        ids.splice(to, 0, moved)
                        void run(`move-${key.id}`, () => reorderGptDirectKeys(ids, view.revision))
                      }}
                      onToggle={() => {
                        if (!key.id) return
                        void run(`toggle-${key.id}`, () =>
                          updateGptDirectKey(key.id as string, { enabled: !key.enabled }),
                        )
                      }}
                      onBudget={(budgetUsd) => {
                        if (!key.id) return
                        void run(`budget-${key.id}`, () =>
                          updateGptDirectKey(key.id as string, { budgetUsd }),
                        )
                      }}
                      onDelete={() => {
                        if (!key.id) return
                        void run(`delete-${key.id}`, () => deleteGptDirectKey(key.id as string))
                      }}
                      onRestore={() => {
                        void run(`restore-${key.fingerprint}`, () =>
                          restoreGptDirectKey(key.fingerprint),
                        )
                      }}
                    />
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          {error ? (
            <p role="status" className="text-xs text-danger">
              {error}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <div className={cn('grid gap-4', view.official ? 'lg:grid-cols-2' : 'grid-cols-1')}>
        <Card>
          <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 space-y-0 pb-3">
            <div>
              <CardTitle className="text-base">平台按日估算消耗</CardTitle>
              <p className="mt-0.5 text-xs text-muted-foreground">
                窗口合计{' '}
                <span className="font-mono tabular-nums text-foreground">
                  {usd(windowEstimatedTotal)}
                </span>
              </p>
            </div>
            {rangeControl}
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4">日期（UTC+8）</TableHead>
                    <TableHead className="text-right">估算花费</TableHead>
                    <TableHead className="pr-4 text-right">出图张数</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {view.daily.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={3} className="py-6 text-center text-muted-foreground">
                        选定窗口暂无直连调用记录
                      </TableCell>
                    </TableRow>
                  ) : (
                    view.daily.map((day) => (
                      <TableRow key={day.day}>
                        <TableCell className="pl-4 font-mono text-xs">{day.day}</TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">
                          {usd(day.cost_micro_usd)}
                        </TableCell>
                        <TableCell className="pr-4 text-right font-mono text-xs tabular-nums">
                          {day.images}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>

        {view.official ? (
          <Card>
            <CardHeader className="pb-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <CardTitle className="text-base">OpenAI 官方 Costs 对账（UTC）</CardTitle>
                {windowOfficialTotal !== null ? (
                  <span className="font-mono text-xs tabular-nums text-muted-foreground">
                    合计 {usd(windowOfficialTotal)}
                  </span>
                ) : null}
              </div>
              <p className="text-xs text-muted-foreground">
                按 UTC 自然日统计，与左侧 UTC+8 存在 8 小时日界线偏移。
              </p>
            </CardHeader>
            <CardContent>
              {view.official.ok ? (
                <div className="overflow-x-auto rounded-lg border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="pl-4">日期（UTC）</TableHead>
                        <TableHead className="pr-4 text-right">官方账单</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {view.official.days.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={2} className="py-6 text-center text-muted-foreground">
                            这段时间没有官方账单记录
                          </TableCell>
                        </TableRow>
                      ) : (
                        view.official.days.map((day) => (
                          <TableRow key={day.day}>
                            <TableCell className="pl-4 font-mono text-xs">{day.day}</TableCell>
                            <TableCell className="pr-4 text-right font-mono text-xs tabular-nums">
                              {usd(day.cost_micro_usd)}
                            </TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </div>
              ) : (
                <p className="text-xs text-danger">官方花费暂时无法读取</p>
              )}
            </CardContent>
          </Card>
        ) : null}
      </div>
    </div>
  )
}

function KeyRow({
  row,
  pending,
  writable,
  first,
  last,
  onMove,
  onToggle,
  onBudget,
  onDelete,
  onRestore,
}: {
  row: GptDirectKeyView
  pending: string | null
  writable: boolean
  first: boolean
  last: boolean
  onMove: (direction: -1 | 1) => void
  onToggle: () => void
  onBudget: (budgetUsd: number) => void
  onDelete: () => void
  onRestore: () => void
}) {
  const [budget, setBudget] = useState(String(row.budget_usd))
  useEffect(() => {
    setBudget(String(row.budget_usd))
  }, [row.budget_usd])
  const admin = row.source === 'admin' && row.id !== null
  const keyRatio =
    row.budget_micro_usd > 0
      ? Math.min(100, Math.round((row.spent_micro_usd / row.budget_micro_usd) * 100))
      : 0
  const parsedBudget = Number(budget)
  const budgetValid = Number.isInteger(parsedBudget) && parsedBudget > 0
  const budgetChanged = parsedBudget !== row.budget_usd

  return (
    <TableRow>
      <TableCell className="py-2.5 pl-4 font-mono text-xs tabular-nums">
        <div className="flex items-center gap-1">
          <span className="w-5">#{row.ordinal}</span>
          {admin ? (
            <div className="flex items-center">
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label="上移"
                disabled={!writable || pending !== null || first}
                onClick={() => onMove(-1)}
              >
                <ArrowUp />
              </Button>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label="下移"
                disabled={!writable || pending !== null || last}
                onClick={() => onMove(1)}
              >
                <ArrowDown />
              </Button>
            </div>
          ) : null}
        </div>
      </TableCell>
      <TableCell className="py-2.5 font-mono text-xs">{row.label}</TableCell>
      <TableCell className="py-2.5">
        <KeyStatus status={row.status} />
      </TableCell>
      <TableCell className="min-w-[160px] py-2.5 pr-6 text-right font-mono text-xs tabular-nums">
        <div>
          {usd(row.spent_micro_usd)}
          <span className="text-muted-foreground"> / {usd(row.budget_micro_usd)}</span>
        </div>
        <div className="mt-1 ml-auto h-1.5 w-24 overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              'h-full',
              keyRatio >= 100 ? 'bg-danger' : keyRatio >= 80 ? 'bg-warning' : 'bg-success',
            )}
            style={{ width: `${keyRatio}%` }}
          />
        </div>
      </TableCell>
      <TableCell className="w-[152px] py-2.5">
        {admin ? (
          <div className="flex items-center gap-1.5">
            <Input
              type="number"
              min={1}
              step={1}
              value={budget}
              aria-label={`${row.label} 月预算`}
              className="h-7 w-20 px-2 font-mono text-xs tabular-nums"
              onChange={(event) => setBudget(event.target.value)}
            />
            <Button
              type="button"
              size="xs"
              variant={budgetChanged ? 'default' : 'outline'}
              disabled={!writable || pending !== null || !budgetChanged || !budgetValid}
              onClick={() => {
                if (!budgetValid) return
                onBudget(parsedBudget)
              }}
            >
              保存
            </Button>
          </div>
        ) : (
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            ${row.budget_usd}
          </span>
        )}
      </TableCell>
      <TableCell className="max-w-[200px] py-2.5">
        {row.last_error ? (
          <span className="block truncate text-xs text-muted-foreground" title={row.last_error}>
            {row.last_error} {row.last_error_at ? <FuzzyTime ts={row.last_error_at} /> : null}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className="py-2.5 pr-4">
        <div className="flex items-center justify-end gap-1.5">
          {row.status === 'disabled' ? (
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={pending !== null}
              onClick={onRestore}
            >
              恢复
            </Button>
          ) : null}
          {admin ? (
            <>
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={!writable || pending !== null}
                onClick={onToggle}
              >
                {row.enabled ? '停用' : '启用'}
              </Button>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                className="text-muted-foreground hover:text-danger"
                disabled={!writable || pending !== null}
                onClick={onDelete}
              >
                删除
              </Button>
            </>
          ) : null}
        </div>
      </TableCell>
    </TableRow>
  )
}

function KeyStatus({ status }: { status: GptDirectKeyStatus }) {
  if (status === 'available') return <Badge variant="success">{STATUS_LABEL[status]}</Badge>
  if (status === 'disabled' || status === 'off') {
    return <Badge variant="danger">{STATUS_LABEL[status]}</Badge>
  }
  return <Badge variant="warning">{STATUS_LABEL[status]}</Badge>
}
