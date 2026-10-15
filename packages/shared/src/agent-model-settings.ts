import type { AgentThinkingDepth } from './agent'

/** Product depth and model reasoning effort are independent settings. */
export const AGENT_PROFILE_KEYS = ['default', 'fast', 'medium', 'deep'] as const
export type AgentProfileKey = AgentThinkingDepth | 'default'
export const MODEL_REASONING_LEVELS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const
export type ModelReasoningLevel = (typeof MODEL_REASONING_LEVELS)[number]
export const AGENT_PROVIDER_APIS = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
] as const
export type AgentProviderApi = (typeof AGENT_PROVIDER_APIS)[number]

export interface AgentConfiguredModel {
  id: string
  name: string
  api: AgentProviderApi
  contextWindow: number
  maxTokens: number
  imageInput: boolean
  reasoningLevels: ModelReasoningLevel[]
}

export interface AgentProviderSettings {
  id: string
  name: string
  /** Pi built-in provider ID, or custom. */
  template: string
  baseUrl: string
  /** Environment variable name only. Empty is reserved for the existing gateway. */
  secretRef: string
  models: AgentConfiguredModel[]
}

export interface AgentThinkingProfile {
  providerId: string
  modelId: string
  reasoning: ModelReasoningLevel
}

export interface AgentModelSettings {
  providers: AgentProviderSettings[]
  profiles: Record<AgentProfileKey, AgentThinkingProfile>
}

export interface AgentProviderTemplate {
  id: string
  name: string
  baseUrl: string
  models: AgentConfiguredModel[]
}

export interface AgentModelSettingsView {
  revision: number
  settings: AgentModelSettings
  templates: AgentProviderTemplate[]
  credentialReady: Record<string, boolean>
}
