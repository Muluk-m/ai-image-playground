import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { AgentToolName } from '@image-playground/shared'
import { editImage } from './editImage'
import { generateImage } from './generateImage'
import { generateVideo } from './generateVideo'
import { readLibrary } from './readLibrary'
import type { AgentToolContext, AgentToolDefinition } from './types'

export type { AgentToolContext, AgentToolDetails } from './types'

const TOOLS: readonly AgentToolDefinition[] = [generateImage, editImage, readLibrary, generateVideo]

function find(name: string): AgentToolDefinition | undefined {
  return TOOLS.find((tool) => tool.name === name)
}

export function agentTools(context: AgentToolContext): AgentTool[] {
  return TOOLS.filter((tool) => tool.available?.() ?? true).map((tool) => tool.create(context))
}

export function isAgentToolName(name: string): name is AgentToolName {
  return find(name) !== undefined
}

/** 这个部署有没有开这条工具。系统提示词据此增删对应的那句话。 */
export function isAgentToolAvailable(name: AgentToolName): boolean {
  const tool = find(name)
  return tool ? (tool.available?.() ?? true) : false
}

export function agentToolTitle(name: string, args: unknown): string {
  return find(name)?.title(args) ?? name
}

export function agentToolAbortsTurn(name: string): boolean {
  return find(name)?.onError === 'abort'
}
