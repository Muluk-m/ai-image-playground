import { OPS_THRESHOLDS } from '@image-playground/shared'
import { Link } from '@tanstack/react-router'

import { Kpi } from '@/components/Kpi'
import { OpsBlockCard } from '@/components/ops/OpsBlockCard'
import { fuzzyTime, shortId } from '@/lib/format'
import type { OpsBlock, OpsReliability } from '@/lib/types'

const SOURCE_LABEL = { api: '接口 5xx', generation: '生成失败', agent: 'Agent 失败' } as const

function availability(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(3)}%`
}

export function reliabilityProblems(data: OpsReliability): string[] {
  const problems: string[] = []
  if (data.recent.generation_system >= OPS_THRESHOLDS.GENERATION_SYSTEM_FAILURES)
    problems.push(`近 15 分钟有 ${data.recent.generation_system} 次非内容策略的生成失败`)
  if (data.recent.agent_failed >= OPS_THRESHOLDS.AGENT_TURN_FAILURES)
    problems.push(`近 15 分钟有 ${data.recent.agent_failed} 次 Agent 轮次失败`)
  return problems
}

export function ReliabilityBlock({ block, now }: { block: OpsBlock<OpsReliability>; now: number }) {
  return (
    <OpsBlockCard
      title="SLA 与异常"
      block={block}
      problems={reliabilityProblems}
      className="xl:col-span-2"
    >
      {(data) => (
        <>
          <p className="text-xs text-muted-foreground">
            近 15 分钟系统性生成失败 {data.recent.generation_system} 次 · Agent 轮次失败{' '}
            {data.recent.agent_failed} 次；越过告警阈值会主动推送。
          </p>
          <div className="grid gap-4 md:grid-cols-2">
            {data.windows.map((window) => (
              <div key={window.range} className="rounded-md border p-3">
                <p className="mb-3 text-sm font-medium">
                  近 {window.range === '24h' ? '24 小时' : '7 天'}
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    {window.requests.toLocaleString('zh-CN')} 次接口请求
                  </span>
                </p>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <Kpi
                    variant="inline"
                    label="接口可用率"
                    value={availability(window.availability)}
                    note={`${window.server_errors} 次 5xx`}
                    tone={
                      window.requests >= OPS_THRESHOLDS.API_MIN_REQUESTS_FOR_RATIO &&
                      window.availability !== null &&
                      1 - window.availability > OPS_THRESHOLDS.API_SERVER_ERROR_RATIO
                        ? 'danger'
                        : 'default'
                    }
                  />
                  <Kpi
                    variant="inline"
                    label="生成完成 / 失败"
                    value={`${window.generation_completed} / ${window.generation_failed}`}
                  />
                  <Kpi
                    variant="inline"
                    label="Agent 完成 / 失败"
                    value={`${window.agent_completed} / ${window.agent_failed}`}
                  />
                  <Kpi
                    variant="inline"
                    label="接口最后采样"
                    value={
                      window.last_api_sample_at === null
                        ? '无数据'
                        : fuzzyTime(window.last_api_sample_at, now)
                    }
                    note={
                      window.last_api_sample_at !== null &&
                      now - window.last_api_sample_at > OPS_THRESHOLDS.API_RECENT_WINDOW_MS
                        ? '近 15 分钟无新样本，不能判断当前状态'
                        : undefined
                    }
                  />
                </div>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            接口可用率 = 1 − 5xx / 已采集的用户 API
            请求；不含浏览器报错、网关不可达和没有请求的时段。生成与 Agent
            单列，内容策略拒绝也计入生成失败。
          </p>
          <div className="border-t pt-3">
            <p className="mb-2 text-sm font-medium">近 24 小时异常分布</p>
            {data.exceptions.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                已采集的接口、生成和 Agent 轮次没有失败。
              </p>
            ) : (
              <ul className="divide-y text-sm">
                {data.exceptions.map((group) => (
                  <li
                    key={`${group.source}:${group.key}`}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2"
                  >
                    <span className="w-20 shrink-0 text-muted-foreground">
                      {SOURCE_LABEL[group.source]}
                    </span>
                    <span className="min-w-0 flex-1 break-all font-mono text-xs">{group.key}</span>
                    {group.example_task_id ? (
                      <Link
                        to="/tasks/$taskId"
                        params={{ taskId: group.example_task_id }}
                        className="text-xs underline-offset-2 hover:underline"
                      >
                        样例任务 {shortId(group.example_task_id, 10)}
                      </Link>
                    ) : null}
                    <span className="tabular-nums font-medium">{group.count} 次</span>
                    <span className="w-24 text-right text-xs text-muted-foreground">
                      {fuzzyTime(group.last_at, now)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </OpsBlockCard>
  )
}
