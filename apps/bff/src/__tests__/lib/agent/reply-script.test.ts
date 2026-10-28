import { describe, expect, it } from 'bun:test'
import type { AgentMessageView } from '@image-playground/shared'
import {
  createReplyScriptGate,
  REPLY_SCRIPT_FALLBACK_EN,
  REPLY_SCRIPT_FALLBACK_ZH,
  sanitizeAssistantMessages,
  sanitizeReplyText,
  stripDisallowedScripts,
} from '../../../lib/agent/reply-script'

const USER_ZH = '把第二张改成夜景'
const USER_EN = 'Make the second image a night scene'
const LEAK = 'પરિણામ'
const BUG =
  '已提交 1 次改图：第二张蓝色玻璃杯改为夜景光照，其它内容保持不变。પરિણામ会显示在产物卡片中。'
const BUG_CLEAN =
  '已提交 1 次改图：第二张蓝色玻璃杯改为夜景光照，其它内容保持不变。会显示在产物卡片中。'

function message(
  role: 'user' | 'assistant',
  text: string,
  turnId: string,
  id = `${role}-${turnId}`,
): AgentMessageView {
  return { id, turnId, role, content: [{ type: 'text', text }], createdAt: 1 }
}

describe('sanitizeReplyText', () => {
  it('removes a Gujarati word leaked into a Chinese reply (BUG-22)', () => {
    expect(sanitizeReplyText(BUG, USER_ZH)).toBe(BUG_CLEAN)
    expect(sanitizeReplyText(BUG, USER_ZH)).not.toMatch(/\p{Script=Gujarati}/u)
  })

  it('keeps Chinese, English, model names, numbers, emoji, and image markdown', () => {
    const text = '用 gpt-image-2 出 2 张。看 ![夜景](agent_abc) 👍 café。'
    expect(sanitizeReplyText(text, USER_ZH)).toBe(text)
    expect(sanitizeReplyText('Updated image 2 with gpt-image-2.', USER_EN)).toBe(
      'Updated image 2 with gpt-image-2.',
    )
  })

  it('drops other writing systems unless the user already used them', () => {
    for (const word of ['はこちら', '결과', 'परिणाम', 'النتيجة', 'результат', 'ผลลัพธ์']) {
      expect(sanitizeReplyText(`结果 ${word} 完`, USER_ZH)).toBe('结果 完')
    }
    expect(sanitizeReplyText(`你写的 ${LEAK} 我按原样保留。`, `这句里有 ${LEAK}`)).toBe(
      `你写的 ${LEAK} 我按原样保留。`,
    )
  })

  it('collapses the space left by a removed word and leaves other whitespace alone', () => {
    expect(
      sanitizeReplyText(`Updated the second image. ${LEAK} will show on the card.`, USER_EN),
    ).toBe('Updated the second image. will show on the card.')
    expect(sanitizeReplyText('1. 夜景\n   - 细节', USER_ZH)).toBe('1. 夜景\n   - 细节')
  })

  it('keeps Latin and Chinese code, and still strips a foreign word inside it', () => {
    const fenced = '看这段：\n```\nconst label = "night"\n```\n外面的句子。'
    expect(sanitizeReplyText(fenced, USER_ZH)).toBe(fenced)
    expect(sanitizeReplyText('代码 `const n = 2` 原样。', USER_ZH)).toBe(
      '代码 `const n = 2` 原样。',
    )
    expect(sanitizeReplyText(`代码 \`${LEAK}\` 原样，外面的${LEAK}去掉。`, USER_ZH)).toBe(
      '代码 `` 原样，外面的去掉。',
    )
  })

  it('replaces a reply that is entirely an unexpected script, including leftover punctuation', () => {
    expect(sanitizeReplyText(LEAK, USER_ZH)).toBe(REPLY_SCRIPT_FALLBACK_ZH)
    expect(sanitizeReplyText(`${LEAK}。`, USER_ZH)).toBe(REPLY_SCRIPT_FALLBACK_ZH)
    expect(sanitizeReplyText(`\n${LEAK}`, USER_ZH)).toBe(REPLY_SCRIPT_FALLBACK_ZH)
    expect(sanitizeReplyText(LEAK, USER_EN)).toBe(REPLY_SCRIPT_FALLBACK_EN)
    expect(sanitizeReplyText('', USER_ZH)).toBe('')
    expect(sanitizeReplyText('   ', USER_ZH)).toBe('   ')
    expect(sanitizeReplyText('。', USER_ZH)).toBe('。')
    expect(sanitizeReplyText(`2${LEAK}`, USER_ZH)).toBe('2')
    expect(sanitizeReplyText(`16:9${LEAK}`, USER_ZH)).toBe('16:9')
    expect(sanitizeReplyText(`👍${LEAK}`, USER_ZH)).toBe('👍')
  })

  it('is idempotent and stable when streamed one code point at a time', () => {
    const once = sanitizeReplyText(BUG, USER_ZH)
    expect(sanitizeReplyText(once, USER_ZH)).toBe(once)
    const samples = [
      BUG,
      `Updated the second image. ${LEAK} will show on the card.`,
      `代码 \`${LEAK}\` 原样。`,
      `${LEAK}。`,
      LEAK,
      '用 gpt-image-2 出 2 张。',
    ]
    for (const sample of samples) {
      const user = sample.startsWith('Updated') ? USER_EN : USER_ZH
      const gate = createReplyScriptGate(user)
      let streamed = ''
      for (const char of sample) streamed += gate.push(char)
      streamed += gate.finish()
      expect(streamed).toBe(sanitizeReplyText(sample, user))
      expect(gate.text()).toBe(streamed)
    }
  })

  it('does not drop the rest of a line when a foreign word is split inside inline code', () => {
    const parts = ['`const label = "', LEAK, '"', '` 原样。']
    const gate = createReplyScriptGate(USER_ZH)
    let streamed = ''
    for (const part of parts) streamed += gate.push(part)
    streamed += gate.finish()
    expect(streamed).toBe('`const label = ""` 原样。')
    expect(gate.text()).toBe(streamed)
  })

  it('holds punctuation until a real letter arrives, and does not invent a fallback when told not to', () => {
    const held = createReplyScriptGate(USER_ZH)
    expect(held.push('。')).toBe('')
    expect(held.push('会显示')).toBe('。会显示')
    expect(held.finish()).toBe('')

    const stopped = createReplyScriptGate(USER_ZH)
    expect(stopped.push(LEAK)).toBe('')
    expect(stopped.finish(false)).toBe('')
    expect(stopped.text()).toBe('')
  })

  it('does not break a surrogate pair split across deltas', () => {
    const raw = '好👍'
    const gate = createReplyScriptGate(USER_ZH)
    const mid = raw.indexOf('👍') + 1
    expect(gate.push(raw.slice(0, mid)) + gate.push(raw.slice(mid)) + gate.finish()).toBe(raw)
  })
})

describe('stripDisallowedScripts', () => {
  it('drops a leaked word without substituting the fallback sentence', () => {
    expect(stripDisallowedScripts(LEAK, USER_ZH)).toBe('')
    expect(stripDisallowedScripts(BUG, USER_ZH)).toBe(BUG_CLEAN)
  })
})

describe('sanitizeAssistantMessages', () => {
  it('cleans an old assistant reply using the loaded user text', () => {
    const messages = [message('user', USER_ZH, 't1'), message('assistant', BUG, 't1')]
    const cleaned = sanitizeAssistantMessages(messages)
    expect(cleaned[0]).toBe(messages[0])
    expect(cleaned[1]?.content[0]).toMatchObject({ type: 'text', text: BUG_CLEAN })
    expect(sanitizeAssistantMessages(cleaned)).toBe(cleaned)
  })

  it('keeps a script any loaded user message used, and strips it when none did', () => {
    const quoted = `按你写的 ${LEAK} 来。`
    const kept = sanitizeAssistantMessages([
      message('user', `这句里有 ${LEAK}`, 't1'),
      message('assistant', quoted, 't2', 'assistant-t2'),
    ])
    expect(kept[1]?.content[0]).toMatchObject({ text: quoted })
    const stripped = sanitizeAssistantMessages([
      message('user', USER_ZH, 't2'),
      message('assistant', quoted, 't2', 'assistant-t2'),
    ])
    expect(stripped[1]?.content[0]).toMatchObject({ text: '按你写的 来。' })
  })
})
