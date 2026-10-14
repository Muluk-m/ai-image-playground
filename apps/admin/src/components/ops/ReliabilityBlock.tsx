import { OPS_THRESHOLDS } from '@image-playground/shared'
import { Link } from '@tanstack/react-router'

import { AlertTriangle, CircleCheck, CircleHelp } from 'lucide-react'
import { useState } from 'react'
import { OpsBlockCard } from '@/components/ops/OpsBlockCard'
import { OutcomeBar } from '@/components/ops/OpsVisuals'
import { fuzzyTime, shortId } from '@/lib/format'
import type {
  OpsAgentFailureSample,
  OpsBlock,
  OpsExceptionGroup,
  OpsReliability,
} from '@/lib/types'

const SOURCE_LABEL = { api: '接口 5xx', generation: '生成失败', agent: 'Agent 失败' } as const

const AGENT_REASON: Record<string, string> = {
  agent_upstream_error: '上游报错',
  agent_run_failed: '执行失败',
  agent_tool_failed: '工具失败',
  agent_turn_interrupted: '轮次中断',
  agent_context_overflow: '上下文超限',
  agent_request_budget_exceeded: '请求超预算',
  unknown: '未记录原因',
}

/**
 * 和 `turn.ts` 里记下来的事件名对齐。工具失败不会走进 `agent.turn_failed`，
 * 它留在收尾日志 `agent.turn_settled` 的 error 字段里。
 */
const AGENT_LOG_GROUP: Record<string, string> = {
  agent_upstream_error: 'agent.upstream_failed',
  agent_run_failed: 'agent.turn_failed',
  agent_context_overflow: 'agent.context_overflow',
  agent_request_budget_exceeded: 'agent.request_rejected',
}

function agentLogSearch(at: number, key: string, requestId?: string) {
  const to = Math.min(Date.now() + 30_000, at + 15 * 60_000)
  const from = Math.max(0, to - 60 * 60_000, at - 60 * 60_000)
  const window = to > from ? { from, to } : {}
  if (requestId) return { ...window, requestId }
  if (key === 'agent_tool_failed') {
    return { ...window, group: 'agent.turn_settled', q: 'agent_tool_failed' }
  }
  const logGroup = AGENT_LOG_GROUP[key]
  return logGroup ? { ...window, group: logGroup } : { ...window, q: key }
}

function availability(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(3)}%`
}

/** 展开后按时间从新到旧。没有样品时，用这一组最新的一条顶上。 */
function agentReasons(group: OpsExceptionGroup): OpsAgentFailureSample[] {
  if (group.samples && group.samples.length > 0) return group.samples
  if (!group.detail && !group.example_request_id) return []
  return [
    {
      at: group.last_at,
      ...(group.detail ? { message: group.detail } : {}),
      ...(group.example_request_id ? { request_id: group.example_request_id } : {}),
    },
  ]
}

function ExceptionRow({
  group,
  now,
  maxCount,
}: {
  group: OpsExceptionGroup
  now: number
  maxCount: number
}) {
  const reasons = group.source === 'agent' ? agentReasons(group) : []
  const [open, setOpen] = useState(false)
  const expanded = open && reasons.length > 0
  const panelId = `agent-reasons-${encodeURIComponent(group.key)}`
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
      <AlertTriangle className="size-4 text-danger" />
      <span className="w-20 shrink-0 text-muted-foreground">{SOURCE_LABEL[group.source]}</span>
      <span className="min-w-0 flex-1 break-all font-mono text-xs">
        {group.source === 'agent' && AGENT_REASON[group.key]
          ? `${AGENT_REASON[group.key]} · ${group.key}`
          : group.key}
      </span>
      {group.example_task_id ? (
        <Link
          to="/tasks/$taskId"
          params={{ taskId: group.example_task_id }}
          className="text-xs underline-offset-2 hover:underline"
        >
          样例任务 {shortId(group.example_task_id, 10)}
        </Link>
      ) : null}
      {reasons.length > 0 ? (
        <button
          type="button"
          className="text-xs underline-offset-2 hover:underline"
          aria-expanded={expanded}
          aria-controls={expanded ? panelId : undefined}
          onClick={() => setOpen((value) => !value)}
        >
          {expanded ? '收起原因' : '查看原因'}
        </button>
      ) : null}
      {group.source === 'agent' ? (
        <Link
          to="/logs"
          search={agentLogSearch(group.last_at, group.key, group.example_request_id)}
          className="text-xs underline-offset-2 hover:underline"
        >
          日志
        </Link>
      ) : null}
      <span className="tabular-nums font-medium text-danger">{group.count} 次</span>
      {expanded ? (
        <ul id={panelId} aria-label="失败原因" className="flex w-full flex-col gap-2 pl-7">
          {reasons.map((sample, index) => (
            <li
              key={`${sample.at}:${sample.request_id ?? index}`}
              className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs"
            >
              <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-muted-foreground">
                {sample.message ?? '这次失败没有记下说明'}
              </p>
              <span className="text-muted-foreground">{fuzzyTime(sample.at, now)}</span>
              <Link
                to="/logs"
                search={agentLogSearch(sample.at, group.key, sample.request_id)}
                className="underline-offset-2 hover:underline"
              >
                日志
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full bg-danger/70"
          style={{ width: `${(group.count / maxCount) * 100}%` }}
        />
      </div>
      <span className="w-24 text-right text-xs text-muted-foreground">
        {fuzzyTime(group.last_at, now)}
      </span>
    </li>
  )
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
                  <ExceptionRow
                    key={`${group.source}:${group.key}`}
                    group={group}
                    now={now}
                    maxCount={Math.max(...data.exceptions.map((one) => one.count))}
                  />
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </OpsBlockCard>
  )
}
