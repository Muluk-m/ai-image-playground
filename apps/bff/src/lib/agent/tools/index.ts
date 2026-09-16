import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { AgentToolName } from '@image-playground/shared'
import type { AgentImageSource } from '../images'
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

/** 工具起跑时画布要先占几个位；0 即这个工具不落画布。 */
export function agentToolOutputCount(name: string, args: unknown): number {
  return find(name)?.outputCount?.(args) ?? 0
}

/** 工具起跑时就能算出的锚点画布对象 id：占位框贴着它放。取不到就让画布落在视口中央。 */
export function agentToolAnchor(
  name: string,
  args: unknown,
  images: AgentImageSource,
): string | undefined {
  const spoken = find(name)?.anchor?.(args)
  return spoken ? images.identify(spoken) : undefined
}
