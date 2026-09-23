import type { AgentToolErrorCode } from '@image-playground/shared'
import {
  AGENT_RETRYABLE_ERROR_CODES,
  agentToolLocalEdit,
  agentToolRerunnable,
  agentToolRetryable,
  videoRateMultiplier,
} from '@image-playground/shared'
import { getStoredChannels } from '../../../lib/channels/channelStore'
import type { PrivateSubmissionInput } from '../../../lib/privateOverlay'
import type { AgentPanelMessage, AgentToolMessage } from '../types'
import type { AgentFailedPlaceholder } from './canvasSink'
import { agentJobUnsettled } from './jobProgress'

/**
 * 单张重试的前端判据。能不能重试只按结构化的几位判（ADR 0006）：失败占位此刻的错误码、
 * 原失败卡的资格（`agentToolRetryable`），以及快照里那个模型此刻还在不在清单上。
 */

/** 失败占位上认得出它属于哪次调用的那几位。 */
export interface AgentRetryPlaceholder {
  /** 本机占位：起跑时那张结果卡的消息 id。 */
  readonly agentMessageId?: string
  /** 云端项目的占位：服务端预留它的那个任务。 */
  readonly cloudGeneration?: { readonly id: string }
}

/** 重试被拒时盖在失败占位上的那一层：新的码，以及它盖的是哪一次云端生成。 */
export interface AgentRetryRefusal {
  readonly code: AgentToolErrorCode
  readonly generationId?: string
}

/**
 * 失败占位对应的原失败卡。重试记录不是出发点：重试失败之后占位仍指回原卡，
 * 云端项目里的占位则由重试任务接替，凭任务 id 找到的是重试记录，再顺着它回到原卡。
 */
export function agentRetryOrigin(
  messages: readonly AgentPanelMessage[],
  placeholder: AgentRetryPlaceholder,
): AgentToolMessage | null {
  const taskId = placeholder.cloudGeneration?.id
  const found = messages.find(
    (message): message is AgentToolMessage =>
      message.kind === 'tool' &&
      (placeholder.agentMessageId
        ? message.id === placeholder.agentMessageId
        : taskId !== undefined && message.job?.taskId === taskId),
  )
  if (!found?.retryOf) return found ?? null
  const origin = messages.find((message) => message.id === found.retryOf?.messageId)
  return origin?.kind === 'tool' ? origin : null
}

/** 快照里那个模型此刻还在这个部署的清单上（同一种介质）。下线了就交给智能体换个做法。 */
function modelOffered(message: AgentToolMessage): boolean {
  const model = message.snapshot?.target?.model
  const media = message.job?.media ?? 'image'
  return getStoredChannels().some((channel) =>
    channel.models.some((one) => one.id === model && (one.media ?? 'image') === media),
  )
}

/**
 * 一次跑过的生成，本该由「原样重试」收场，却重出不了的原因。
 *
 * - `local_edit`：局部改图、分方案与连锁改图的后续步骤，参数离不开那一轮的上下文，重出会改错地方。
 * - `model_gone`：当时那个模型已经不在这个部署的清单上，重出必然再失败一次。
 *
 * 认不出是哪一次生成的（旧记录没有快照、查素材库这类不出图的调用）一律 `null`：既给不出
 * 重试，也没法请智能体照着重新处理，那些失败只说原因。界面按这个原因把「让助手重新处理」
 * 摆出来，并在替用户说的那句话里讲清重出不了的到底是什么。
 */
export type AgentRerunBlock = 'local_edit' | 'model_gone'

export function agentRerunBlock(origin: AgentToolMessage): AgentRerunBlock | null {
  if (!agentToolRerunnable(origin)) return null
  if (!modelOffered(origin)) return 'model_gone'
  return agentToolLocalEdit(origin.snapshot) ? 'local_edit' : null
}

/**
 * 这个失败占位此刻能不能原样重试。占位的码以它自己的为准：一次重试被拒（积分不够）之后，
 * 占位按新的码给出路，不再出重试。
 */
export function agentRetryAvailable(
  code: AgentToolErrorCode | undefined,
  origin: AgentToolMessage | null,
): origin is AgentToolMessage {
  return (
    code !== undefined &&
    AGENT_RETRYABLE_ERROR_CODES.includes(code) &&
    origin !== null &&
    agentToolRetryable(origin) &&
    modelOffered(origin)
  )
}

/** 预估积分的计价口径：一张图，或者按快照档位的那一段视频。与服务端预扣同一个算式。 */
export function agentRetryPricing(origin: AgentToolMessage): PrivateSubmissionInput {
  const model = origin.snapshot?.target?.model ?? ''
  const video = origin.job?.video
  if (origin.job?.media === 'video' && video)
    return {
      model,
      quantity: video.duration,
      unitMultiplier: videoRateMultiplier(model, video.resolution),
    }
  return { model, quantity: 1 }
}

/** 这个占位上还排着、在跑或已经补上的那条重试；失败、中止或撤回的不算。 */
export function agentLiveRetry(
  messages: readonly AgentPanelMessage[],
  placeholderId: string,
): AgentToolMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (message.kind !== 'tool' || message.retryOf?.placeholderId !== placeholderId) continue
    if (agentJobUnsettled(message) || message.status === 'succeeded') return message
  }
  return null
}

/** 占位的码以重试被拒后盖上的那一层为准（云端占位本机改不了），它只对被拒时那次生成作数。 */
function placeholderCode(
  placeholder: AgentFailedPlaceholder,
  refusals: Readonly<Record<string, AgentRetryRefusal>>,
): AgentToolErrorCode | undefined {
  const refusal = refusals[placeholder.id]
  if (refusal && refusal.generationId === placeholder.generationId) return refusal.code
  return placeholder.errorCode
}

/**
 * 一键补齐要重试的那几个失败占位：原失败卡本身能原样重试，占位的码可重试，占位上也没有排着、
 * 在跑或已补上的重试。
 */
export function agentRetryRemaining(
  messages: readonly AgentPanelMessage[],
  origin: AgentToolMessage,
  placeholders: readonly AgentFailedPlaceholder[],
  refusals: Readonly<Record<string, AgentRetryRefusal>>,
): readonly AgentFailedPlaceholder[] {
  if (!agentRetryAvailable(origin.errorCode, origin)) return []
  return placeholders.filter((placeholder) => {
    const code = placeholderCode(placeholder, refusals)
    return (
      code !== undefined &&
      AGENT_RETRYABLE_ERROR_CODES.includes(code) &&
      agentLiveRetry(messages, placeholder.id) === null
    )
  })
}

/** 云端占位可能挂着的那几次生成：原失败卡的任务，以及在它上面提交过的重试的任务。 */
export function agentRetrySlotTasks(
  messages: readonly AgentPanelMessage[],
  origin: AgentToolMessage,
): readonly string[] {
  return messages.flatMap((message) =>
    message.kind === 'tool' &&
    message.job &&
    (message.id === origin.id || message.retryOf?.messageId === origin.id)
      ? [message.job.taskId]
      : [],
  )
}
