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
