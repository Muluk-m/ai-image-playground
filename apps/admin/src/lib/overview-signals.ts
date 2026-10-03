/**
 * 概览页（指挥台）的判断逻辑：健康灯、需要处理、环比。纯函数，不碰网络，页面只负责摆放。
 *
 * 运维相关的判断一律复用运维看板的那套问题清单（opsProblems），不另立阈值：
 * 首页亮红灯的时候，点进运维看板一定能在对应那一栏看到同一句话。
 */
import { type OpsProblem, type OpsSource, opsProblems } from '@/components/ops/OpsBoard'
import { bytes, elapsed, fuzzyTime } from '@/lib/format'
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

export interface Change {
  text: string
  /** 变化对业务是好是坏；持平或没有基线时为 neutral。 */
  sentiment: 'good' | 'bad' | 'neutral'
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

function opsTile(
  key: string,
  label: string,
  ops: OpsSnapshot | undefined,
  block: keyof Omit<OpsSnapshot, 'generated_at'>,
  problems: readonly OpsProblem[],
  read: () => { value: string; note: string },
): HealthTile {
  if (!ops) return { key, label, value: '…', note: '正在读取', tone: 'unknown', to: '/ops' }
  if (!ops[block].ok)
    return { key, label, value: '取不到', note: '运维看板里看原因', tone: 'unknown', to: '/ops' }
  const reading = read()
  return {
    key,
    label,
    value: reading.value,
    note: problems[0]?.text ?? reading.note,
    tone: problems.length ? 'bad' : 'ok',
    to: '/ops',
  }
}

export interface SignalInput {
  overview: OverviewResult
  ops?: OpsSnapshot
  errors?: ClientErrorsResult
}

export function healthTiles({ overview, ops, errors }: SignalInput): HealthTile[] {
  const problems = ops ? opsProblems(ops) : []
  const { current, previous } = overview.pulse
  const reliability = ops?.reliability.ok ? ops.reliability.data : null

  const generationRate = ratio(current.completed, current.completed + current.failed)
  const previousGenerationRate = ratio(previous.completed, previous.completed + previous.failed)
  const generationAlert = reliability
    ? sourceProblems(problems, 'reliability').filter((problem) => problem.text.includes('生成'))
    : []
  const generationDropped =
    generationRate !== null &&
    previousGenerationRate !== null &&
    current.completed + current.failed >= MIN_SAMPLE &&
    previous.completed + previous.failed >= MIN_SAMPLE &&
    generationRate < previousGenerationRate - SUCCESS_DROP
  const generation: HealthTile = {
    key: 'generation',
    label: '生成',
    value: percent(generationRate),
    note:
      generationAlert[0]?.text ??
      `成功率 · ${current.failed} 次失败 · 上期 ${percent(previousGenerationRate)}`,
    tone: generationAlert.length ? 'bad' : generationDropped ? 'warn' : 'ok',
    to: '/ops',
  }

  const agentCompleted = current.agent_turns - current.agent_failed - current.agent_aborted
  const agentRate = ratio(agentCompleted, agentCompleted + current.agent_failed)
  const agentAlert = sourceProblems(problems, 'reliability').filter((problem) =>
    problem.text.includes('Agent'),
  )
  const agent: HealthTile = {
    key: 'agent',
    label: 'Agent',
    value: percent(agentRate),
    note:
      agentAlert[0]?.text ??
      `完成率 · ${current.agent_turns} 轮 · ${current.agent_aborted} 次用户中断`,
    tone: agentAlert.length ? 'bad' : 'ok',
    to: '/ops',
  }

  const api = opsTile('api', '接口', ops, 'api', sourceProblems(problems, 'api'), () => {
    const recent = ops!.api.ok ? ops!.api.data.recent : null
    return {
      value: recent ? percent(ratio(recent.server_errors, recent.requests), 2) : '—',
      note: recent
        ? `近 15 分钟 5xx · P95 ${recent.p95_ms === null ? '—' : `${recent.p95_ms}ms`}`
        : '',
    }
  })

  const bootEvents = errors?.summary.boot_events ?? 0
  const frontend: HealthTile = errors
    ? {
        key: 'frontend',
        label: '前端',
        value: String(bootEvents),
        note: `启动失败 · 共 ${errors.summary.events} 次错误 · ${errors.summary.devices} 台设备`,
        tone: bootEvents > 0 ? 'warn' : 'ok',
        to: '/errors',
      }
    : {
        key: 'frontend',
        label: '前端',
        value: '…',
        note: '正在读取',
        tone: 'unknown',
        to: '/errors',
      }

  const queue = opsTile('queue', '队列', ops, 'queue', sourceProblems(problems, 'queue'), () => {
    const data = ops!.queue.ok ? ops!.queue.data : null
    return {
      value: data?.oldest_queued_wait_ms == null ? '空' : elapsed(data.oldest_queued_wait_ms),
      note: data ? `最老等待 · 排队 ${data.queued} · 运行中 ${data.in_progress}` : '',
    }
  })

  const services = opsTile(
    'services',
    '服务',
    ops,
    'services',
    sourceProblems(problems, 'services', 'deployments'),
    () => {
      const data = ops!.services.ok ? ops!.services.data.services : []
      return { value: `${data.length} 个实例`, note: '心跳正常' }
    },
  )

  const host = opsTile(
    'host',
    '宿主机',
    ops,
    'host',
    sourceProblems(problems, 'host', 'containers'),
    () => {
      const latest = ops!.host.ok ? ops!.host.data.latest : null
      if (!latest) return { value: '未启用', note: '没有采集容器' }
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
    'backup',
    sourceProblems(problems, 'backup'),
    () => {
      const latest = ops!.backup.ok ? ops!.backup.data.latest : null
      return latest
        ? {
            value: fuzzyTime(latest.modified_at, ops!.generated_at),
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

/** 跨来源的「需要处理」：先是运维告警，再是生成异常，最后是前端错误。 */
export function attentionItems({ overview, ops, errors }: SignalInput): AttentionItem[] {
  const items: AttentionItem[] = []
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
    const boot = errors.groups.filter((group) => group.kind === 'boot')
    const bootCount = boot.reduce((sum, group) => sum + group.count, 0)
    if (bootCount > 0) {
      const devices = boot.reduce((sum, group) => sum + group.devices, 0)
      items.push({
        key: 'frontend-boot',
        source: '前端',
        tone: 'warn',
        title: `${bootCount} 次启动失败，用户看到「工作台暂时无法打开」`,
        detail: `${devices} 台设备 · 最近一次 ${fuzzyTime(Math.max(...boot.map((group) => group.last_seen)))}`,
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
