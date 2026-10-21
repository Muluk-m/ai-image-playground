import { type HostSample, OPS_THRESHOLDS, type OpsRestoreDrill } from './ops'

/**
 * 告警判断。纯函数：不碰网络、不碰数据库、不读时钟。去重与恢复是最容易写错的两块，
 * 写成这样才能被完整地测到。采集容器（宿主机两条）与 worker（应用四条）共用这一份。
 *
 * 只有少数几条「不处理就会出事故」的固定规则，阈值与运维看板变红的线是同一组常量。
 */

export type AlertRule =
  | 'disk'
  | 'memory'
  | 'queue'
  | 'backup'
  | 'restore'
  | 'heartbeat:bff'
  | 'api'
  | 'generation'
  | 'agent'
  | 'agent-pattern'
  | 'blind'
  | 'reconciling'

/**
 * 这一轮看到的现状。某一块没取到就别给它：缺失既不触发，也不会被当成已恢复。
 * 里面的 `null` 表示「取到了，但还从来没有过」（没有任何备份、没演练过、没见过心跳），同样不告警——
 * 新部署的头一天本来就是这样，看板会照实显示。已经在报的规则例外：报过「备份过期」之后桶被清空、
 * 报过「心跳中断」之后那一行被清理掉，读数同样变成 `null`，那是还没好，不是从来没有过。
 *
 * 没有 worker 的心跳：发应用告警的就是 worker，它挂了这条也发不出来。
 */
export interface AlertObservation {
  host?: HostSample
  queue?: { oldest_queued_wait_ms: number | null }
  backup?: { latest_modified_at: number | null }
  restoreDrill?: OpsRestoreDrill | null
  heartbeats?: { bff?: number | null }
  api?: {
    requests: number
    server_errors: number
    errors_by_minute: Record<string, number>
    successes_by_minute: Record<string, number>
    error_routes: Record<string, number>
  }
  failures?: { generation_system: number; agent: number }
  /**
   * 近 6 小时每一类 Agent 轮次失败（模型、错误码、上游状态码各算一类）。
   * 没有失败时为 null 或空数组。整块没取到就不要给这个字段。
   */
  agentFailurePatterns?: readonly AgentFailurePattern[] | null
  /** 连续若干轮取不到读数的块，由调用方按轮次累计。 */
  blindBlocks?: ReadonlyArray<{ block: string; rounds: number }>
}

export interface AgentFailurePattern {
  model: string
  code: string
  /** 上游 HTTP 状态码；报错里认不出时为 null。 */
  upstreamStatus: number | null
  turns: number
  lastAt: number
  /** 最近一次的报错，已截断。 */
  message: string
}

/**
 * 用户自己的输入问题：上下文过长、请求体过大、图片不合法。
 * 改模型配置不会让它消失，不能当成「配置被上游拒绝」。
 * 文案取自请求预算、出站字节闸和上游图片拒绝里已经出现的写法。
 */
const USER_INPUT_MESSAGE =
  /input tokens, over the|缩小共同查看范围|UTF-8 bytes|the local limit is|invalid[_ ]image|unsupported image|could not be processed|不是图片|context[_ ]length|maximum context length|prompt too long/i

/** 部署把限额配坏、请求体无法计量：正文要求联系运营，不是用户那张图的问题。 */
const OPERATOR_BUDGET_MESSAGE =
  /contact the operator|byte limit is invalid|cannot be measured safely/i

/** 参数或鉴权类的上游拒绝。裸的 400/404/`unsupported` 不够，用户输入也常带着这些字。 */
const CONFIG_MESSAGE =
  /invalid_request_error|invalid value|model_not_found|unsupported (?:value|parameter|model|field)|unknown parameter|invalid api key|incorrect api key/i

export function isUserInputFailure(pattern: AgentFailurePattern): boolean {
  if (pattern.code === 'agent_context_overflow') return true
  if (pattern.code === 'agent_request_budget_exceeded')
    return !OPERATOR_BUDGET_MESSAGE.test(pattern.message)
  return USER_INPUT_MESSAGE.test(pattern.message)
}

/** 参数或鉴权类的上游拒绝：重试不会自己好，只能改配置，出现一次就报。 */
export function isConfigurationFailure(pattern: AgentFailurePattern): boolean {
  if (isContentPolicyFailure(pattern) || isUserInputFailure(pattern)) return false
  if (pattern.upstreamStatus === 401 || pattern.upstreamStatus === 403) return true
  if (OPERATOR_BUDGET_MESSAGE.test(pattern.message)) return true
  return CONFIG_MESSAGE.test(pattern.message)
}

/** 内容策略拒绝是用户那条提示词的问题，不是服务事故。 */
export function isContentPolicyFailure(pattern: AgentFailurePattern): boolean {
  return /content_policy/i.test(pattern.code) || /content_policy/i.test(pattern.message)
}

interface RuleState {
  /** 越线从什么时候开始的；回到线内就清掉。 */
  breachedSince: number | null
  /** 已经发过「触发」且还没发过「已恢复」。 */
  firing: boolean
  lastSentAt: number | null
}

interface ApiRuleState extends RuleState {
  coveredErrors: Record<string, number>
  recoverySince: number | null
  successesAtTrigger: Record<string, number>
}

/** 一类失败自己的状态。键是模型、错误码和上游状态码，互不覆盖。 */
export interface AgentPatternGroupState extends RuleState {
  model: string
  code: string
  upstreamStatus: number | null
}

export type AlertState = Partial<Record<Exclude<AlertRule, 'api'>, RuleState>> & {
  api?: ApiRuleState
  agentPatterns?: Record<string, AgentPatternGroupState>
}

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

function readings(
  observation: AlertObservation,
  state: AlertState,
  now: number,
): Partial<Record<AlertRule, Reading>> {
  const out: Partial<Record<AlertRule, Reading>> = {}
  const { host, queue, backup, restoreDrill, heartbeats, failures } = observation

  if (observation.blindBlocks) {
    const blind = observation.blindBlocks.filter(
      (one) => one.rounds >= OPS_THRESHOLDS.ALERT_BLIND_ROUNDS,
    )
    out.blind = {
      breached: blind.length > 0,
      sustainMs: 0,
      firingText: `告警读数连续取不到，对应规则暂时失效：${blind.map((one) => `${one.block}（${one.rounds} 轮）`).join('、')}`,
      resolvedText: '已恢复：告警读数恢复正常',
    }
  }

  if (failures) {
    out.generation = {
      breached: failures.generation_system >= OPS_THRESHOLDS.GENERATION_SYSTEM_FAILURES,
      sustainMs: 0,
      firingText: `近 15 分钟有 ${failures.generation_system} 次非内容策略的生成失败`,
      resolvedText: '已恢复：生成系统失败回到告警线内',
    }
    out.agent = {
      breached: failures.agent >= OPS_THRESHOLDS.AGENT_TURN_FAILURES,
      sustainMs: 0,
      firingText: `近 15 分钟有 ${failures.agent} 次 Agent 轮次失败`,
      resolvedText: '已恢复：Agent 轮次失败回到告警线内',
    }
  }

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
    const critical = available < OPS_THRESHOLDS.MEMORY_CRITICAL_RATIO
    out.memory = {
      breached: available < OPS_THRESHOLDS.MEMORY_AVAILABLE_RATIO,
      recovered:
        available >=
        OPS_THRESHOLDS.MEMORY_AVAILABLE_RATIO + OPS_THRESHOLDS.HOST_RECOVERY_MARGIN_RATIO,
      // 快见底时不等持续期：机器可能一分钟后就卡死，那时谁也发不出消息了。
      sustainMs: critical ? 0 : OPS_THRESHOLDS.MEMORY_SUSTAIN_MS,
      firingText: critical
        ? `可用内存只剩 ${percent(available)}（${gb(host.mem_available_bytes)}），快要耗尽，机器随时可能卡死（立即告警线 ${percent(OPS_THRESHOLDS.MEMORY_CRITICAL_RATIO)}）`
        : `可用内存只剩 ${percent(available)}（${gb(host.mem_available_bytes)}），已持续 ${span(OPS_THRESHOLDS.MEMORY_SUSTAIN_MS)}以上（告警线 ${percent(OPS_THRESHOLDS.MEMORY_AVAILABLE_RATIO)}）`,
      resolvedText: `已恢复：可用内存 ${percent(available)}`,
    }
  }

  if (queue) {
    const wait = queue.oldest_queued_wait_ms
    out.queue = {
      breached: wait !== null && wait > OPS_THRESHOLDS.QUEUE_WAIT_MS,
      sustainMs: 0,
      firingText: `最老的可运行排队任务已经等了 ${span(wait ?? 0)}（告警线 ${span(OPS_THRESHOLDS.QUEUE_WAIT_MS)}）`,
      resolvedText: '已恢复：可运行队列不再积压',
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
  } else if (backup && state.backup?.firing) {
    out.backup = {
      breached: true,
      sustainMs: 0,
      firingText: '备份前缀下已经找不到任何数据库备份',
      resolvedText: '已恢复：有了新的数据库备份',
    }
  }

  if (restoreDrill) {
    const age = now - restoreDrill.finished_at
    out.restore = {
      breached: !restoreDrill.ok || age > OPS_THRESHOLDS.RESTORE_DRILL_MAX_AGE_MS,
      sustainMs: 0,
      firingText: restoreDrill.ok
        ? `数据库备份恢复演练已经 ${span(age)}没有跑了（告警线 ${span(OPS_THRESHOLDS.RESTORE_DRILL_MAX_AGE_MS)}）`
        : `数据库备份恢复演练失败：${restoreDrill.error ?? '没有写明原因'}`,
      resolvedText: '已恢复：数据库备份恢复演练通过',
    }
  } else if (restoreDrill === null && state.restore?.firing) {
    out.restore = {
      breached: true,
      sustainMs: 0,
      firingText: '备份前缀下已经找不到备份恢复演练的结果',
      resolvedText: '已恢复：数据库备份恢复演练通过',
    }
  }

  if (heartbeats?.bff != null) {
    out['heartbeat:bff'] = heartbeatReading('后端', heartbeats.bff, now)
  } else if (heartbeats && state['heartbeat:bff']?.firing) {
    // 断得够久，旧心跳那一行已经被清理掉了。
    out['heartbeat:bff'] = {
      breached: true,
      sustainMs: 0,
      firingText: '后端的心跳一直没有回来，连上一次的记录都已经过期清掉了',
      resolvedText: '已恢复：后端的心跳回来了',
    }
  }
  return out
}

function patternKey(
  pattern: Pick<AgentFailurePattern, 'model' | 'code' | 'upstreamStatus'>,
): string {
  return `${pattern.model}\u0000${pattern.code}\u0000${pattern.upstreamStatus ?? ''}`
}

function patternText(pattern: AgentFailurePattern, configuration: boolean): string {
  return `${configuration ? 'Agent 模型配置被上游拒绝' : '同一类 Agent 失败反复出现'}：${pattern.model} 近 ${span(OPS_THRESHOLDS.AGENT_FAILURE_PATTERN_WINDOW_MS)}有 ${pattern.turns} 轮以 ${pattern.code}${pattern.upstreamStatus ? `（HTTP ${pattern.upstreamStatus}）` : ''} 失败；最近一次：${pattern.message}`
}

function stepRule(
  rule: AlertRule,
  reading: Reading,
  previous: RuleState | undefined,
  now: number,
): { state: RuleState; messages: AlertMessage[] } {
  const prior = previous ?? { breachedSince: null, firing: false, lastSentAt: null }
  // 报过的规则停在告警线与恢复线之间时，按「还没好」处理：不发已恢复，到点照常再提醒。
  const breached = reading.breached || (prior.firing && !(reading.recovered ?? !reading.breached))
  if (!breached) {
    return {
      state: { breachedSince: null, firing: false, lastSentAt: null },
      messages: prior.firing ? [{ rule, kind: 'resolved', text: reading.resolvedText }] : [],
    }
  }
  const breachedSince = prior.breachedSince ?? now
  const due =
    now - breachedSince >= reading.sustainMs &&
    (!prior.firing || prior.lastSentAt === null || now - prior.lastSentAt >= REMIND_AFTER_MS)
  return {
    state: {
      breachedSince,
      firing: prior.firing || due,
      lastSentAt: due ? now : prior.lastSentAt,
    },
    messages: due ? [{ rule, kind: 'firing', text: reading.firingText }] : [],
  }
}

/** 每一类失败单独记状态。读数整块缺失时原样留下，不把还在报的类说成已恢复。 */
function evaluateAgentPatterns(
  patterns: readonly AgentFailurePattern[] | null | undefined,
  previous: Record<string, AgentPatternGroupState> | undefined,
  now: number,
): { state: Record<string, AgentPatternGroupState>; messages: AlertMessage[] } {
  if (patterns === undefined) return { state: previous ?? {}, messages: [] }
  const active = new Map<string, AgentFailurePattern>()
  for (const pattern of patterns ?? []) {
    if (isContentPolicyFailure(pattern)) continue
    if (now - pattern.lastAt > OPS_THRESHOLDS.AGENT_FAILURE_PATTERN_QUIET_MS) continue
    active.set(patternKey(pattern), pattern)
  }
  const state: Record<string, AgentPatternGroupState> = {}
  const messages: AlertMessage[] = []
  for (const key of new Set([...Object.keys(previous ?? {}), ...active.keys()])) {
    const pattern = active.get(key) ?? null
    const prior = previous?.[key]
    const configuration = pattern !== null && isConfigurationFailure(pattern)
    const identity = pattern ?? prior
    if (!identity) continue
    const stepped = stepRule(
      'agent-pattern',
      {
        breached:
          pattern !== null &&
          (configuration || pattern.turns >= OPS_THRESHOLDS.AGENT_FAILURE_PATTERN_TURNS),
        // 静默窗口内这组还在，轮次暂时跌破阈值也不算恢复。组从窗口里消失才发已恢复。
        recovered: pattern === null,
        sustainMs: 0,
        firingText: pattern ? patternText(pattern, configuration) : '',
        resolvedText: `已恢复：${identity.model} 的同类 Agent 失败（${identity.code}）${span(OPS_THRESHOLDS.AGENT_FAILURE_PATTERN_QUIET_MS)}内没有再出现`,
      },
      prior,
      now,
    )
    messages.push(...stepped.messages)
    if (stepped.state.firing || stepped.state.breachedSince !== null) {
      state[key] = {
        ...stepped.state,
        model: identity.model,
        code: identity.code,
        upstreamStatus: identity.upstreamStatus,
      }
    }
  }
  return { state, messages }
}

function evaluateApi(
  api: NonNullable<AlertObservation['api']>,
  previous: ApiRuleState | undefined,
  now: number,
): { state: ApiRuleState; messages: AlertMessage[] } {
  const state: ApiRuleState = previous
    ? { ...previous }
    : {
        breachedSince: null,
        firing: false,
        lastSentAt: null,
        coveredErrors: {},
        recoverySince: null,
        successesAtTrigger: {},
      }
  state.coveredErrors = Object.fromEntries(
    Object.entries(state.coveredErrors).filter(
      ([minute]) => Number(minute) >= now - OPS_THRESHOLDS.API_RECENT_WINDOW_MS,
    ),
  )
  const newErrors = Object.entries(api.errors_by_minute).some(
    ([minute, count]) => count > (state.coveredErrors[minute] ?? 0),
  )
  const ratio = api.requests > 0 ? api.server_errors / api.requests : 0
  const breached =
    api.server_errors >= OPS_THRESHOLDS.API_SERVER_ERROR_ABSOLUTE ||
    (api.requests >= OPS_THRESHOLDS.API_MIN_REQUESTS_FOR_RATIO &&
      ratio > OPS_THRESHOLDS.API_SERVER_ERROR_RATIO)
  const messages: AlertMessage[] = []
  const due =
    breached &&
    (state.firing
      ? state.lastSentAt === null || now - state.lastSentAt >= REMIND_AFTER_MS
      : newErrors)
  if (due) {
    const routes = Object.entries(api.error_routes)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([route, count]) => `${route} × ${count}`)
      .join('；')
    messages.push({
      rule: 'api',
      kind: 'firing',
      text: `近 15 分钟用户接口 ${api.server_errors}/${api.requests} 次返回 5xx（${(ratio * 100).toFixed(2)}%）${routes ? `；${routes}` : ''}`,
    })
    if (!state.firing) state.successesAtTrigger = { ...api.successes_by_minute }
    state.firing = true
    state.breachedSince ??= now
    state.lastSentAt = now
  }
  if (state.firing) {
    // Keep the high-water count for each minute: a shrinking denominator is not a new incident.
    for (const [minute, count] of Object.entries(api.errors_by_minute))
      state.coveredErrors[minute] = Math.max(state.coveredErrors[minute] ?? 0, count)
    const healthy =
      api.server_errors < OPS_THRESHOLDS.API_SERVER_ERROR_ABSOLUTE &&
      ratio < OPS_THRESHOLDS.API_RECOVERY_RATIO &&
      (api.server_errors === 0 || api.requests >= OPS_THRESHOLDS.API_MIN_REQUESTS_FOR_RATIO) &&
      Object.entries(api.successes_by_minute).some(
        ([minute, count]) =>
          Number(minute) + 60_000 > (state.breachedSince ?? now) &&
          count > (state.successesAtTrigger[minute] ?? 0),
      )
    state.recoverySince = healthy ? (state.recoverySince ?? now) : null
    if (
      state.recoverySince !== null &&
      now - state.recoverySince >= OPS_THRESHOLDS.API_RECOVERY_SUSTAIN_MS
    ) {
      messages.push({
        rule: 'api',
        kind: 'resolved',
        text: '已恢复：近 15 分钟用户接口 5xx 持续 2 分钟低于 3%，且已有成功请求',
      })
      state.firing = false
      state.breachedSince = null
      state.lastSentAt = null
      state.recoverySince = null
    }
  }
  return { state, messages }
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
  if (observation.api) {
    const api = evaluateApi(observation.api, state.api, now)
    next.api = api.state
    messages.push(...api.messages)
  } else if (state.api) {
    next.api = { ...state.api, recoverySince: null }
  }

  if (observation.agentFailurePatterns !== undefined) {
    const patterns = evaluateAgentPatterns(
      observation.agentFailurePatterns,
      state.agentPatterns,
      now,
    )
    next.agentPatterns = patterns.state
    messages.push(...patterns.messages)
  }

  for (const [rule, reading] of Object.entries(readings(observation, state, now)) as Array<
    [Exclude<AlertRule, 'api'>, Reading]
  >) {
    const stepped = stepRule(rule, reading, state[rule], now)
    messages.push(...stepped.messages)
    next[rule] = stepped.state
  }

  return { messages, state: next }
}
