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
  return {
    id,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      api: 'openai-completions',
      provider: 'p',
      model: 'm',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
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
