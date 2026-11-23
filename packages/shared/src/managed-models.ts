import type { AgentProfileKey } from './agent-model-settings'

/** 后台「模型」页的一行。上下架归公开库；单价归收费模块，由它自己往这一行上补。 */
export type ManagedModelKind = 'image' | 'video' | 'chat'

export interface ManagedChannelModelSummary {
  id: string
  label: string
  media: 'image' | 'video'
  capabilities: readonly string[]
  maxConcurrency?: number
  etaSeconds?: number
  degraded?: boolean
}

export interface ManagedChannelSummary {
  id: string
  label: string
  kind: 'openai-queue' | 'gemini-queue'
  status: 'active' | 'unconfigured' | 'disabled'
  authType: 'bearer' | 'query-key'
  secretRef: string
  secretConfigured: boolean
  maxConcurrency?: number
  asyncTasks: boolean
  timeoutSeconds?: number
  models: ManagedChannelModelSummary[]
}

export interface ManagedModel {
  id: string
  label: string
  kind: ManagedModelKind
  active: boolean
  /** 有值即系统自动暂停：上游没有可用账号，补上容量后由运营恢复。 */
  pause_reason: 'upstream_unavailable' | null
  paused_at: number | null
  /** 归属的上游渠道或 Agent Provider 名称与 ID（不含上游地址或密钥明文）。 */
  source_label?: string
  source_id?: string
  secret_ref?: string
  secret_configured?: boolean
  capabilities?: readonly string[]
  context_window?: number
  max_tokens?: number
  max_concurrency?: number
  eta_seconds?: number
  agent_profiles?: readonly AgentProfileKey[]
}

export interface ManagedModelsView {
  models: ManagedModel[]
  channels?: ManagedChannelSummary[]
}

export interface AgentModelProbeResult {
  ok: boolean
  status: 'ok' | 'unconfigured' | 'failed'
  latencyMs: number
  message?: string
}
