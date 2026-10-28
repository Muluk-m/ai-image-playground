import { describe, expect, it } from 'bun:test'
import type { AgentMessageView } from '@image-playground/shared'
import {
  collectUserReplyText,
  compileReplyScripts,
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
    const gate = createReplyScriptGate(USER_ZH)
    let streamed = ''
    for (const char of BUG) streamed += gate.push(char)
    expect(streamed + gate.finish()).toBe(BUG_CLEAN)
  })

  it('keeps Japanese and Korean when the user wrote in that script', () => {
    const userJa = '二枚目を夜景にして'
    const replyJa = '二枚目を夜景の光に変えます。他はそのままです。'
    expect(sanitizeReplyText(replyJa, userJa)).toBe(replyJa)
    expect(sanitizeReplyText(`夜景に変えます。${LEAK}そのまま出ます。`, userJa)).toBe(
      '夜景に変えます。そのまま出ます。',
    )
    expect(sanitizeReplyText('ナイトにします。', 'ナイトにして')).toBe('ナイトにします。')
    expect(sanitizeReplyText('夜景に変えます。야경', userJa)).toBe('夜景に変えます。야경')

    const userKo = '두 번째 사진을 야경으로 바꿔 주세요'
    const replyKo = '두 번째 사진을 야경 조명으로 바꿨습니다. 나머지는 그대로입니다.'
    expect(sanitizeReplyText(replyKo, userKo)).toBe(replyKo)
    expect(sanitizeReplyText(`야경으로 바꿨습니다. ${LEAK} 카드에 나옵니다.`, userKo)).toBe(
      '야경으로 바꿨습니다. 카드에 나옵니다.',
    )
  })

  it('keeps kana and hangul when a Chinese user asks for that language (BUG-76)', () => {
    const user = '用日语回答。请用日文写两句。'
    expect(sanitizeReplyText('ポケモンを見る。', user)).toBe('ポケモンを見る。')
    expect(sanitizeReplyText('見る', user)).toBe('見る')
    expect(
      sanitizeReplyText('昼光を夜の照明に変え、街灯と建物の明かりで夜の雰囲気を出す。', user),
    ).toBe('昼光を夜の照明に変え、街灯と建物の明かりで夜の雰囲気を出す。')
    expect(sanitizeReplyText('야경으로 바꿨습니다.', '用中文说明')).toBe('야경으로 바꿨습니다.')
  })

  it('keeps Greek letters used as symbols (BUG-77)', () => {
    const text = '保留 α 通道，γ 校正 2.2，μm'
    expect(sanitizeReplyText(text, USER_ZH)).toBe(text)
  })

  it('keeps a full reply in a script the user has used, and still strips Gujarati (script allow)', () => {
    const userRu = 'Привет'
    const replyRu = 'Как дела? Я помогу с ночным светом.'
    expect(sanitizeReplyText(replyRu, userRu)).toBe(replyRu)
    const userAr = 'مرحبا'
    const replyAr = 'كيف حالك؟'
    expect(sanitizeReplyText(replyAr, userAr)).toBe(replyAr)
    expect(sanitizeReplyText(`已提交。${LEAK}会显示。`, USER_ZH)).toBe('已提交。会显示。')
    expect(sanitizeReplyText(`${replyRu} ${LEAK}`, userRu)).toBe(`${replyRu} `)
  })

  it('reuses the script set from the start of the turn instead of recomputing each chunk', () => {
    const allowance = compileReplyScripts('Привет')
    const gate = createReplyScriptGate('用中文', allowance)
    const reply = 'Как дела'
    let streamed = ''
    for (const char of reply) streamed += gate.push(char)
    expect(streamed + gate.finish()).toBe(reply)
  })

  it('keeps Chinese, English, model names, numbers, emoji, and image markdown', () => {
    const text = '用 gpt-image-2 出 2 张。看 ![夜景](agent_abc) 👍 café。'
    expect(sanitizeReplyText(text, USER_ZH)).toBe(text)
    expect(sanitizeReplyText('Updated image 2 with gpt-image-2.', USER_EN)).toBe(
      'Updated image 2 with gpt-image-2.',
    )
  })

  it('drops leaked scripts unless the user already used them (BUG-22)', () => {
    for (const word of ['परिणाम', 'النتيجة', 'результат', 'ผลลัพธ์', 'Հայերեն']) {
      expect(sanitizeReplyText(`结果 ${word} 完`, USER_ZH)).toBe('结果 完')
    }
    expect(sanitizeReplyText('结果 はこちら 결과 完', USER_ZH)).toBe('结果 はこちら 결과 完')
    expect(sanitizeReplyText('结果 ߊ 完', USER_ZH)).toBe('结果 完')
    expect(sanitizeReplyText('结果 ߊ 完', '用户写了 ߊ')).toBe('结果 ߊ 完')
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

  it('does not garble a character split across stream chunks', () => {
    // 👍 和扩展区汉字都是两个 UTF-16 码元。分片切在中间时，拼回去必须仍是原来的字。
    const text = `已提交。${LEAK}会显示。好👍𠀋`
    const cleaned = sanitizeReplyText(text, USER_ZH)
    expect(cleaned).toBe('已提交。会显示。好👍𠀋')
    expect(cleaned).not.toContain('\uFFFD')
    for (let at = 0; at <= text.length; at += 1) {
      const gate = createReplyScriptGate(USER_ZH)
      const streamed = gate.push(text.slice(0, at)) + gate.push(text.slice(at)) + gate.finish()
      expect(streamed).toBe(cleaned)
      expect(streamed).not.toContain('\uFFFD')
    }
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

  it('strips a leaked word on the same turn, and leaves another turn alone when its user text is missing', () => {
    const kana = 'そのままです。'
    const onlyAssistant = [message('assistant', kana, 't1')]
    expect(sanitizeAssistantMessages(onlyAssistant)).toBe(onlyAssistant)
    const otherTurn = [message('user', USER_ZH, 't2'), message('assistant', kana, 't1')]
    expect(sanitizeAssistantMessages(otherTurn)[1]?.content[0]).toMatchObject({ text: kana })
    const sameTurn = [
      message('user', USER_ZH, 't1'),
      message('assistant', `${LEAK}。`, 't1', 'assistant-leak'),
    ]
    expect(sanitizeAssistantMessages(sameTurn)[1]?.content[0]).toMatchObject({ text: '。' })
  })

  it('keeps a leak the user wrote in an earlier turn when refreshing a later reply (BUG-75)', () => {
    const quoted = `按你写的 ${LEAK} 来。`
    const japanese = '夜の街灯や建物の明かりで人物をやわらかく照らします。'
    const messages = [
      message('user', `这句里有 ${LEAK}`, 't1'),
      message('assistant', '先记下。', 't1'),
      message('user', '继续，用日语简单说明你会怎么处理灯光。', 't2'),
      message('assistant', japanese, 't2', 'assistant-t2'),
      message('assistant', quoted, 't2', 'assistant-quote'),
    ]
    const cleaned = sanitizeAssistantMessages(messages)
    expect(cleaned[3]?.content[0]).toMatchObject({ text: japanese })
    expect(cleaned[4]?.content[0]).toMatchObject({ text: quoted })
    const userText = collectUserReplyText(messages)
    expect(sanitizeReplyText(quoted, userText)).toBe(quoted)
    expect(sanitizeReplyText(japanese, userText)).toBe(japanese)
    // 只看本轮中文时，古吉拉特文仍会删掉；历史读回必须带上前一轮，才和直播一致。
    expect(sanitizeReplyText(quoted, '继续，用日语简单说明你会怎么处理灯光。')).toBe(
      '按你写的 来。',
    )
  })

  it('keeps a script any loaded user message used, and strips it when none did', () => {
    const quoted = `按你写的 ${LEAK} 来。`
    const kept = sanitizeAssistantMessages([
      message('user', `这句里有 ${LEAK}`, 't1'),
      message('assistant', quoted, 't1', 'assistant-t1'),
    ])
    expect(kept[1]?.content[0]).toMatchObject({ text: quoted })
    const stripped = sanitizeAssistantMessages([
      message('user', USER_ZH, 't2'),
      message('assistant', quoted, 't2', 'assistant-t2'),
    ])
    expect(stripped[1]?.content[0]).toMatchObject({ text: '按你写的 来。' })
  })
})
