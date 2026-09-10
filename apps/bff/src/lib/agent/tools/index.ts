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

function present(): AgentToolDefinition[] {
  return TOOLS.filter((tool) => tool.available?.() ?? true)
}

export function agentTools(context: AgentToolContext): AgentTool[] {
  return present().map((tool) => tool.create(context))
}

/** 系统提示词里逐工具的那几句。与模型收到的清单同一份过滤，两边不会各说各的。 */
export function agentToolGuidance(): string[] {
  return present().map((tool) => tool.guidance)
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
