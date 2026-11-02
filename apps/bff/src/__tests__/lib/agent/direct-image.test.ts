import { expect, it } from 'bun:test'

// 纯函数，不连库；环境先钉死，再加载会捕获配置的模块。
process.env.DATABASE_URL = 'postgres://unused/direct-image'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'

const { directImageCall } = await import('../../../lib/agent/direct-image')
type Input = Parameters<typeof directImageCall>[0]

const imageTurn = (overrides: Partial<Input> = {}): Input =>
  ({
    directImage: true,
    mode: 'image',
    audience: { experience: 'chat' },
    text: '  一个牛  ',
    references: [],
    history: { messages: [], coveredCount: 0 },
    ...overrides,
  }) as Input

it('图片生成模式的一句话直接进生图工具，不填张数（沿用本轮 n）', () => {
  expect(directImageCall(imageTurn(), false)).toEqual({ prompt: '一个牛' })
})

it('不是干净的图片生成轮就交给模型', () => {
  expect(directImageCall(imageTurn({ directImage: false }), false)).toBeNull()
  expect(directImageCall(imageTurn(), true)).toBeNull()
  expect(directImageCall(imageTurn({ mode: 'video' } as Partial<Input>), false)).toBeNull()
  expect(
    directImageCall(imageTurn({ audience: { experience: 'canvas' } } as Partial<Input>), false),
  ).toBeNull()
  expect(directImageCall(imageTurn({ text: '   ' }), false)).toBeNull()
  expect(directImageCall(imageTurn({ text: '/poster 一个牛' }), false)).toBeNull()
  expect(
    directImageCall(
      imageTurn({ references: [{ imageId: 'img-1' }] } as unknown as Partial<Input>),
      false,
    ),
  ).toBeNull()
  expect(
    directImageCall(imageTurn({ continuation: {} } as unknown as Partial<Input>), false),
  ).toBeNull()
})

it('澄清作答（点选项交的只是选项文字）交给模型，原话和技能上下文由它拼回去', () => {
  const history = {
    messages: [
      { role: 'user', content: [{ type: 'text', text: '/poster 618 海报' }] },
      { role: 'assistant', content: [{ type: 'clarification', question: '什么风格？' }] },
    ],
    coveredCount: 0,
  }
  expect(
    directImageCall(imageTurn({ text: '质感种草', history } as unknown as Partial<Input>), false),
  ).toBeNull()
})

it('上一轮已经出完图（不是澄清）时，新的一句照旧直接出图', () => {
  const history = {
    messages: [
      { role: 'user', content: [{ type: 'text', text: '一只猫' }] },
      { role: 'assistant', content: [{ type: 'text', text: '好了' }] },
    ],
    coveredCount: 0,
  }
  expect(
    directImageCall(imageTurn({ text: '一个牛', history } as unknown as Partial<Input>), false),
  ).toEqual({ prompt: '一个牛' })
})
