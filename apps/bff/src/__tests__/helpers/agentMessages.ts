import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { contentText } from '@earendil-works/pi-ai'
import type { CompactionMessage } from '../../lib/agent/compaction'

/** pi 的估算是 ceil(chars/4)，所以 400 字符正好 100 token。 */
export function body(marker: string): string {
  return marker.repeat(400)
}

export function user(id: string, text: string): CompactionMessage {
  return { id, message: { role: 'user', content: [{ type: 'text', text }], timestamp: 1 } }
}

export function assistant(id: string, text: string): CompactionMessage {
  return assistantReporting(id, text, 0)
}

/**
 * 带上游真实用量的助手回复。压缩的触发判据拿它当下界（见 `compaction.ts` 的
 * `contextSizeTokens`），所以想钉住「上游报的数也算数」就得造这种消息。
 */
export function assistantReporting(
  id: string,
  text: string,
  totalTokens: number,
): CompactionMessage {
  return {
    id,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      api: 'openai-completions',
      provider: 'p',
      model: 'm',
      usage: {
        input: totalTokens,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp: 1,
    },
  }
}

export function toolResult(id: string, text: string): CompactionMessage {
  return {
    id,
    message: {
      role: 'toolResult',
      toolCallId: id,
      toolName: 'generate_image',
      content: [{ type: 'text', text }],
      isError: false,
      timestamp: 1,
    },
  }
}

export function textOf(message: AgentMessage): string {
  return 'content' in message ? contentText(message.content, '') : ''
}
