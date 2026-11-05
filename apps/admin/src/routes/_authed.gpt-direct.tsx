import type { GptDirectAdminView, GptDirectKeyStatus } from '@image-playground/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'

import { FuzzyTime } from '@/components/FuzzyTime'
import { Kpi } from '@/components/Kpi'
import { ErrorState, Page, PendingState } from '@/components/Page'
import { SegmentedControl } from '@/components/SegmentedControl'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { restoreGptDirectKey, useGptDirect } from '@/lib/queries'

const RANGE_OPTIONS = [
  { value: '7' as const, label: '7 天' },
  { value: '30' as const, label: '30 天' },
]

const STATUS_LABEL: Record<GptDirectKeyStatus, string> = {
  available: '可用',
  cooldown: '冷却',
  disabled: '额度耗尽或失效',
  budget: '预算用满',
}

function usd(micro: number): string {
  return `$${(micro / 1_000_000).toFixed(2)}`
}

function parseDays(value: unknown): 7 | 30 {
  return value === '30' || value === 30 ? 30 : 7
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
  const queryClient = useQueryClient()
  const restore = useMutation({
    mutationFn: restoreGptDirectKey,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['gpt-direct'] })
    },
  })
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

      <section className="space-y-2">
        <h2 className="text-base font-semibold">密钥</h2>
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
              view.keys.map((key) => (
                <TableRow key={key.fingerprint}>
                  <TableCell className="font-mono tabular-nums">{key.ordinal}</TableCell>
                  <TableCell className="font-mono">{key.label}</TableCell>
                  <TableCell>
                    <KeyStatus status={key.status} />
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {usd(key.spent_micro_usd)}
                    <span className="text-muted-foreground"> / {usd(key.budget_micro_usd)}</span>
                  </TableCell>
                  <TableCell className="max-w-[280px]">
                    {key.last_error ? (
                      <span className="block truncate text-xs" title={key.last_error}>
                        {key.last_error}
                        {key.last_error_at ? (
                          <>
                            {' '}
                            <FuzzyTime ts={key.last_error_at} />
                          </>
                        ) : null}
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {key.status === 'disabled' ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={restore.isPending}
                        onClick={() => restore.mutate(key.fingerprint)}
                      >
                        恢复
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
        {restore.isError ? (
          <p role="status" className="text-sm text-danger">
            恢复失败
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
            <p className="text-sm text-danger">官方花费暂时取不到</p>
          )}
        </section>
      ) : null}
    </div>
  )
}

function KeyStatus({ status }: { status: GptDirectKeyStatus }) {
  if (status === 'available') return <Badge variant="success">{STATUS_LABEL[status]}</Badge>
  if (status === 'disabled') return <Badge variant="destructive">{STATUS_LABEL[status]}</Badge>
  return <Badge variant="warning">{STATUS_LABEL[status]}</Badge>
}
