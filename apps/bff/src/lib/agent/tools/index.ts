import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { AgentToolName } from '@image-playground/shared'
import { generateImage } from './generateImage'
import type { AgentToolContext, AgentToolDefinition } from './types'

export type { AgentToolContext, AgentToolDetails } from './types'

const TOOLS: readonly AgentToolDefinition[] = [generateImage]

function find(name: string): AgentToolDefinition | undefined {
  return TOOLS.find((tool) => tool.name === name)
}

export function agentTools(context: AgentToolContext): AgentTool[] {
  return TOOLS.map((tool) => tool.create(context))
}

export function isAgentToolName(name: string): name is AgentToolName {
  return find(name) !== undefined
}

export function agentToolTitle(name: string, args: unknown): string {
  return find(name)?.title(args) ?? name
}

export function agentToolAbortsTurn(name: string): boolean {
  return find(name)?.onError === 'abort'
}
