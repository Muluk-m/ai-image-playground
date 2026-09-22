import { describe, expect, it } from 'bun:test'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { AgentMessageView, AgentTurnReference } from '@image-playground/shared'
import sharp from 'sharp'
import { estimateMessageTokens } from '../../../lib/agent/token-estimate'
import type { AgentToolDeclaration } from '../../../lib/agent/tools'

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
  estimateToolDeclarationTokens,
  estimateTurnInputTokens,
  estimatedTurnInput,
  turnInitialState,
  turnModelPrompt,
  turnPromptText,
  turnVisualEvidence,
} = await import('../../../lib/agent/turn-input')
const { agentToolDeclarations } = await import('../../../lib/agent/tools')
const { generateVideo } = await import('../../../lib/agent/tools/generateVideo')

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

/** 历史里带着上一批引用（存储形态，且有遮罩）；本轮不附图时仍只上文字清单。 */
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
 * 预扣估算的基线。断言的是相对「同一句话、不带图」的增量，所以改系统提示词或工具说明的
 * 措辞不会让它们变红；变红说明装配口径动了——每个引用折算几个图片块、引用清单怎么写、
 * 历史怎么回放、封顶取什么——改之前先想清楚线上冻结的积分会跟着变。
 *
 * 每条增量旁边写清它由哪几部分构成，好让下一个读的人自己验算：口径是 pi 的
 * 「一条消息的字符数 / 4，向上取整」再按 CJK 校正（每个 CJK 字符补 0.55，见
 * `token-estimate.ts`），一个图片块按 4800 字符计、不含 CJK。
 *
 * 这一批数字整体上移过一次：CJK 校正上线，同时空引用不再拼一个 28 字符的清单头。
 */
/** 没有折叠过的会话：估算吃的是整个窗口，这里给一份「什么都没折」的。 */
function unfolded(messages: readonly AgentMessageView[]) {
  return {
    messages,
    coveredCount: 0,
    compaction: {
      summary: null,
      anchor: null,
      verbatim: null,
      foldCount: 0,
      failureCount: 0,
      openedAt: null,
    },
  }
}

describe('estimateTurnInputTokens', () => {
  const bare = (history: readonly AgentMessageView[], text: string) =>
    estimateTurnInputTokens(unfolded(history), text, [])
  const added = (
    history: readonly AgentMessageView[],
    text: string,
    references: readonly AgentTurnReference[],
  ) => estimateTurnInputTokens(unfolded(history), text, references) - bare([], text)

  // 8 个汉字：ceil(8 / 4) = 2，再补 ceil(8 × 0.55) = 5。
  it('counts this turn text on top of the system prompt', () => {
    expect(bare([], '画一只坐着的橘猫') - bare([], '')).toBe(7)
  })

  // 四条回放：用户原话 10 + 工具结果摘要 10 + 澄清摘要 23 + 用户回答 3。
  it('replays tool results and clarifications from a multi-turn history', () => {
    expect(added(RICH_HISTORY, '再来一张', [])).toBe(46)
  })

  // 1 个图片块（4800 字符 = 1200）+ 提示词里的 `[image 1]` 引用行与整个视觉证据清单（68）。
  // 清单头现在只有带引用时才拼，所以它整块算进这条增量里。
  it('charges one image block for a plain reference', () => {
    expect(added([], '换成夜景', [PLAIN])).toBe(1268)
  })

  // 3 个图片块（14400 字符 = 3600）+ 带选区说明的引用行与带选区 ID、bounds 的清单行（182）。
  it('charges three image blocks for a masked reference', () => {
    expect(added([], '换成夜景', [MASKED])).toBe(3782)
  })

  // 上面两条各自的块与清单行加在一起（4800 字符 = 4800 + 201），清单头只写一次。
  it('adds the blocks of every active reference', () => {
    expect(added([], '换成夜景', [PLAIN, MASKED])).toBe(5001)
  })

  it('does not charge visual input blocks for historical selections', () => {
    const current = estimatedTurnInput(OLD_REFERENCE_HISTORY, '再改一次', []).at(-1)!
    expect(imageBlocks(current)).toBe(0)
  })

  it('counts only the current attachment as visual input after a masked request', () => {
    const current = estimatedTurnInput(OLD_REFERENCE_HISTORY, '再改一次', [PLAIN]).at(-1)!
    expect(imageBlocks(current)).toBe(1)
  })

  it('caps a long history at the compaction threshold', () => {
    expect(estimateTurnInputTokens(unfolded(LONG_HISTORY), '继续', [])).toBe(26_500)
  })
})

/** 模型每次请求都收到整份工具清单；预扣不算它就是漏掉本轮输入里最大的一块固定开销。 */
describe('tool declarations in the estimate', () => {
  /** 与生产同一条口径：先拿它对齐生产，再用它量视频工具那一份声明的增量。 */
  const declarationTokens = (declarations: readonly AgentToolDeclaration[]) =>
    estimateMessageTokens({
      role: 'user',
      content: [{ type: 'text', text: JSON.stringify(declarations) }],
      timestamp: 0,
    })

  it('counts the tool declarations on top of the messages', () => {
    const messages = estimatedTurnInput([], '你好', []).reduce(
      (total, message) => total + estimateMessageTokens(message),
      0,
    )
    expect(estimateTurnInputTokens(unfolded([]), '你好', []) - messages).toBe(
      estimateToolDeclarationTokens('image'),
    )
    expect(declarationTokens(agentToolDeclarations('image'))).toBe(
      estimateToolDeclarationTokens('image'),
    )
  })

  it('registers the same list the turn hands the model, clarification included', () => {
    // 这个文件的部署没开 generation:video，所以清单里没有 generateVideo；
    // 也没加载技能目录，所以 loadSkill 同样不在。
    expect(agentToolDeclarations('image').map((declaration) => declaration.name)).toEqual([
      'generateImage',
      'editImage',
      'viewImage',
      'readLibrary',
      'askClarification',
    ])
  })

  // 这个文件没有视频 channel，所以拿到的是「解析不出模型」那一份兜底说明。
  it('grows by exactly one declaration where the video tool is on', () => {
    const withVideo = declarationTokens([
      ...agentToolDeclarations('image'),
      generateVideo.declaration(),
    ])
    const videoTokens = declarationTokens([generateVideo.declaration()])
    // 分开估算会各自向上取整两次（字符与 CJK），再加 JSON 数组边界，最多相差两个 token。
    expect(
      Math.abs(withVideo - estimateToolDeclarationTokens('image') - videoTokens),
    ).toBeLessThanOrEqual(2)
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
    expect(textOf(estimated[0]!)).toBe(turnInitialState(RICH_HISTORY, 'image').systemPrompt)
  })

  it('replays history exactly as the agent initial state does', () => {
    const estimated = estimatedTurnInput(RICH_HISTORY, '再来一张', [])
    expect(estimated.slice(1, -1)).toEqual(turnInitialState(RICH_HISTORY, 'image').messages)
  })

  it('writes this turn prompt text the same way on both paths', () => {
    const estimated = estimatedTurnInput([], '换成夜景', [PLAIN, MASKED])
    // 实发那一份是 `turnPromptText` 再接视觉证据清单，估算照同一条规则拼，所以只能是前缀。
    expect(
      textOf(estimated.at(-1)!).startsWith(turnPromptText('换成夜景', [PLAIN, MASKED], true)),
    ).toBe(true)
  })

  it('charges the same number of image blocks the sent evidence carries', async () => {
    const evidence = await turnVisualEvidence([REAL_PLAIN, REAL_MASKED])
    const estimated = estimatedTurnInput([], '换成夜景', [PLAIN, MASKED])
    expect(imageBlocks(estimated.at(-1)!)).toBe(evidence.content.length)
    expect(evidence.content).toHaveLength(4)
  })

  /**
   * 清单的措辞只写在 `evidenceManifest` 一处，两条路只差选区 ID 与 bounds 的真值/占位，
   * 所以行数与结构必须一致，普通引用那一行还应逐字相等。
   */
  it('writes the same visual evidence manifest on both paths', async () => {
    const evidence = await turnVisualEvidence([REAL_PLAIN, REAL_MASKED])
    const promptText = turnPromptText('换成夜景', [PLAIN, MASKED], true)
    const sent = turnModelPrompt(promptText, evidence)
    const estimatedText = textOf(estimatedTurnInput([], '换成夜景', [PLAIN, MASKED]).at(-1)!)
    const estimatedManifest = estimatedText.slice(promptText.length)

    expect(sent.text).toBe(promptText + evidence.manifest)
    expect(estimatedText.startsWith(promptText)).toBe(true)
    const sentLines = evidence.manifest.split('\n')
    const estimatedLines = estimatedManifest.split('\n')
    expect(estimatedLines).toHaveLength(sentLines.length)
    // 清单头与普通引用那一行不含任何读字节才知道的值，两边逐字相等。
    expect(estimatedLines.slice(0, 4)).toEqual(sentLines.slice(0, 4))
    // 遮罩那一行只有选区 ID 与 bounds 是占位：占位 ID 与真 sha256 同长，bounds 同为 JSON。
    const masked =
      /^视觉输入 2：图片 img-2 原图；3：蓝色定位图；4：原色选区裁片。选区 ID selection_[0-9a-f]{64}，位置 \{"left":\d+,"top":\d+,"width":\d+,"height":\d+\}。蓝色和裁片透明处均为定位信息，不是产品外观。$/
    expect(sentLines[4]).toMatch(masked)
    expect(estimatedLines[4]).toMatch(masked)
  })

  /** 唤醒轮要复核的产物跟在参考图后面发出去：预扣照同样的块数与清单算，不少算。 */
  it('charges the artifacts a wake turn reviews like the evidence it sends', async () => {
    const reviewed = { ...REAL_PLAIN, imageId: 'agent_task-1_0' }
    const evidence = await turnVisualEvidence([reviewed])
    const estimated = estimatedTurnInput([], '复核', [], 'image', [reviewed.imageId]).at(-1)!
    expect(imageBlocks(estimated)).toBe(evidence.content.length)
    expect(textOf(estimated)).toBe(turnPromptText('复核', [], false) + evidence.manifest)
    expect(
      estimateTurnInputTokens(unfolded([]), '复核', [], 'image', [reviewed.imageId]) -
        estimateTurnInputTokens(unfolded([]), '复核', []),
    ).toBeGreaterThanOrEqual(1200)
  })
})
