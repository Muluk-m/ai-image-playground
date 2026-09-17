import { expect, it } from 'bun:test'
import { resolve } from 'node:path'
import type { AgentImageSource } from '../../../../lib/agent/images'

// 这组断言只看「工具参数 → 轮要发的事件字段」，不碰数据库：配置只是为了让工具模块能被导入。
process.env.DATABASE_URL = 'postgres://unused@127.0.0.1:5432/unused'
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../../../agent-operator-config.json')

// Dynamic imports keep environment setup ahead of modules that capture configuration.
const { agentToolAbortsTurn, agentToolAnchor, agentToolOutputCount, agentToolTitle } = await import(
  '../../../../lib/agent/tools'
)
const { clarificationFromResult } = await import('../../../../lib/agent/clarification')

/** 锚点只经过 `identify`，所以这里只要一张翻译表。 */
const images = {
  references: [],
  attach() {},
  identify: (imageId: string) => (imageId === 'image 1' ? 'canvas-first' : imageId),
  resolve: async () => null,
  note() {},
} as unknown as AgentImageSource

const start = (toolName: string, args: unknown) => ({
  title: agentToolTitle(toolName, args),
  outputCount: agentToolOutputCount(toolName, args),
  anchorObjectId: agentToolAnchor(toolName, args, images),
})

it('reads a generateImage call the way the canvas needs it', () => {
  expect(start('generateImage', { prompt: '画一只在窗台上晒太阳的橘猫', n: 3 })).toEqual({
    title: '画一只在窗台上晒太阳的橘猫',
    outputCount: 3,
    anchorObjectId: undefined,
  })
  // 模型把整数写成字符串时，占位数要和真正提交的张数同一个值。
  expect(start('generateImage', { prompt: '换个角度', n: '2' }).outputCount).toBe(2)
  expect(start('generateImage', { prompt: ' \n ' })).toEqual({
    title: '生图',
    outputCount: 1,
    anchorObjectId: undefined,
  })
  expect(start('generateImage', {})).toEqual({
    title: '生图',
    outputCount: 1,
    anchorObjectId: undefined,
  })
  expect(start('generateImage', null)).toEqual({
    title: '生图',
    outputCount: 1,
    anchorObjectId: undefined,
  })
  expect(agentToolTitle('generateImage', { prompt: `${'很长的提示词'.repeat(10)}` })).toBe(
    `${'很长的提示词'.repeat(10).slice(0, 39)}…`,
  )
})

it('reads an editImage call down to its anchor', () => {
  expect(
    start('editImage', { prompt: '把背景换成海边', imageIds: ['image 1', 'image 2'], n: 2 }),
  ).toEqual({ title: '把背景换成海边', outputCount: 2, anchorObjectId: 'canvas-first' })
  // 有选区绑定时标题不看提示词。
  expect(
    agentToolTitle('editImage', {
      prompt: '把背景换成海边',
      imageIds: ['image 1'],
      selectionBindings: [{ imageId: 'image 1', selectionId: 'sel-1' }],
    }),
  ).toBe('编辑选区')
  expect(start('editImage', { imageIds: [] })).toEqual({
    title: '改图',
    outputCount: 1,
    anchorObjectId: undefined,
  })
  // 残缺参数不能在这里抛：这一刻 pi 还没有校验过模型给的东西。
  expect(start('editImage', { imageIds: 'image 1', selectionBindings: [] })).toEqual({
    title: '改图',
    outputCount: 1,
    anchorObjectId: undefined,
  })
  expect(start('editImage', null)).toEqual({
    title: '改图',
    outputCount: 1,
    anchorObjectId: undefined,
  })
})

it('reads a generateVideo call as exactly one artifact', () => {
  expect(start('generateVideo', { prompt: '让镜头缓缓推近', imageId: 'image 1' })).toEqual({
    title: '视频：让镜头缓缓推近',
    outputCount: 1,
    anchorObjectId: 'canvas-first',
  })
  // 视频没有 n，图片的张数参数对它没有意义。
  expect(start('generateVideo', { prompt: '让镜头缓缓推近', n: 4 }).outputCount).toBe(1)
  expect(start('generateVideo', {})).toEqual({
    title: '生视频',
    outputCount: 1,
    anchorObjectId: undefined,
  })
})

it('reads a readLibrary call as something that never lands on the canvas', () => {
  expect(start('readLibrary', { query: '公司 logo' })).toEqual({
    title: '素材：公司 logo',
    outputCount: 0,
    anchorObjectId: undefined,
  })
  expect(start('readLibrary', {})).toEqual({
    title: '查素材库',
    outputCount: 0,
    anchorObjectId: undefined,
  })
})

it('knows which tool failures take the whole turn down', () => {
  expect(agentToolAbortsTurn('generateImage')).toBe(true)
  expect(agentToolAbortsTurn('generateVideo')).toBe(true)
  expect(agentToolAbortsTurn('editImage')).toBe(false)
  expect(agentToolAbortsTurn('readLibrary')).toBe(false)
})

it('pulls a clarification out of a tool result, and nothing else', () => {
  const clarification = {
    type: 'clarification',
    question: '要写实还是插画？',
    options: ['写实', '插画'],
  }
  expect(clarificationFromResult({ content: [], details: { clarification } })).toEqual(
    clarification,
  )
  expect(clarificationFromResult({ content: [], details: {} })).toBeNull()
  expect(clarificationFromResult(undefined)).toBeNull()
})
