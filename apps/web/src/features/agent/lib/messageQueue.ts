import {
  AGENT_TURN_MAX_REFERENCES,
  type AgentQueuedMessageView,
  type AgentReturnedQueuedMessage,
  type AgentTurnEvent,
} from '@image-playground/shared'
import type { AgentDraft, AgentReference } from './references'

/**
 * 排队列表：智能体忙时发出、还没被处理的消息，存在服务端。面板手上的这一份由快照起头、
 * 由事件与发送/撤回的响应增减；按 id 幂等，重放同一条事件落到同一个结果上。
 */

/** 收进一条；已经在列表里的不重复加。澄清答复排在其他排队消息前面，与服务端的处理顺序一致。 */
export function addQueuedMessage(
  queue: readonly AgentQueuedMessageView[],
  message: AgentQueuedMessageView,
): AgentQueuedMessageView[] {
  if (queue.some((one) => one.id === message.id)) return [...queue]
  if (!message.clarificationAnswer) return [...queue, message]
  const at = queue.findIndex((one) => !one.clarificationAnswer)
  return at < 0 ? [...queue, message] : [...queue.slice(0, at), message, ...queue.slice(at)]
}

/**
 * 停止时服务端退回的排队消息放回输入框：接在草稿已有的话后面，一条一段；参考图原样附回，
 * 草稿里已有的同一张不重复附。
 */
export function returnQueuedToDraft(
  draft: AgentDraft,
  returned: readonly AgentReturnedQueuedMessage[],
): AgentDraft {
  if (returned.length === 0) return draft
  const prompt = [draft.prompt.trim() ? draft.prompt : null, ...returned.map((one) => one.text)]
    .filter((one): one is string => one !== null)
    .join('\n\n')
  const references: AgentReference[] = [...draft.references]
  for (const reference of returned.flatMap((one) => one.references)) {
    if (references.length >= AGENT_TURN_MAX_REFERENCES) break
    if (references.some((one) => one.id === reference.imageId)) continue
    references.push({
      id: reference.imageId,
      dataUrl: reference.dataUrl,
      ...(reference.name ? { name: reference.name } : {}),
      ...(reference.maskDataUrl ? { maskDataUrl: reference.maskDataUrl } : {}),
    })
  }
  return { ...draft, prompt, references }
}

export function removeQueuedMessage(
  queue: readonly AgentQueuedMessageView[],
  queueId: string,
): AgentQueuedMessageView[] {
  return queue.filter((one) => one.id !== queueId)
}

/**
 * 队里还有等着被处理的消息吗。轮到时没能开轮的那几条（带 `failure`）不算：它们不会再被处理，
 * 只是留着让用户看见原因。
 */
export function hasWaitingMessages(queue: readonly AgentQueuedMessageView[]): boolean {
  return queue.some((one) => one.failure === undefined)
}

/** 与排队无关的事件原样还回同一份列表，调用方据此判断要不要更新。 */
export function reduceMessageQueue(
  queue: readonly AgentQueuedMessageView[],
  event: AgentTurnEvent,
): readonly AgentQueuedMessageView[] {
  switch (event.type) {
    case 'messageQueued':
      return queue.some((one) => one.id === event.message.id)
        ? queue
        : addQueuedMessage(queue, event.message)
    case 'queuedMessageWithdrawn':
    case 'queuedMessageConsumed':
    case 'queuedMessageInterjected':
      return queue.some((one) => one.id === event.queueId)
        ? removeQueuedMessage(queue, event.queueId)
        : queue
    default:
      return queue
  }
}
