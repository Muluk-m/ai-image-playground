/**
 * 概览页（指挥台）的判断逻辑：健康灯、需要处理、环比。纯函数，不碰网络，页面只负责摆放。
 *
 * 运维相关的判断一律复用运维看板的那套问题清单（opsProblems），不另立阈值：
 * 首页亮红灯的时候，点进运维看板一定能在对应那一栏看到同一句话。
 */
import { type OpsProblem, type OpsSource, opsProblems } from '@/components/ops/OpsBoard'
import { bytes, elapsed, fuzzyTime } from '@/lib/format'
import type { Range } from '@/lib/search-params'
import type { ClientErrorsResult, OpsSnapshot, OverviewResult } from '@/lib/types'

export type Tone = 'ok' | 'warn' | 'bad' | 'unknown'
export type SignalLink = '/ops' | '/errors'

export interface HealthTile {
  key: string
  label: string
  value: string
  note: string
  tone: Tone
  to: SignalLink
}

export interface AttentionItem {
  key: string
  source: string
  tone: 'bad' | 'warn'
  title: string
  detail?: string
  to?: SignalLink
}

/**
 * 跳到详情页时要带上的查询参数。前端错误页与概览共用同一种时间窗，带过去才能核对同一批错误；
 * 运维看板的时间窗是另一套（只管宿主机曲线），不带。
 */
export function signalSearch(to: SignalLink, range: Range): Record<string, string> {
  return to === '/errors' ? { range } : {}
}

export interface Change {
  text: string
  /** 变化对业务是好是坏；持平或没有基线时为 neutral。 */
  sentiment: 'good' | 'bad' | 'neutral'
}

/** 一份数据的读取状态：还在路上、到了、或者重试完仍然没取到。 */
export type SourceState = 'loading' | 'ready' | 'failed'

export interface SignalInput {
  overview: OverviewResult
  ops?: OpsSnapshot
  opsState?: SourceState
  errors?: ClientErrorsResult
  errorsState?: SourceState
}

/** 成功率低于上期这么多个百分点就亮黄灯。 */
const SUCCESS_DROP = 0.05
/** 样本太少时比例没有意义，不据此亮灯。 */
const MIN_SAMPLE = 20

export function percent(ratio: number | null, digits = 1): string {
  return ratio === null ? '—' : `${(ratio * 100).toFixed(digits)}%`
}

function ratio(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null
}

/** 与上一个同长度窗口比。`higherIsBetter` 决定涨了算好还是算坏。 */
export function change(current: number, previous: number, higherIsBetter = true): Change {
  if (previous === 0) {
    return current === 0
      ? { text: '持平', sentiment: 'neutral' }
      : { text: '上期为 0', sentiment: 'neutral' }
  }
  const delta = (current - previous) / previous
  if (Math.abs(delta) < 0.005) return { text: '持平', sentiment: 'neutral' }
  const up = delta > 0
  return {
    text: `${up ? '+' : '−'}${Math.abs(delta * 100).toFixed(1)}%`,
    sentiment: up === higherIsBetter ? 'good' : 'bad',
  }
}

function sourceProblems(problems: readonly OpsProblem[], ...sources: OpsSource[]): OpsProblem[] {
  return problems.filter((problem) => sources.includes(problem.source))
}

function pendingTile(key: string, label: string, state: SourceState, to: SignalLink): HealthTile {
  return state === 'failed'
    ? { key, label, value: '取不到', note: '这份数据没有读到，点进去看详情', tone: 'unknown', to }
    : { key, label, value: '…', note: '正在读取', tone: 'unknown', to }
}

interface Reading {
  value: string
  note: string
  /** 读数本身不足以判断好坏（例如没有任何请求）：灯显示未知，不冒充正常。 */
  insufficient?: boolean
}

function opsTile(
  key: string,
  label: string,
  ops: OpsSnapshot | undefined,
  opsState: SourceState,
  block: keyof Omit<OpsSnapshot, 'generated_at'>,
  problems: readonly OpsProblem[],
  read: (snapshot: OpsSnapshot) => Reading,
): HealthTile {
  if (!ops) return pendingTile(key, label, opsState, '/ops')
  if (!ops[block].ok) {
    return { key, label, value: '取不到', note: '运维看板里看原因', tone: 'unknown', to: '/ops' }
  }
  const reading = read(ops)
  return {
    key,
    label,
    value: reading.value,
    note: problems[0]?.text ?? reading.note,
    tone: problems.length ? 'bad' : reading.insufficient ? 'unknown' : 'ok',
    to: '/ops',
  }
}

function stateOf(data: unknown, state: SourceState | undefined): SourceState {
  return state ?? (data ? 'ready' : 'loading')
}

export function healthTiles(input: SignalInput): HealthTile[] {
  const { overview, ops, errors } = input
  const opsState = stateOf(ops, input.opsState)
  const errorsState = stateOf(errors, input.errorsState)
  const problems = ops ? opsProblems(ops) : []
  const reliability = sourceProblems(problems, 'reliability')
  const { current, previous } = overview.pulse

  const generationTerminal = current.completed + current.failed
  const previousTerminal = previous.completed + previous.failed
  const generationRate = ratio(current.completed, generationTerminal)
  const previousGenerationRate = ratio(previous.completed, previousTerminal)
  const generationAlert = reliability.filter((problem) => problem.text.includes('生成'))
  const generationDropped =
    generationRate !== null &&
    previousGenerationRate !== null &&
    generationTerminal >= MIN_SAMPLE &&
    previousTerminal >= MIN_SAMPLE &&
    generationRate < previousGenerationRate - SUCCESS_DROP
  const generation: HealthTile = {
    key: 'generation',
    label: '生成',
    value: percent(generationRate),
    note:
      generationAlert[0]?.text ??
      (generationRate === null
        ? '这段时间没有已结束的任务'
        : `成功率 · ${current.failed} 次失败 · 上期 ${percent(previousGenerationRate)}`),
    tone: generationAlert.length
      ? 'bad'
      : generationRate === null
        ? 'unknown'
        : generationDropped
          ? 'warn'
          : 'ok',
    to: '/ops',
  }

  const agentCompleted = current.agent_turns - current.agent_failed - current.agent_aborted
  const agentRate = ratio(agentCompleted, agentCompleted + current.agent_failed)
  const agentAlert = reliability.filter((problem) => problem.text.includes('Agent'))
  const agent: HealthTile = {
    key: 'agent',
    label: 'Agent',
    value: percent(agentRate),
    note:
      agentAlert[0]?.text ??
      (agentRate === null
        ? '这段时间没有已结束的轮次'
        : `完成率 · ${current.agent_turns} 轮 · ${current.agent_aborted} 次用户中断`),
    tone: agentAlert.length ? 'bad' : agentRate === null ? 'unknown' : 'ok',
    to: '/ops',
  }

  const api = opsTile(
    'api',
    '接口',
    ops,
    opsState,
    'api',
    sourceProblems(problems, 'api'),
    (snapshot) => {
      const recent = snapshot.api.ok ? snapshot.api.data.recent : null
      if (!recent || recent.requests === 0) {
        return { value: '—', note: '近 15 分钟没有请求，无从判断', insufficient: true }
      }
      return {
        value: percent(ratio(recent.server_errors, recent.requests), 2),
        note: `近 15 分钟 5xx · P95 ${recent.p95_ms === null ? '—' : `${recent.p95_ms}ms`}`,
      }
    },
  )

  const frontend: HealthTile = errors
    ? {
        key: 'frontend',
        label: '前端',
        value: String(errors.summary.boot_events),
        note: `启动失败 · 共 ${errors.summary.events} 次错误 · ${errors.summary.devices} 台设备`,
        tone: errors.summary.boot_events > 0 ? 'warn' : 'ok',
        to: '/errors',
      }
    : pendingTile('frontend', '前端', errorsState, '/errors')

  const queue = opsTile(
    'queue',
    '队列',
    ops,
    opsState,
    'queue',
    sourceProblems(problems, 'queue'),
    (snapshot) => {
      const data = snapshot.queue.ok ? snapshot.queue.data : null
      return {
        value: data?.oldest_queued_wait_ms == null ? '空' : elapsed(data.oldest_queued_wait_ms),
        note: data ? `最老等待 · 排队 ${data.queued} · 运行中 ${data.in_progress}` : '',
      }
    },
  )

  const services = opsTile(
    'services',
    '服务',
    ops,
    opsState,
    'services',
    sourceProblems(problems, 'services', 'deployments'),
    (snapshot) => {
      const data = snapshot.services.ok ? snapshot.services.data.services : []
      return { value: `${data.length} 个实例`, note: '心跳正常' }
    },
  )

  const host = opsTile(
    'host',
    '宿主机',
    ops,
    opsState,
    'host',
    sourceProblems(problems, 'host', 'containers'),
    (snapshot) => {
      const latest = snapshot.host.ok ? snapshot.host.data.latest : null
      if (!latest) return { value: '未启用', note: '没有采集容器', insufficient: true }
      return {
        value: percent(1 - latest.disk_available_bytes / latest.disk_total_bytes, 0),
        note: `磁盘已用 · 内存可用 ${percent(latest.mem_available_bytes / latest.mem_total_bytes, 0)}`,
      }
    },
  )

  const backup = opsTile(
    'backup',
    '备份',
    ops,
    opsState,
    'backup',
    sourceProblems(problems, 'backup'),
    (snapshot) => {
      const latest = snapshot.backup.ok ? snapshot.backup.data.latest : null
      return latest
        ? {
            value: fuzzyTime(latest.modified_at, snapshot.generated_at),
            note: bytes(latest.size_bytes),
          }
        : { value: '无', note: '' }
    },
  )

  return [generation, agent, api, frontend, queue, services, host, backup]
}

const OPS_SOURCE_LABEL: Record<OpsSource, string> = {
  host: '宿主机',
  containers: '容器',
  services: '服务',
  api: '接口',
  reliability: '可靠性',
  queue: '队列',
  backup: '备份',
  deployments: '部署',
}

/** 单个模型的失败率至少到这个值、且是全站的两倍，才单独拎出来。 */
const MODEL_FAILURE_FLOOR = 0.1
/** 失败原因比上期翻倍且至少这么多次，才算激增。 */
const FAILURE_SPIKE_MIN = 10
const CLIENT_ERROR_MIN = 10

/** 跨来源的「需要处理」：先是没读到的来源与运维告警，再是生成异常，最后是前端错误。 */
export function attentionItems(input: SignalInput): AttentionItem[] {
  const { overview, ops, errors } = input
  const items: AttentionItem[] = []
  // 没读到的来源要明说，否则列表空着会被当成「一切正常」。
  if (!ops && stateOf(ops, input.opsState) === 'failed') {
    items.push({
      key: 'ops-unavailable',
      source: '运维',
      tone: 'warn',
      title: '运维快照没有读到，机器、队列与服务的状况未知',
      to: '/ops',
    })
  }
  if (!errors && stateOf(errors, input.errorsState) === 'failed') {
    items.push({
      key: 'errors-unavailable',
      source: '前端',
      tone: 'warn',
      title: '前端错误没有读到，启动失败等情况未知',
      to: '/errors',
    })
  }
  if (ops) {
    opsProblems(ops).forEach((problem, index) => {
      items.push({
        key: `ops-${index}`,
        source: OPS_SOURCE_LABEL[problem.source],
        tone: 'bad',
        title: problem.text,
        to: '/ops',
      })
    })
  }

  const totalTerminal = overview.models.reduce(
    (sum, model) => sum + model.completed + model.failed,
    0,
  )
  const totalFailed = overview.models.reduce((sum, model) => sum + model.failed, 0)
  const overall = ratio(totalFailed, totalTerminal) ?? 0
  for (const model of overview.models) {
    const terminal = model.completed + model.failed
    const rate = ratio(model.failed, terminal)
    if (rate === null || terminal < MIN_SAMPLE) continue
    if (rate < MODEL_FAILURE_FLOOR || rate < overall * 2) continue
    items.push({
      key: `model-${model.model}`,
      source: '生成',
      tone: 'warn',
      title: `${model.model} 失败率 ${percent(rate)}`,
      detail: `全站 ${percent(overall)} · ${model.failed} / ${terminal} 个任务失败`,
    })
  }

  for (const failure of overview.failures) {
    if (failure.count < FAILURE_SPIKE_MIN || failure.count < failure.previous_count * 2) continue
    items.push({
      key: `failure-${failure.error_type}`,
      source: '生成',
      tone: 'warn',
      title: `${failure.error_type} 失败比上期多 ${failure.count - failure.previous_count} 次`,
      detail: `本期 ${failure.count} 次 · 上期 ${failure.previous_count} 次`,
    })
  }

  if (errors) {
    // 用全量汇总：分组列表只有次数最多的前 100 组，启动失败可能不在里面。
    const bootCount = errors.summary.boot_events
    if (bootCount > 0) {
      items.push({
        key: 'frontend-boot',
        source: '前端',
        tone: 'warn',
        title: `${bootCount} 次启动失败，用户看到「工作台暂时无法打开」`,
        detail: '前端错误页里按原因查看',
        to: '/errors',
      })
    }
    for (const group of errors.groups.filter((one) => one.kind !== 'boot').slice(0, 2)) {
      if (group.count < CLIENT_ERROR_MIN) continue
      items.push({
        key: `frontend-${group.fingerprint}`,
        source: '前端',
        tone: 'warn',
        title: group.name ? `${group.name}: ${group.message}` : group.message,
        detail: `${group.count} 次 · ${group.devices} 台设备`,
        to: '/errors',
      })
    }
  }
  return items
}
