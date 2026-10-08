import { OPS_THRESHOLDS } from '@image-playground/shared'
import { Link } from '@tanstack/react-router'

import { AlertTriangle, CircleCheck, CircleHelp } from 'lucide-react'
import { OpsBlockCard } from '@/components/ops/OpsBlockCard'
import { OutcomeBar } from '@/components/ops/OpsVisuals'
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

function EmptyExceptions({ data }: { data: OpsReliability }) {
  const window = data.windows.find((window) => window.range === '24h')
  const failed = window ? window.server_errors + window.generation_failed + window.agent_failed : 0
  const samples = window
    ? window.requests +
      window.generation_completed +
      window.generation_failed +
      window.agent_completed +
      window.agent_failed
    : 0
  return failed ? (
    <p className="flex items-center gap-2 rounded-lg bg-danger/5 p-3 text-sm text-danger">
      <AlertTriangle className="size-4 shrink-0" />近 24 小时有失败，暂无异常明细。
    </p>
  ) : samples ? (
    <p className="flex items-center gap-2 rounded-lg bg-success/5 p-3 text-sm text-success">
      <CircleCheck className="size-4 shrink-0" />
      已采集的接口、生成和 Agent 轮次没有失败。
    </p>
  ) : (
    <p className="flex items-center gap-2 rounded-lg bg-muted/30 p-3 text-sm text-muted-foreground">
      <CircleHelp className="size-4 shrink-0" />
      暂无样本，暂不能判断接口和任务表现。
    </p>
  )
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
          <div className="flex flex-wrap gap-3 text-xs">
            <span
              className={`rounded-full border px-3 py-1.5 ${data.recent.generation_system ? 'border-danger/25 bg-danger/5 text-danger' : 'border-border bg-muted/20 text-muted-foreground'}`}
            >
              近 15 分钟系统性生成失败 {data.recent.generation_system} 次
            </span>
            <span
              className={`rounded-full border px-3 py-1.5 ${data.recent.agent_failed ? 'border-danger/25 bg-danger/5 text-danger' : 'border-border bg-muted/20 text-muted-foreground'}`}
            >
              Agent 轮次失败 {data.recent.agent_failed} 次
            </span>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            {data.windows.map((window) => {
              const unhealthy =
                window.requests >= OPS_THRESHOLDS.API_MIN_REQUESTS_FOR_RATIO &&
                window.availability !== null &&
                1 - window.availability > OPS_THRESHOLDS.API_SERVER_ERROR_RATIO
              return (
                <div key={window.range} className="space-y-4 rounded-xl border bg-muted/15 p-5">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-medium">
                      近 {window.range === '24h' ? '24 小时' : '7 天'}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {window.requests.toLocaleString('zh-CN')} 次接口请求
                    </p>
                  </div>
                  <div className="flex flex-wrap items-end justify-between gap-3">
                    <div>
                      <p className="mb-2 text-xs text-muted-foreground">接口可用率</p>
                      <p
                        className={`text-3xl font-semibold tabular-nums tracking-tight ${window.availability === null ? 'text-muted-foreground' : unhealthy ? 'text-danger' : 'text-success'}`}
                      >
                        {availability(window.availability)}
                      </p>
                    </div>
                    <div className="text-right text-xs">
                      <p
                        className={
                          window.server_errors
                            ? 'text-danger'
                            : window.requests > 0
                              ? 'text-success'
                              : 'text-muted-foreground'
                        }
                      >
                        {window.server_errors} 次 5xx
                      </p>
                      <p className="mt-2 text-muted-foreground">
                        接口最后采样{' '}
                        {window.last_api_sample_at === null
                          ? '无数据'
                          : fuzzyTime(window.last_api_sample_at, now)}
                      </p>
                    </div>
                  </div>
                  {window.last_api_sample_at !== null &&
                  now - window.last_api_sample_at > OPS_THRESHOLDS.API_RECENT_WINDOW_MS ? (
                    <p className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
                      近 15 分钟无新样本，不能判断当前状态
                    </p>
                  ) : null}
                  <div className="grid grid-cols-2 gap-6 border-t pt-4">
                    <OutcomeBar
                      label="生成完成 / 失败"
                      completed={window.generation_completed}
                      failed={window.generation_failed}
                    />
                    <OutcomeBar
                      label="Agent 完成 / 失败"
                      completed={window.agent_completed}
                      failed={window.agent_failed}
                      tone="violet"
                    />
                  </div>
                </div>
              )
            })}
          </div>
          <p className="text-xs text-muted-foreground">
            接口可用率 = 1 − 5xx / 已采集的用户 API
            请求；不含浏览器报错、网关不可达和没有请求的时段。生成与 Agent
            单列，内容策略拒绝也计入生成失败。
          </p>
          <div className="border-t pt-3">
            <p className="mb-2 text-sm font-medium">近 24 小时异常分布</p>
            {data.exceptions.length === 0 ? (
              <EmptyExceptions data={data} />
            ) : (
              <ul className="divide-y text-sm">
                {data.exceptions.map((group) => (
                  <li
                    key={`${group.source}:${group.key}`}
                    className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3"
                  >
                    <AlertTriangle className="size-4 text-danger" />
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
                    <span className="tabular-nums font-medium text-danger">{group.count} 次</span>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full bg-danger/70"
                        style={{
                          width: `${(group.count / Math.max(...data.exceptions.map((one) => one.count))) * 100}%`,
                        }}
                      />
                    </div>
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
