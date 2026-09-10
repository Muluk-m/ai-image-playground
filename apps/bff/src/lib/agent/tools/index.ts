import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { AgentToolName } from '@image-playground/shared'
import { generateImage } from './generateImage'
import type { AgentToolContext, AgentToolDefinition } from './types'

export type { AgentToolContext, AgentToolDetails } from './types'

/** 工具注册表。改图、生视频、读素材库各自往这里追加一条，轮的事件漏斗不必跟着改。 */
const TOOLS: readonly AgentToolDefinition[] = [generateImage]

const byName = new Map(TOOLS.map((tool) => [tool.name, tool]))

export function agentTools(context: AgentToolContext): AgentTool[] {
  return TOOLS.map((tool) => tool.create(context))
}

export function isAgentToolName(name: string): name is AgentToolName {
  return byName.has(name as AgentToolName)
}

export function agentToolTitle(name: string, args: unknown): string {
  return byName.get(name as AgentToolName)?.title(args) ?? name
}
