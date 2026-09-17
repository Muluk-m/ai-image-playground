import { type HostSample, OPS_THRESHOLDS } from './ops'

/**
 * 告警判断。纯函数：不碰网络、不碰数据库、不读时钟。去重与恢复是最容易写错的两块，
 * 写成这样才能被完整地测到。采集容器（宿主机两条）与 worker（应用三条）共用这一份。
 *
 * 只有少数几条「不处理就会出事故」的固定规则，阈值与运维看板变红的线是同一组常量。
 */

export type AlertRule =
  | 'disk'
  | 'memory'
  | 'queue'
  | 'backup'
  | 'heartbeat:bff'
  | 'heartbeat:worker'

/**
 * 这一轮看到的现状。某一块没取到就别给它：缺失既不触发，也不会被当成已恢复。
 * 里面的 `null` 表示「取到了，但还从来没有过」（没有任何备份、没见过心跳），同样不告警——
 * 新部署的头一天本来就是这样，看板会照实显示。
 */
export interface AlertObservation {
  host?: HostSample
  queue?: { oldest_queued_wait_ms: number | null }
  backup?: { latest_modified_at: number | null }
  heartbeats?: { bff?: number | null; worker?: number | null }
}

interface RuleState {
  /** 越线从什么时候开始的；回到线内就清掉。 */
  breachedSince: number | null
  /** 已经发过「触发」且还没发过「已恢复」。 */
  firing: boolean
  lastSentAt: number | null
}

export type AlertState = Partial<Record<AlertRule, RuleState>>

export interface AlertMessage {
  rule: AlertRule
  kind: 'firing' | 'resolved'
  text: string
}

/** 同一条规则还没好的话，多久再提醒一次。 */
const REMIND_AFTER_MS = 60 * 60 * 1000

interface Reading {
  breached: boolean
  /** 已经在报的规则要满足这一条才算恢复；不写就是「不再越线」。 */
  recovered?: boolean
  /** 越线后要持续多久才算数。 */
  sustainMs: number
  firingText: string
  resolvedText: string
}

function gb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`
}

function span(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} 小时`
  return `${Math.floor(hours / 24)} 天`
}

function heartbeatReading(label: string, lastSeenAt: number, now: number): Reading {
  const silence = now - lastSeenAt
  return {
    breached: silence > OPS_THRESHOLDS.HEARTBEAT_MAX_AGE_MS,
    sustainMs: 0,
    firingText: `${label}的心跳已经断了 ${span(silence)}（告警线 ${span(OPS_THRESHOLDS.HEARTBEAT_MAX_AGE_MS)}）`,
    resolvedText: `已恢复：${label}的心跳回来了`,
  }
}

function readings(observation: AlertObservation, now: number): Partial<Record<AlertRule, Reading>> {
  const out: Partial<Record<AlertRule, Reading>> = {}
  const { host, queue, backup, heartbeats } = observation

  if (host) {
    const used = 1 - host.disk_available_bytes / host.disk_total_bytes
    out.disk = {
      breached: used >= OPS_THRESHOLDS.DISK_USED_RATIO,
      recovered: used < OPS_THRESHOLDS.DISK_USED_RATIO - OPS_THRESHOLDS.HOST_RECOVERY_MARGIN_RATIO,
      sustainMs: 0,
      firingText: `磁盘已用 ${percent(used)}，只剩 ${gb(host.disk_available_bytes)}（告警线 ${percent(OPS_THRESHOLDS.DISK_USED_RATIO)}）`,
      resolvedText: `已恢复：磁盘已用 ${percent(used)}`,
    }
    const available = host.mem_available_bytes / host.mem_total_bytes
    out.memory = {
      breached: available < OPS_THRESHOLDS.MEMORY_AVAILABLE_RATIO,
      recovered:
        available >=
        OPS_THRESHOLDS.MEMORY_AVAILABLE_RATIO + OPS_THRESHOLDS.HOST_RECOVERY_MARGIN_RATIO,
      sustainMs: OPS_THRESHOLDS.MEMORY_SUSTAIN_MS,
      firingText: `可用内存只剩 ${percent(available)}（${gb(host.mem_available_bytes)}），已持续 ${span(OPS_THRESHOLDS.MEMORY_SUSTAIN_MS)}以上（告警线 ${percent(OPS_THRESHOLDS.MEMORY_AVAILABLE_RATIO)}）`,
      resolvedText: `已恢复：可用内存 ${percent(available)}`,
    }
  }

  if (queue) {
    const wait = queue.oldest_queued_wait_ms
    out.queue = {
      breached: wait !== null && wait > OPS_THRESHOLDS.QUEUE_WAIT_MS,
      sustainMs: 0,
      firingText: `最老的排队任务已经等了 ${span(wait ?? 0)}（告警线 ${span(OPS_THRESHOLDS.QUEUE_WAIT_MS)}）`,
      resolvedText: '已恢复：队列不再积压',
    }
  }

  if (backup && backup.latest_modified_at !== null) {
    const age = now - backup.latest_modified_at
    out.backup = {
      breached: age > OPS_THRESHOLDS.BACKUP_MAX_AGE_MS,
      sustainMs: 0,
      firingText: `最新的数据库备份是 ${span(age)}前的（告警线 ${span(OPS_THRESHOLDS.BACKUP_MAX_AGE_MS)}）`,
      resolvedText: '已恢复：有了新的数据库备份',
    }
  }

  if (heartbeats?.bff != null) out['heartbeat:bff'] = heartbeatReading('后端', heartbeats.bff, now)
  if (heartbeats?.worker != null) {
    out['heartbeat:worker'] = heartbeatReading('worker', heartbeats.worker, now)
  }
  return out
}

/**
 * 输入这一轮的现状、上一轮留下的状态与当前时间，输出要发的消息与新状态。
 * 调用方只管把 `state` 原样传回来；放在进程内存里即可，重启后最多重发一次。
 */
export function evaluateAlerts(
  observation: AlertObservation,
  state: AlertState,
  now: number,
): { messages: AlertMessage[]; state: AlertState } {
  const next: AlertState = { ...state }
  const messages: AlertMessage[] = []

  for (const [rule, reading] of Object.entries(readings(observation, now)) as Array<
    [AlertRule, Reading]
  >) {
    const previous = state[rule] ?? { breachedSince: null, firing: false, lastSentAt: null }

    // 报过的规则停在告警线与恢复线之间时，按「还没好」处理：不发已恢复，到点照常再提醒。
    const breached =
      reading.breached || (previous.firing && !(reading.recovered ?? !reading.breached))
    if (!breached) {
      if (previous.firing) messages.push({ rule, kind: 'resolved', text: reading.resolvedText })
      next[rule] = { breachedSince: null, firing: false, lastSentAt: null }
      continue
    }

    const breachedSince = previous.breachedSince ?? now
    const sustained = now - breachedSince >= reading.sustainMs
    const due =
      sustained &&
      (!previous.firing ||
        previous.lastSentAt === null ||
        now - previous.lastSentAt >= REMIND_AFTER_MS)
    if (due) messages.push({ rule, kind: 'firing', text: reading.firingText })
    next[rule] = {
      breachedSince,
      firing: previous.firing || due,
      lastSentAt: due ? now : previous.lastSentAt,
    }
  }

  return { messages, state: next }
}
