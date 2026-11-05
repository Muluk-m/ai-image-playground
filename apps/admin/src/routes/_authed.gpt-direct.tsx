import type {
  GptDirectAdminView,
  GptDirectKeyStatus,
  GptDirectKeyView,
} from '@image-playground/shared'
import { useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'

import { FuzzyTime } from '@/components/FuzzyTime'
import { Kpi } from '@/components/Kpi'
import { ErrorState, Page, PendingState } from '@/components/Page'
import { SegmentedControl } from '@/components/SegmentedControl'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { ApiError } from '@/lib/api-client'
import {
  createGptDirectKey,
  deleteGptDirectKey,
  gptDirectQueryKey,
  reorderGptDirectKeys,
  restoreGptDirectKey,
  updateGptDirectKey,
  useGptDirect,
} from '@/lib/queries'

const RANGE_OPTIONS = [
  { value: '7' as const, label: '7 天' },
  { value: '30' as const, label: '30 天' },
]

const STATUS_LABEL: Record<GptDirectKeyStatus, string> = {
  available: '可用',
  cooldown: '冷却',
  disabled: '额度耗尽或失效',
  budget: '预算用满',
  off: '已停用',
}

function usd(micro: number): string {
  return `$${(micro / 1_000_000).toFixed(2)}`
}

function parseDays(value: unknown): 7 | 30 {
  return value === '30' || value === 30 ? 30 : 7
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
  if (body?.error === 'stale_revision') return '顺序已变化'
  return '操作失败'
}

export const Route = createFileRoute('/_authed/gpt-direct')({
  validateSearch: (search: Record<string, unknown>) => ({ days: parseDays(search.days) }),
  component: GptDirectPage,
})

function GptDirectPage() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const days = search.days
  const query = useGptDirect(days)
  return (
    <Page
      crumbs={[{ label: '直连' }]}
      description="按 usage 估算，不是 OpenAI 账户余额"
      actions={
        <SegmentedControl
          options={RANGE_OPTIONS}
          value={String(days) as '7' | '30'}
          onChange={(next) => {
            void navigate({
              search: { days: next === '30' ? 30 : 7 },
              replace: true,
            })
          }}
          label="花费范围"
        />
      }
    >
      {query.data ? (
        <GptDirectBoard view={query.data} />
      ) : query.isError ? (
        <ErrorState label="直连状态加载失败" error={query.error} />
      ) : (
        <PendingState label="正在读取直连密钥" />
      )}
    </Page>
  )
}

function GptDirectBoard({ view }: { view: GptDirectAdminView }) {
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
      await client.invalidateQueries({ queryKey: gptDirectQueryKey })
    } catch (cause) {
      setError(failureMessage(cause))
    } finally {
      setPending(null)
    }
  }

  const adminIds = view.keys.flatMap((key) => (key.id ? [key.id] : []))

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-3">
        <Kpi label="本月花费" value={usd(view.total_spent_micro_usd)} />
        <Kpi label="预算" value={usd(view.total_budget_micro_usd)} />
        <Kpi
          label="余量"
          value={usd(view.remaining_micro_usd)}
          tone={view.remaining_micro_usd === 0 ? 'danger' : 'default'}
        />
      </div>

      {view.disabled_reason ? (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
          {view.disabled_reason}
        </p>
      ) : null}

      <section className="space-y-3">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-base font-semibold">密钥</h2>
          <span className="text-xs text-muted-foreground">
            {view.source === 'admin' ? '后台' : '环境变量'}
            <span className="ml-3 font-mono">{view.fingerprint_mac_source}</span>
          </span>
        </div>
        {view.source === 'env' ? (
          <p className="text-sm text-muted-foreground">保存后只走后台密钥</p>
        ) : null}
        <form
          className="flex flex-wrap items-center gap-2"
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
            placeholder="新密钥"
            aria-label="新密钥"
            className="max-w-xs"
            onChange={(event) => setDraftKey(event.target.value)}
          />
          <Input
            type="number"
            name="gpt-direct-budget"
            min={1}
            step={1}
            value={draftBudget}
            aria-label="月预算"
            className="w-28"
            onChange={(event) => setDraftBudget(event.target.value)}
          />
          <Button type="submit" disabled={!view.writable || !draftKey.trim() || pending !== null}>
            {pending === 'create' ? '保存中' : '添加'}
          </Button>
        </form>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>顺序</TableHead>
              <TableHead>指纹</TableHead>
              <TableHead>状态</TableHead>
              <TableHead className="text-right">本月</TableHead>
              <TableHead>最近报错</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {view.keys.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-muted-foreground">
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
        {error ? (
          <p role="status" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </section>

      <section className="space-y-2">
        <h2 className="text-base font-semibold">按天</h2>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>日期</TableHead>
              <TableHead className="text-right">花费</TableHead>
              <TableHead className="text-right">张数</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {view.daily.map((day) => (
              <TableRow key={day.day}>
                <TableCell className="font-mono">{day.day}</TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  {usd(day.cost_micro_usd)}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">{day.images}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>

      {view.official ? (
        <section className="space-y-2">
          <h2 className="text-base font-semibold">官方花费</h2>
          {view.official.ok ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>UTC</TableHead>
                  <TableHead className="text-right">花费</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {view.official.days.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={2} className="text-muted-foreground">
                      这段没有官方记录
                    </TableCell>
                  </TableRow>
                ) : (
                  view.official.days.map((day) => (
                    <TableRow key={day.day}>
                      <TableCell className="font-mono">{day.day}</TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {usd(day.cost_micro_usd)}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          ) : (
            <p className="text-sm text-destructive">官方花费暂时取不到</p>
          )}
        </section>
      ) : null}
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
  return (
    <TableRow>
      <TableCell className="font-mono tabular-nums">{row.ordinal}</TableCell>
      <TableCell className="font-mono">{row.label}</TableCell>
      <TableCell>
        <KeyStatus status={row.status} />
      </TableCell>
      <TableCell className="text-right font-mono tabular-nums">
        {usd(row.spent_micro_usd)}
        <span className="text-muted-foreground"> / {usd(row.budget_micro_usd)}</span>
      </TableCell>
      <TableCell className="max-w-[240px]">
        {row.last_error ? (
          <span className="block truncate text-xs">
            {row.last_error} {row.last_error_at ? <FuzzyTime ts={row.last_error_at} /> : null}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap justify-end gap-1">
          {row.status === 'disabled' ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={pending !== null}
              onClick={onRestore}
            >
              恢复
            </Button>
          ) : null}
          {admin ? (
            <>
              <Input
                type="number"
                min={1}
                step={1}
                value={budget}
                aria-label={`${row.label} 月预算`}
                className="h-8 w-24"
                onChange={(event) => setBudget(event.target.value)}
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!writable || pending !== null}
                onClick={() => {
                  const budgetUsd = Number(budget)
                  if (!Number.isInteger(budgetUsd) || budgetUsd <= 0) return
                  onBudget(budgetUsd)
                }}
              >
                预算
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!writable || pending !== null || first}
                onClick={() => onMove(-1)}
              >
                上移
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!writable || pending !== null || last}
                onClick={() => onMove(1)}
              >
                下移
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!writable || pending !== null}
                onClick={onToggle}
              >
                {row.enabled ? '停用' : '启用'}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
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
    return <Badge variant="destructive">{STATUS_LABEL[status]}</Badge>
  }
  return <Badge variant="warning">{STATUS_LABEL[status]}</Badge>
}
