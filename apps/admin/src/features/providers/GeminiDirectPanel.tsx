import type {
  GeminiDirectAdminView,
  GeminiDirectKeyStatus,
  GeminiDirectKeyView,
} from '@image-playground/shared'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, BarChart3, Cpu, Plus, Sparkles } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'

import { FuzzyTime } from '@/components/FuzzyTime'
import { Kpi } from '@/components/Kpi'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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
  createGeminiDirectKey,
  deleteGeminiDirectKey,
  geminiDirectQueryKey,
  reorderGeminiDirectKeys,
  restoreGeminiDirectKey,
  updateGeminiDirectKey,
} from '@/lib/queries'
import { cn } from '@/lib/utils'

const STATUS_LABEL: Record<GeminiDirectKeyStatus, string> = {
  available: '可用',
  cooldown: '429 冷却',
  disabled: '额度耗尽或失效',
  budget: '预算用满',
  off: '已停用',
}

const MODEL_FRIENDLY_NAME: Record<string, string> = {
  'gemini-nano-banana-2.1': 'Nano Banana 2.1',
  'gemini-3-pro-image': 'Nano Banana Pro',
  'gemini-3.1-flash-lite-image': 'Nano Banana 2 Lite',
}

function usd(micro: number): string {
  return `$${(micro / 1_000_000).toFixed(2)}`
}

function formatRate(succeeded: number, requests: number): string {
  if (requests <= 0) return '—'
  return `${((succeeded / requests) * 100).toFixed(1)}%`
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

export function GeminiDirectPanel({
  view,
  rangeControl,
}: {
  view: GeminiDirectAdminView
  rangeControl?: ReactNode
}) {
  const client = useQueryClient()
  const [draftKey, setDraftKey] = useState('')
  const [draftBudget, setDraftBudget] = useState('200')
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<GeminiDirectKeyView | null>(null)

  async function run(id: string, task: () => Promise<GeminiDirectAdminView>) {
    if (pending) return
    setPending(id)
    setError(null)
    try {
      await task()
      if (id === 'create') setDraftKey('')
      await Promise.all([
        client.invalidateQueries({ queryKey: geminiDirectQueryKey }),
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
  const successRate = formatRate(view.window_succeeded, view.window_requests)

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi
          label="本月估算花费"
          value={usd(view.total_spent_micro_usd)}
          note={`已用预算 ${budgetPercent}% · 按用量估算`}
        />
        <Kpi
          label="月度总预算"
          value={usd(view.total_budget_micro_usd)}
          tone={
            view.remaining_micro_usd === 0 && view.total_budget_micro_usd > 0 ? 'danger' : 'default'
          }
          note={`余量 ${usd(view.remaining_micro_usd)} · ${view.source === 'admin' ? '后台密钥池' : '环境变量'}`}
        />
        <Kpi
          label={`近 ${view.days} 天调用`}
          value={`${view.window_requests.toLocaleString('zh-CN')} 次`}
          note={`成功率 ${successRate} · 出图 ${view.window_images.toLocaleString('zh-CN')} 张`}
        />
        <Kpi
          label={`近 ${view.days} 天 429`}
          value={`${view.window_rate_limited.toLocaleString('zh-CN')} 次`}
          tone={view.window_rate_limited > 0 ? 'warning' : 'default'}
          note="单 Key 冷却切换 · 满额硬停"
        />
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Sparkles className="size-4 text-muted-foreground" />
              Gemini 直连密钥池（Vertex / Nano Banana）
            </CardTitle>
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
              当前读取部署环境变量（VERTEX_API_KEY）；添加后台密钥后将只走后台密钥池。
            </p>
          ) : null}

          <form
            className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 p-3"
            onSubmit={(event) => {
              event.preventDefault()
              const budgetUsd = Number(draftBudget)
              if (!draftKey.trim() || !Number.isInteger(budgetUsd) || budgetUsd <= 0) return
              void run('create', () =>
                createGeminiDirectKey({ apiKey: draftKey.trim(), budgetUsd }),
              )
            }}
          >
            <Input
              type="password"
              name="gemini-direct-key"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              value={draftKey}
              placeholder="输入新 Vertex / Gemini API Key…"
              aria-label="新 Gemini 密钥"
              className="h-8 max-w-xs flex-1 bg-background text-xs"
              onChange={(event) => setDraftKey(event.target.value)}
            />
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground">月预算 $</span>
              <Input
                type="number"
                name="gemini-direct-budget"
                min={1}
                step={1}
                value={draftBudget}
                aria-label="Gemini 月预算"
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
                  <TableHead className="pr-6 text-right">本月估算</TableHead>
                  <TableHead className="text-right">近 {view.days} 天调用 / 429</TableHead>
                  <TableHead>月预算（$）</TableHead>
                  <TableHead>最近异常</TableHead>
                  <TableHead className="pr-4 text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {view.keys.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="py-8 text-center text-muted-foreground">
                      没有配置 Gemini 直连密钥
                    </TableCell>
                  </TableRow>
                ) : (
                  view.keys.map((key, index) => (
                    <GeminiKeyRow
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
                        void run(`move-${key.id}`, () =>
                          reorderGeminiDirectKeys(ids, view.revision),
                        )
                      }}
                      onToggle={() => {
                        if (!key.id) return
                        void run(`toggle-${key.id}`, () =>
                          updateGeminiDirectKey(key.id as string, { enabled: !key.enabled }),
                        )
                      }}
                      onBudget={(budgetUsd) => {
                        if (!key.id) return
                        void run(`budget-${key.id}`, () =>
                          updateGeminiDirectKey(key.id as string, { budgetUsd }),
                        )
                      }}
                      onDelete={() => setDeleteTarget(key)}
                      onRestore={() => {
                        void run(`restore-${key.fingerprint}`, () =>
                          restoreGeminiDirectKey(key.fingerprint),
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

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 space-y-0 pb-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <BarChart3 className="size-4 text-muted-foreground" />
                按日用量与估算花费
              </CardTitle>
              <p className="mt-0.5 text-xs text-muted-foreground">
                窗口合计{' '}
                <span className="font-mono tabular-nums text-foreground">
                  {usd(view.window_cost_micro_usd)}
                </span>{' '}
                · {view.window_images.toLocaleString('zh-CN')} 张
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
                    <TableHead className="text-right">调用</TableHead>
                    <TableHead className="text-right">成功率</TableHead>
                    <TableHead className="text-right">出图</TableHead>
                    <TableHead className="text-right">429</TableHead>
                    <TableHead className="pr-4 text-right">估算花费</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {view.daily.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="py-6 text-center text-muted-foreground">
                        选定窗口暂无 Gemini 直连调用记录
                      </TableCell>
                    </TableRow>
                  ) : (
                    view.daily.map((day) => (
                      <TableRow key={day.day}>
                        <TableCell className="pl-4 font-mono text-xs">{day.day}</TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">
                          {day.requests}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">
                          {formatRate(day.succeeded, day.requests)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">
                          {day.images}
                        </TableCell>
                        <TableCell
                          className={cn(
                            'text-right font-mono text-xs tabular-nums',
                            day.rate_limited > 0
                              ? 'font-medium text-warning'
                              : 'text-muted-foreground',
                          )}
                        >
                          {day.rate_limited}
                        </TableCell>
                        <TableCell className="pr-4 text-right font-mono text-xs tabular-nums">
                          {usd(day.cost_micro_usd)}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Cpu className="size-4 text-muted-foreground" />
              按模型分布（近 {view.days} 天）
            </CardTitle>
            <p className="mt-0.5 text-xs text-muted-foreground">
              按响应 usageMetadata 与分辨率档位估算，非 Google 官方账单。
            </p>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4">模型</TableHead>
                    <TableHead className="text-right">调用</TableHead>
                    <TableHead className="text-right">成功率</TableHead>
                    <TableHead className="text-right">出图</TableHead>
                    <TableHead className="text-right">429</TableHead>
                    <TableHead className="pr-4 text-right">估算花费</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {view.by_model.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="py-6 text-center text-muted-foreground">
                        选定窗口暂无模型统计
                      </TableCell>
                    </TableRow>
                  ) : (
                    view.by_model.map((item) => (
                      <TableRow key={item.model}>
                        <TableCell className="pl-4">
                          <div className="text-xs font-medium text-foreground">
                            {MODEL_FRIENDLY_NAME[item.model] ?? item.model}
                          </div>
                          {MODEL_FRIENDLY_NAME[item.model] ? (
                            <code className="font-mono text-[11px] text-muted-foreground">
                              {item.model}
                            </code>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">
                          {item.requests}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">
                          {formatRate(item.succeeded, item.requests)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">
                          {item.images}
                        </TableCell>
                        <TableCell
                          className={cn(
                            'text-right font-mono text-xs tabular-nums',
                            item.rate_limited > 0
                              ? 'font-medium text-warning'
                              : 'text-muted-foreground',
                          )}
                        >
                          {item.rate_limited}
                        </TableCell>
                        <TableCell className="pr-4 text-right font-mono text-xs tabular-nums">
                          {usd(item.cost_micro_usd)}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </div>

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && pending === null) setDeleteTarget(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除 Gemini 直连密钥</DialogTitle>
            <DialogDescription>
              确认从后台密钥池删除 <code className="font-mono">{deleteTarget?.label}</code>？
              删除后如密钥池为空将回退到部署环境变量。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending !== null}
              onClick={() => setDeleteTarget(null)}
            >
              取消
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={pending !== null || !deleteTarget?.id}
              onClick={() => {
                const target = deleteTarget
                if (!target?.id) return
                setDeleteTarget(null)
                void run(`delete-${target.id}`, () => deleteGeminiDirectKey(target.id as string))
              }}
            >
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function GeminiKeyRow({
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
  row: GeminiDirectKeyView
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
  const canSaveBudget = writable && pending === null && budgetChanged && budgetValid
  const savingBudget = row.id !== null && pending === `budget-${row.id}`

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
        <div className="ml-auto mt-1 h-1.5 w-24 overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              'h-full',
              keyRatio >= 100 ? 'bg-danger' : keyRatio >= 80 ? 'bg-warning' : 'bg-success',
            )}
            style={{ width: `${keyRatio}%` }}
          />
        </div>
      </TableCell>
      <TableCell className="py-2.5 text-right font-mono text-xs tabular-nums">
        <div>
          <span>{row.requests} 次</span>
          <span className="text-muted-foreground">
            {' '}
            · {formatRate(row.succeeded, row.requests)}
          </span>
        </div>
        <div
          className={cn(
            'text-[11px]',
            row.rate_limited > 0 ? 'font-medium text-warning' : 'text-muted-foreground',
          )}
        >
          429: {row.rate_limited} · 图 {row.images}
        </div>
      </TableCell>
      <TableCell className="min-w-[164px] py-2.5">
        {admin ? (
          <form
            className="flex items-center gap-1.5"
            onSubmit={(event) => {
              event.preventDefault()
              if (!canSaveBudget) return
              onBudget(parsedBudget)
            }}
          >
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
              type="submit"
              size="xs"
              className="shrink-0 whitespace-nowrap"
              variant={budgetChanged && budgetValid ? 'default' : 'outline'}
              disabled={!canSaveBudget}
            >
              {savingBudget ? '保存中' : '保存'}
            </Button>
          </form>
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
          {row.status === 'disabled' || row.status === 'cooldown' ? (
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

function KeyStatus({ status }: { status: GeminiDirectKeyStatus }) {
  if (status === 'available') return <Badge variant="success">{STATUS_LABEL[status]}</Badge>
  if (status === 'disabled' || status === 'off') {
    return <Badge variant="danger">{STATUS_LABEL[status]}</Badge>
  }
  return <Badge variant="warning">{STATUS_LABEL[status]}</Badge>
}
