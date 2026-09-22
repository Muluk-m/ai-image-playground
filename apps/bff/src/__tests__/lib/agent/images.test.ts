import { expect, it } from 'bun:test'
import type {
  AgentMessageView,
  AgentStoredReference,
  AgentTurnReference,
} from '@image-playground/shared'

// 只问引用的形状，一个字节都不取：库名故意不可达，真连上就会立刻炸出来。
process.env.DATABASE_URL = 'postgres://unused/agent-images'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'

// 动态引入：环境要先钉死，再让捕获配置的模块加载。
const { createAgentImageSource } = await import('../../../lib/agent/images')

const PIXEL = 'data:image/png;base64,aGk='

function userMessage(references: readonly AgentStoredReference[]): AgentMessageView {
  return {
    id: crypto.randomUUID(),
    turnId: 'turn-old',
    role: 'user',
    content: [{ type: 'text', text: '改这里', references }],
    createdAt: 1,
  }
}

function source(input: {
  references?: readonly AgentTurnReference[]
  history?: readonly AgentMessageView[]
}) {
  return createAgentImageSource({
    references: input.references ?? [],
    history: input.history ?? [],
    conversationId: 'conv-test',
    userId: null,
  })
}

it('reports no mask when the turn carries no reference at all', () => {
  expect(source({}).masked).toBe(false)
})

it('reports no mask when the attached references are plain images', () => {
  expect(
    source({
      references: [
        { imageId: 'a', dataUrl: PIXEL },
        { imageId: 'b', dataUrl: PIXEL, name: '参考' },
      ],
    }).masked,
  ).toBe(false)
})

it('reports a mask when one attached reference carries the drawn selection', () => {
  expect(
    source({
      references: [
        { imageId: 'a', dataUrl: PIXEL },
        { imageId: 'b', dataUrl: PIXEL, maskDataUrl: PIXEL },
      ],
    }).masked,
  ).toBe(true)
})

it('keeps a selection drawn in an earlier turn from gating this one', () => {
  const masked = userMessage([
    {
      imageId: 'old',
      image: { object: 'agent/c/t/0/in/0', mime: 'image/png' },
      mask: { object: 'agent/c/t/0/in/mask', mime: 'image/png' },
    },
  ])
  // 沿用下来的引用只进清单文字：用户这一轮没有圈选，就该能改口重做整张，
  // 否则圈过一次之后每一轮都被判成遮罩轮，连一次整图重做都提交不了。
  expect(source({ history: [masked] }).masked).toBe(false)
  expect(
    source({ references: [{ imageId: 'now', dataUrl: PIXEL }], history: [masked] }).masked,
  ).toBe(false)
})

it('follows the references an interjection attached mid-turn', () => {
  const images = source({ references: [{ imageId: 'a', dataUrl: PIXEL }] })
  expect(images.masked).toBe(false)
  images.attach([{ imageId: 'b', dataUrl: PIXEL, maskDataUrl: PIXEL }])
  expect(images.masked).toBe(true)
})
