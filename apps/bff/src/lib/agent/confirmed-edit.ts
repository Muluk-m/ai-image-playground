import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  type Model,
  type ToolCall,
} from '@earendil-works/pi-ai'
import type { AgentMessageView, AgentTurnReference } from '@image-playground/shared'
import type { AgentImageSource } from './images'
import { maskProposalAnswer } from './mask-proposal'
import { imageSelection } from './selection-preview'

/**
 * 用户在范围确认卡上点了「确认并生成」：要改哪张图、改什么、蒙版都已经定了，这一轮的
 * 第一次模型调用只会把它们抄进 editImage。所以这一步不问模型，按提议直接拼出那次调用
 * （执行指令仍由服务端按用户原文与选区生成，见 `masked-edit.ts`）。
 *
 * 只认最干净的情形：这一轮只带那一张确认过的图。多附了参考图时谁是目标、谁是参考要模型判断，
 * 照旧交给它。返回 null 就是不走这条路。
 */
export async function confirmedMaskEditCall(
  history: readonly AgentMessageView[],
  references: readonly AgentTurnReference[],
  images: Pick<AgentImageSource, 'resolve'>,
): Promise<Record<string, unknown> | null> {
  if (references.length !== 1) return null
  const answer = maskProposalAnswer(history, references)
  if (answer?.kind !== 'confirmed') return null
  const { proposal } = answer
  const image = await images.resolve(proposal.imageId, 'original')
  if (!image?.maskDataUrl) return null
  const selection = await imageSelection(image)
  if (!selection) return null
  return {
    prompt: proposal.change,
    imageIds: [proposal.imageId],
    selectionBindings: [
      { imageId: proposal.imageId, selectionId: selection.id, objects: proposal.target },
    ],
    // 保住主体、换背景时要补背景；改对象本身时要贴合原图的光照与表面。
    integration: proposal.invert ? ['background', 'lighting'] : ['lighting', 'material'],
  }
}

/** 按提议直接拼出的那次调用的 id 前缀；轮据此认出它。 */
export const CONFIRMED_EDIT_CALL_PREFIX = 'call_confirmed_'

const NO_USAGE: AssistantMessage['usage'] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

/** 一条只含一次工具调用的助手消息流，形状与上游返回的一样，pi 照常执行工具。 */
export function toolCallStream(
  model: Pick<Model<Api>, 'api' | 'provider' | 'id'>,
  name: string,
  args: Record<string, unknown>,
): AssistantMessageEventStream {
  const toolCall: ToolCall = {
    type: 'toolCall',
    id: `${CONFIRMED_EDIT_CALL_PREFIX}${crypto.randomUUID().replaceAll('-', '')}`,
    name,
    arguments: args,
  }
  const message: AssistantMessage = {
    role: 'assistant',
    content: [toolCall],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: NO_USAGE,
    stopReason: 'toolUse',
    timestamp: Date.now(),
  }
  const empty: AssistantMessage = { ...message, content: [] }
  const stream = createAssistantMessageEventStream()
  queueMicrotask(() => {
    stream.push({ type: 'start', partial: empty })
    stream.push({ type: 'toolcall_start', contentIndex: 0, partial: message })
    stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall, partial: message })
    stream.push({ type: 'done', reason: 'toolUse', message })
    stream.end(message)
  })
  return stream
}
