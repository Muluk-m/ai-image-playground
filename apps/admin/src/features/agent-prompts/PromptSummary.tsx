import type { AgentPromptsResult } from '../../../contracts'

const ratio = (count: number, total: number) =>
  total ? `${((100 * count) / total).toFixed(1)}%` : '—'
export function PromptSummary({
  summary,
}: {
  summary: NonNullable<AgentPromptsResult['summary']>
}) {
  const metrics = [
    ['提示词', summary.total.toLocaleString(), '当前时间与筛选条件'],
    [
      '确认前被改过',
      ratio(summary.edited, summary.knownOriginal),
      `${summary.edited} / ${summary.knownOriginal} 条已记录原稿`,
    ],
    [
      '尚未确认',
      ratio(summary.awaiting, summary.total),
      `${summary.awaiting} / ${summary.total} 条提示词`,
    ],
    [
      '提交后失败或取消',
      ratio(summary.failed, summary.submitted),
      `${summary.failed} / ${summary.submitted} 条已提交`,
    ],
  ]
  return (
    <section aria-label="提示词统计" className="grid grid-cols-2 gap-3 xl:grid-cols-4">
      {metrics.map(([label, value, note]) => (
        <div key={label} className="rounded-xl border p-4">
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="my-1 text-2xl font-bold tabular-nums tracking-tight">{value}</p>
          <p className="text-xs text-muted-foreground">{note}</p>
        </div>
      ))}
    </section>
  )
}
