import { describe, expect, it } from 'bun:test'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { AgentMessageView, AgentTurnReference } from '@image-playground/shared'
import sharp from 'sharp'

// 只装配文字与占位图片块，一句 SQL 都不发；库名故意不可达，真连上就会立刻炸出来。
process.env.DATABASE_URL = 'postgres://unused/turn-input'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
// 运营配置用出厂默认（出参预留 20000、缓冲 13000），封顶因此是 40000 - 500 - 13000 = 26500。
process.env.AGENT_CHAT_CONTEXT_WINDOW = '40000'
process.env.AGENT_CHAT_MAX_TOKENS = '500'

// 动态引入：环境要先钉死，再让捕获配置的模块加载。
const {
  estimateTurnInputTokens,
  estimatedTurnInput,
  turnInitialState,
  turnModelPrompt,
  turnPromptText,
  turnVisualEvidence,
} = await import('../../../lib/agent/turn-input')

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

const PLAIN: AgentTurnReference = {
  imageId: 'img-1',
  dataUrl: 'data:image/png;base64,AAAA',
  name: '封面',
}

const MASKED: AgentTurnReference = {
  imageId: 'img-2',
  dataUrl: 'data:image/png;base64,BBBB',
  maskDataUrl: 'data:image/png;base64,CCCC',
}

/** 多轮历史：用户原话、工具结果、澄清各占一条，回放的三种形状都在里面。 */
const RICH_HISTORY: AgentMessageView[] = [
  userMessage('m1', [{ type: 'text', text: '把这张图的背景换成海边' }]),
  assistantMessage(
    'm2',
    [
      {
        type: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'generateImage',
        status: 'succeeded',
        title: '生成图片',
        artifacts: [
          {
            artifactId: 'art-1',
            media: 'image',
            taskId: 'task-1',
            outputIndex: 0,
            mime: 'image/png',
          },
        ],
      },
    ],
    2,
  ),
  assistantMessage(
    'm3',
    [{ type: 'clarification', question: '要保留人物姿势吗？', options: ['保留', '可以调整'] }],
    3,
  ),
  userMessage('m4', [{ type: 'text', text: '保留' }], 4),
]

/** 历史里带着上一批引用（存储形态，且有遮罩）；本轮不附图时编号仍指这一批。 */
const OLD_REFERENCE_HISTORY: AgentMessageView[] = [
  userMessage('o1', [
    {
      type: 'text',
      text: '改这张',
      references: [
        {
          imageId: 'old-1',
          image: { object: 'agent/c/t/0/image', mime: 'image/png' },
          mask: { object: 'agent/c/t/0/mask', mime: 'image/png' },
        },
      ],
    },
  ]),
  assistantMessage('o2', [{ type: 'text', text: '好的' }], 2),
]

/** 长到必然撞上压缩阈值的历史。 */
const LONG_HISTORY: AgentMessageView[] = Array.from({ length: 40 }, (_, index) =>
  userMessage(`l${index}`, [{ type: 'text', text: '海边的日落'.repeat(600) }]),
)

/**
 * 预扣估算的特征化基线。数字本身没有语义，它们钉住的是「这一份输入怎么装配」：
 * 系统提示词、工具清单、回放拼法、每个引用折算几个图片块、封顶取压缩阈值。
 * 有意改口径时这些数字会一起变，改之前先想清楚线上冻结的积分会跟着变。
 */
describe('estimateTurnInputTokens', () => {
  it('counts the system prompt and this turn text when there is no history', () => {
    expect(estimateTurnInputTokens([], '画一只坐着的橘猫', [])).toBe(324)
  })

  it('replays tool results and clarifications from a multi-turn history', () => {
    expect(estimateTurnInputTokens(RICH_HISTORY, '再来一张', [])).toBe(339)
  })

  it('charges one image block for a plain reference', () => {
    expect(estimateTurnInputTokens([], '换成夜景', [PLAIN])).toBe(1537)
  })

  it('charges three image blocks for a masked reference', () => {
    expect(estimateTurnInputTokens([], '换成夜景', [MASKED])).toBe(3952)
  })

  it('adds the blocks of every active reference', () => {
    expect(estimateTurnInputTokens([], '换成夜景', [PLAIN, MASKED])).toBe(5159)
  })

  it('falls back to the last batch of references in history when this turn attaches none', () => {
    expect(estimateTurnInputTokens(OLD_REFERENCE_HISTORY, '再改一次', [])).toBe(3983)
  })

  it('numbers only this turn references when the turn attaches its own', () => {
    expect(estimateTurnInputTokens(OLD_REFERENCE_HISTORY, '再改一次', [PLAIN])).toBe(1568)
  })

  it('caps a long history at the compaction threshold', () => {
    expect(estimateTurnInputTokens(LONG_HISTORY, '继续', [])).toBe(26_500)
  })
})

function textOf(message: AgentMessage): string {
  if (!('content' in message)) return ''
  const content = message.content
  if (typeof content === 'string') return content
  const first = content[0]
  return first?.type === 'text' ? first.text : ''
}

function imageBlocks(message: AgentMessage): number {
  if (!('content' in message)) return 0
  const content = message.content
  return typeof content === 'string' ? 0 : content.filter((block) => block.type === 'image').length
}

async function png(pixels: number[], width = 2): Promise<string> {
  const buffer = await sharp(Buffer.from(pixels), { raw: { width, height: 1, channels: 4 } })
    .png()
    .toBuffer()
  return `data:image/png;base64,${buffer.toString('base64')}`
}

const REAL_PLAIN = { imageId: 'img-1', dataUrl: await png([255, 0, 0, 255, 0, 255, 0, 255]) }
const REAL_MASKED = {
  ...REAL_PLAIN,
  imageId: 'img-2',
  maskDataUrl: await png([0, 0, 0, 0, 0, 0, 0, 255]),
}

/** 估算路径与实发路径必须同形；不同形的地方要在这里写明白，别等它悄悄变成漂移。 */
describe('estimated and sent turn input', () => {
  it('opens with the same system prompt the agent starts from', () => {
    const estimated = estimatedTurnInput(RICH_HISTORY, '再来一张', [])
    expect(textOf(estimated[0]!)).toBe(turnInitialState(RICH_HISTORY).systemPrompt)
  })

  it('replays history exactly as the agent initial state does', () => {
    const estimated = estimatedTurnInput(RICH_HISTORY, '再来一张', [])
    expect(estimated.slice(1, -1)).toEqual(turnInitialState(RICH_HISTORY).messages)
  })

  it('writes this turn prompt text the same way on both paths', () => {
    const estimated = estimatedTurnInput([], '换成夜景', [PLAIN, MASKED])
    expect(textOf(estimated.at(-1)!)).toBe(turnPromptText('换成夜景', [PLAIN, MASKED]))
  })

  it('charges the same number of image blocks the sent evidence carries', async () => {
    const evidence = await turnVisualEvidence([REAL_PLAIN, REAL_MASKED])
    const estimated = estimatedTurnInput([], '换成夜景', [PLAIN, MASKED])
    expect(imageBlocks(estimated.at(-1)!)).toBe(evidence.content.length)
    expect(evidence.content).toHaveLength(4)
  })

  it('leaves the visual evidence manifest out of the estimate', async () => {
    // 口径差异，见 PR 说明：实发 prompt 末尾带着视觉证据清单，预扣不为它估 token。
    const evidence = await turnVisualEvidence([REAL_MASKED])
    const promptText = turnPromptText('换成夜景', [MASKED])
    const sent = turnModelPrompt(promptText, evidence)
    expect(sent.text.startsWith(promptText)).toBe(true)
    expect(sent.text).not.toBe(promptText)
    expect(textOf(estimatedTurnInput([], '换成夜景', [MASKED]).at(-1)!)).toBe(promptText)
  })
})
