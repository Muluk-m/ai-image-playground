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

export interface AgentModelBinding {
  providerId: string
  modelId: string
  reasoning: ModelReasoningLevel
}

/** Primary model for a product depth. `fallback` runs once if that model overloads before output. */
export interface AgentThinkingProfile extends AgentModelBinding {
  fallback?: AgentModelBinding
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

/** Other provider credentials must use the dedicated AGENT_PROVIDER_*_API_KEY namespace. */
export const AGENT_PROVIDER_SECRET_REFS = [
  'UPSTREAM_API_KEY',
  'UPSTREAM_OPENAI_API_KEY',
  'UPSTREAM_CLAUDE_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENROUTER_API_KEY',
  'DEEPSEEK_API_KEY',
  'GROQ_API_KEY',
  'XAI_API_KEY',
  'GROK_API_KEY',
  'MISTRAL_API_KEY',
] as const

export interface AgentModelSettingsView {
  validationError?: string

  revision: number
  settings: AgentModelSettings
  templates: AgentProviderTemplate[]
  credentialReady: Record<string, boolean>
}
