import type { AgentQueuedMessageView, AgentTurnEvent } from '@image-playground/shared'

/**
 * 排队列表：智能体忙时发出、还没被处理的消息，存在服务端。面板手上的这一份由快照起头、
 * 由事件与发送/撤回的响应增减；按 id 幂等，重放同一条事件落到同一个结果上。
 */

/** 收进一条；已经在列表里的不重复加。 */
export function addQueuedMessage(
  queue: readonly AgentQueuedMessageView[],
  message: AgentQueuedMessageView,
): AgentQueuedMessageView[] {
  return queue.some((one) => one.id === message.id) ? [...queue] : [...queue, message]
}

export function removeQueuedMessage(
  queue: readonly AgentQueuedMessageView[],
  queueId: string,
): AgentQueuedMessageView[] {
  return queue.filter((one) => one.id !== queueId)
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
      return queue.some((one) => one.id === event.queueId)
        ? removeQueuedMessage(queue, event.queueId)
        : queue
    default:
      return queue
  }
}
