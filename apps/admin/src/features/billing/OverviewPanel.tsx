import type { BillingOverview } from '@image-playground/shared'
import { useQuery } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { apiClient } from '../../lib/private-host'
import { Button } from '../../lib/private-host-ui'
import { ActivityHeatGraph } from './ActivityHeatGraph'
import { CHAT_USAGE_FIELDS, useChatUsage } from './chat-usage'
import { credits } from './shared'

function Metric({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <article className="rounded-lg border bg-background/55 p-4">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </p>
      <p className="mt-3 font-mono text-2xl font-semibold tabular-nums">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{note}</p>
    </article>
  )
}
function OverviewMetrics() {
  const overview = useQuery({
    queryKey: ['private-billing', 'overview'],
    queryFn: () => apiClient.get<BillingOverview>('/api/private/billing/overview'),
  })
  if (overview.isPending)
    return (
      <div className="rounded-xl border p-5 text-sm text-muted-foreground">
        正在汇总商业运营数据…
      </div>
    )
  if (overview.isError)
    return (
      <div
        role="alert"
        className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-destructive/40 bg-destructive/5 p-5 text-sm text-destructive"
      >
        <span>商业运营数据读取失败</span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={overview.isFetching}
          onClick={() => void overview.refetch()}
        >
          <RefreshCw
            className={overview.isFetching ? 'size-3.5 animate-spin' : 'size-3.5'}
            aria-hidden="true"
          />
          重试
        </Button>
      </div>
    )
  const data = overview.data
  return (
    <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4" aria-label="计费指标">
      <Metric label="积分账户" value={String(data.accounts)} note="已创建账户" />
      <Metric label="生效套餐" value={String(data.active_subscriptions)} note="当前 active" />
      <Metric label="套餐积分余额" value={credits(data.subscription_credits)} note="全站待消费" />
      <Metric label="充值积分余额" value={credits(data.recharge_credits)} note="长期有效余额" />
    </section>
  )
}

function ChatUsageMetrics() {
  const { data } = useChatUsage('/api/private/billing/chat-usage')
  if (!data) return null
  return (
    <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4" aria-label="对话消耗">
      {CHAT_USAGE_FIELDS.map(({ key, label }) => (
        <Metric key={key} label={label} value={credits(data[key])} note="全站累计" />
      ))}
    </section>
  )
}

function OverviewPanel() {
  return (
    <>
      <OverviewMetrics />
      <ChatUsageMetrics />
      <ActivityHeatGraph path="/api/private/billing/activity" />
    </>
  )
}

export { Metric, OverviewPanel }
