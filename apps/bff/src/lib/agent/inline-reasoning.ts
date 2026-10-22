import {
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
} from '@earendil-works/pi-ai'
import { splitInlineReasoning } from '@image-playground/shared'

type Block = AssistantMessage['content'][number]
type TextBlock = Extract<Block, { type: 'text' }>
type ThinkingBlock = Extract<Block, { type: 'thinking' }>
type Slot = TextBlock | ThinkingBlock

/**
 * 一个上游正文块拆成几块：开头没有推理标签就原样一块；有就是 thinking 在前、正文（有字才有）在后。
 * thinking 不带签名：pi 回放时只把带推理字段签名的 thinking 送回上游，这一段不会再进请求。
 */
function splitText(block: TextBlock, tags: readonly string[], finished: boolean): Slot[] {
  const split = splitInlineReasoning(block.text, tags, finished)
  if (split.state === 'pending') return []
  if (split.state === 'plain') return [block]
  const thinking: ThinkingBlock = { type: 'thinking', thinking: split.thinking }
  return split.text ? [thinking, { ...block, text: split.text }] : [thinking]
}

/** 整条消息改写：每个正文块按开头拆分，其余块原样。`finished` 判断某个正文块是否已写完。 */
function rewriteContent(
  content: readonly Block[],
  tags: readonly string[],
  finished: (index: number) => boolean,
): { content: Block[]; offsets: number[] } {
  const out: Block[] = []
  const offsets: number[] = []
  for (const [index, block] of content.entries()) {
    offsets.push(out.length)
    if (block.type === 'text') out.push(...splitText(block, tags, finished(index)))
    else out.push(block)
  }
  return { content: out, offsets }
}

/** 已写完的消息直接改写；用于流的终帧，也用于读回修复前存下的原生历史。 */
export function rewriteInlineReasoning(
  message: AssistantMessage,
  tags: readonly string[],
): AssistantMessage {
  if (!message.content.some((block) => block.type === 'text')) return message
  return { ...message, content: rewriteContent(message.content, tags, () => true).content }
}

function slotText(slot: Slot): string {
  return slot.type === 'text' ? slot.text : slot.thinking
}

/**
 * 包住一条上游流：正文开头的推理标签改成 thinking 事件与 thinking 块，正文事件只带真正的回复。
 * 下游（pi 的 agent loop、我们的 turn）看到的就像上游本来就把推理放在推理通道里一样。
 */
export function withInlineReasoning(
  upstream: AssistantMessageEventStream,
  tags: readonly string[],
): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream()
  /** 每个上游正文块已经下发到哪：各输出块的类型与已发出的文字。 */
  const sent = new Map<number, { type: Slot['type']; text: string; ended: boolean }[]>()
  const finished = new Set<number>()
  let content: readonly Block[] = []

  let last: AssistantMessage | undefined

  const view = (partial: AssistantMessage) => {
    last = partial
    content = partial.content
    const rewritten = rewriteContent(content, tags, (index) => finished.has(index))
    return { partial: { ...partial, content: rewritten.content }, offsets: rewritten.offsets }
  }

  /** 把上游第 `index` 块（正文）当前的拆分结果和已发出的对齐，补发差量。 */
  const flushText = (index: number, partial: AssistantMessage, end: boolean) => {
    const block = content[index]
    if (block?.type !== 'text') return
    const { partial: rewritten, offsets } = view(partial)
    const slots = splitText(block, tags, finished.has(index))
    const base = offsets[index] ?? 0
    const state = sent.get(index) ?? []
    sent.set(index, state)
    for (const [position, slot] of slots.entries()) {
      const contentIndex = base + position
      const text = slotText(slot)
      let current = state[position]
      if (!current) {
        // 正文块出现之前，前面那块 thinking 已经写完。
        const previous = state[position - 1]
        if (previous && !previous.ended) {
          previous.ended = true
          output.push({
            type: 'thinking_end',
            contentIndex: contentIndex - 1,
            content: previous.text,
            partial: rewritten,
          })
        }
        current = { type: slot.type, text: '', ended: false }
        state.push(current)
        output.push({ type: `${slot.type}_start`, contentIndex, partial: rewritten })
      }
      if (text.length > current.text.length) {
        const delta = text.slice(current.text.length)
        current.text = text
        output.push({ type: `${slot.type}_delta`, contentIndex, delta, partial: rewritten })
      }
    }
    if (!end) return
    for (const [position, current] of state.entries()) {
      if (current.ended) continue
      current.ended = true
      output.push({
        type: `${current.type}_end`,
        contentIndex: base + position,
        content: current.text,
        partial: rewritten,
      })
    }
  }

  /** 后面的块开始了，前面没收尾的正文块就不会再长：按写完处理。 */
  const settleBefore = (index: number, partial: AssistantMessage) => {
    for (const [earlier, block] of partial.content.entries()) {
      if (earlier >= index) break
      if (block.type !== 'text' || finished.has(earlier)) continue
      finished.add(earlier)
      content = partial.content
      flushText(earlier, partial, true)
    }
  }

  const finalMessage = (message: AssistantMessage) => {
    settleBefore(message.content.length, message)
    return rewriteInlineReasoning(message, tags)
  }

  void (async () => {
    try {
      for await (const event of upstream) {
        switch (event.type) {
          case 'start':
            output.push({ ...event, partial: view(event.partial).partial })
            break
          case 'text_start':
          case 'text_delta':
          case 'text_end': {
            settleBefore(event.contentIndex, event.partial)
            if (event.type === 'text_end') finished.add(event.contentIndex)
            content = event.partial.content
            flushText(event.contentIndex, event.partial, event.type === 'text_end')
            break
          }
          case 'done':
            output.push({ ...event, message: finalMessage(event.message) })
            break
          case 'error':
            output.push({ ...event, error: finalMessage(event.error) })
            break
          default: {
            settleBefore(event.contentIndex, event.partial)
            const { partial, offsets } = view(event.partial)
            output.push({
              ...event,
              contentIndex: offsets[event.contentIndex] ?? event.contentIndex,
              partial,
            } as AssistantMessageEvent)
          }
        }
      }
      output.end(rewriteInlineReasoning(await upstream.result(), tags))
    } catch (error) {
      // 上游流按契约不抛；万一抛了，照 pi 的约定编成一个错误终帧，下游不会一直等下去。
      if (!last) {
        output.end()
        return
      }
      output.push({
        type: 'error',
        reason: 'error',
        error: {
          ...rewriteInlineReasoning(last, tags),
          stopReason: 'error',
          errorMessage: error instanceof Error ? error.message : String(error),
        },
      })
    }
  })()
  return output
}
