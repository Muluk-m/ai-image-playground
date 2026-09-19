import { describe, expect, it } from 'bun:test'
import type {
  AgentMessageView,
  AgentStoredReference,
  AgentTurnReference,
} from '@image-playground/shared'

// 只拼文字，一句 SQL 都不发；库名故意不可达，真连上就会立刻炸出来。
process.env.DATABASE_URL = 'postgres://unused/turn-authorization'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'

// 动态引入：环境要先钉死，再让捕获配置的模块加载。
const { createTurnAuthorization, turnAuthorizationText } = await import(
  '../../../lib/agent/turn-authorization'
)

const COVER: AgentTurnReference = {
  imageId: 'img-1',
  dataUrl: 'data:image/png;base64,AAAA',
  name: '封面',
}

const ARMREST: AgentTurnReference = {
  imageId: 'img-a',
  dataUrl: 'data:image/png;base64,BBBB',
}

/** 历史里的引用早就落了盘，形状与输入框里刚附上的那种不同；清单的拼法一样。 */
const STORED_ARMREST: AgentStoredReference = {
  imageId: 'img-a',
  image: { object: 'agent/c/t/0/image', mime: 'image/png' },
}

/** 期望值里的引用清单逐字写出来，不复用被测代码的拼法。 */
const COVER_MANIFEST =
  '\n\n可用参考图（工具参数使用图片 id，不要把编号当 id）：\n[image 1] 封面，图片 id img-1'

const ARMREST_MANIFEST =
  '\n\n可用参考图（工具参数使用图片 id，不要把编号当 id）：\n[image 1] 图片 id img-a'

function userMessage(
  id: string,
  content: AgentMessageView['content'],
  createdAt = 1,
): AgentMessageView {
  return { id, turnId: 'turn-old', role: 'user', content, createdAt }
}

function assistantMessage(
  id: string,
  content: AgentMessageView['content'],
  createdAt = 1,
): AgentMessageView {
  return { id, turnId: 'turn-old', role: 'assistant', content, createdAt }
}

function clarification(
  question: string,
  options: readonly string[],
): AgentMessageView['content'][0] {
  return { type: 'clarification', question, options }
}

/** 已经收尾的一轮：用户原话 + 助手的工具结果。 */
const COMPLETED: AgentMessageView[] = [
  userMessage('m1', [{ type: 'text', text: '把猫改成狗' }]),
  assistantMessage('m2', [
    {
      type: 'toolResult',
      toolCallId: 'call-1',
      toolName: 'editImage',
      status: 'succeeded',
      title: '改图',
      artifacts: [
        {
          media: 'image',
          artifactId: 'art-1',
          taskId: 'task-1',
          outputIndex: 0,
          mime: 'image/png',
        },
      ],
    },
  ]),
]

describe('turnAuthorizationText', () => {
  it('authorizes only this turn when there is no history', () => {
    expect(turnAuthorizationText([], '把背景换成海边', [])).toBe('把背景换成海边')
    expect(turnAuthorizationText([], '把背景换成海边', [COVER])).toBe(
      `把背景换成海边${COVER_MANIFEST}`,
    )
  })

  it('leaves a completed turn out of this turn authorization', () => {
    expect(turnAuthorizationText(COMPLETED, '再来一张', [])).toBe('再来一张')
  })

  it('carries an unfinished clarification chain into this turn authorization', () => {
    const history = [
      userMessage('m1', [
        { type: 'text', text: '只换扶手，颜色和背景不变', references: [STORED_ARMREST] },
      ]),
      // 助手的那句话不是授权，只有澄清摘要进原文。
      assistantMessage('m2', [
        { type: 'text', text: '我需要先确认参考图' },
        clarification('参考图是哪张？', ['用这张', '换一张']),
      ]),
    ]
    expect(turnAuthorizationText(history, '用这个', [COVER])).toBe(
      `只换扶手，颜色和背景不变${ARMREST_MANIFEST}\n向用户提问：参考图是哪张？（选项：用这张 / 换一张）\n用这个${COVER_MANIFEST}`,
    )
  })

  it('walks a multi-step clarification chain back to where it started', () => {
    const history = [
      userMessage('m1', [{ type: 'text', text: '做一张海报' }]),
      assistantMessage('m2', [clarification('要什么风格？', ['插画', '摄影'])]),
      userMessage('m3', [{ type: 'text', text: '插画' }]),
      assistantMessage('m4', [clarification('横版还是竖版？', ['横版', '竖版'])]),
    ]
    expect(turnAuthorizationText(history, '竖版', [])).toBe(
      '做一张海报\n向用户提问：要什么风格？（选项：插画 / 摄影）\n插画\n向用户提问：横版还是竖版？（选项：横版 / 竖版）\n竖版',
    )
  })

  it('stops at the completed turn that sits before the chain', () => {
    const history = [
      ...COMPLETED,
      userMessage('m3', [{ type: 'text', text: '再做一张海报' }]),
      assistantMessage('m4', [clarification('要什么风格？', ['插画', '摄影'])]),
    ]
    expect(turnAuthorizationText(history, '插画', [])).toBe(
      '再做一张海报\n向用户提问：要什么风格？（选项：插画 / 摄影）\n插画',
    )
  })
})

describe('createTurnAuthorization', () => {
  it('appends an interjection as a supplement and bumps the revision', () => {
    const authorization = createTurnAuthorization({
      history: [],
      prompt: '把背景换成海边',
      references: [],
    })
    const initial = authorization.current()
    expect(initial).toEqual({ revision: 0, instructions: '把背景换成海边' })
    // 身份就是版本：工具取了快照才认得出原文被改过。
    expect(authorization.current()).toBe(initial)

    authorization.amend('再亮一点', [])
    expect(authorization.current()).toEqual({
      revision: 1,
      instructions: '把背景换成海边\n用户补充：再亮一点',
    })
    expect(authorization.current()).not.toBe(initial)
  })

  it('keeps stacking supplements when the user interjects twice', () => {
    const authorization = createTurnAuthorization({
      history: [],
      prompt: '把背景换成海边',
      references: [],
    })
    authorization.amend('再亮一点', [])
    authorization.amend('也换个字体', [])
    expect(authorization.current()).toEqual({
      revision: 2,
      instructions: '把背景换成海边\n用户补充：再亮一点\n用户补充：也换个字体',
    })
  })

  it('spells the supplement reference list the way this turn prompt spells its own', () => {
    const authorization = createTurnAuthorization({
      history: [],
      prompt: '改一下扶手',
      references: [ARMREST],
    })
    authorization.amend('参考这张', [COVER])
    expect(authorization.current()).toEqual({
      revision: 1,
      instructions: `改一下扶手${ARMREST_MANIFEST}\n用户补充：参考这张${COVER_MANIFEST}`,
    })
  })
})
