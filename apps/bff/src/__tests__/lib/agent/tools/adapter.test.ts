import { expect, it } from 'bun:test'
import { resolve } from 'node:path'
import type {
  AgentClarificationBlock,
  AgentToolArtifact,
  AgentToolName,
} from '@image-playground/shared'
import type { AgentImageSource } from '../../../../lib/agent/images'

// 这组断言只看「工具参数 → 轮要发的事件字段」，不碰数据库：配置只是为了让工具模块能被导入。
process.env.DATABASE_URL = 'postgres://unused@127.0.0.1:5432/unused'
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../../../agent-operator-config.json')

// Dynamic imports keep environment setup ahead of modules that capture configuration.
const { agentToolEnd, agentToolStage, agentToolStart, agentToolStartFromSnapshot } = await import(
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

const start = (toolName: AgentToolName, args: unknown) =>
  agentToolStart('image', toolName, 'call-1', args, images)

const facts = (toolName: AgentToolName, args: unknown) => {
  const { toolCallId: _id, toolName: _name, title, prompt, anchorObjectId } = start(toolName, args)
  return { title, prompt, anchorObjectId }
}

it('reads a generateImage call the way the panel needs it', () => {
  expect(facts('generateImage', { prompt: '画一只在窗台上晒太阳的橘猫', n: 3 })).toEqual({
    title: '画一只在窗台上晒太阳的橘猫',
    prompt: '画一只在窗台上晒太阳的橘猫',
    anchorObjectId: undefined,
  })
  expect(facts('generateImage', { prompt: ' \n ' })).toEqual({
    title: '生图',
    prompt: ' \n ',
    anchorObjectId: undefined,
  })
  expect(facts('generateImage', {})).toEqual({
    title: '生图',
    prompt: undefined,
    anchorObjectId: undefined,
  })
  expect(facts('generateImage', null)).toEqual({
    title: '生图',
    prompt: undefined,
    anchorObjectId: undefined,
  })
  expect(facts('generateImage', { prompt: `${'很长的提示词'.repeat(10)}` }).title).toBe(
    `${'很长的提示词'.repeat(10).slice(0, 39)}…`,
  )
})

it('reads an editImage call down to its anchor', () => {
  expect(
    facts('editImage', { prompt: '把背景换成海边', imageIds: ['image 1', 'image 2'], n: 2 }),
  ).toEqual({
    title: '把背景换成海边',
    prompt: '把背景换成海边',
    anchorObjectId: 'canvas-first',
  })
  // 有选区绑定时标题不看提示词。
  expect(
    facts('editImage', {
      prompt: '把背景换成海边',
      imageIds: ['image 1'],
      selectionBindings: [{ imageId: 'image 1', selectionId: 'sel-1' }],
    }).title,
  ).toBe('编辑选区')
  expect(facts('editImage', { imageIds: [] })).toEqual({
    title: '改图',
    prompt: undefined,
    anchorObjectId: undefined,
  })
  // 残缺参数不能在这里抛：这一刻 pi 还没有校验过模型给的东西。模型把单张写成裸字符串时，
  // pi 校验前的那次转换会把它收成一张的数组，锚点因此和产出落在同一处。
  expect(facts('editImage', { imageIds: 'image 1', selectionBindings: [] })).toEqual({
    title: '改图',
    prompt: undefined,
    anchorObjectId: 'canvas-first',
  })
  expect(facts('editImage', null)).toEqual({
    title: '改图',
    prompt: undefined,
    anchorObjectId: undefined,
  })
  expect(() =>
    facts('editImage', { prompt: { broken: true }, imageIds: [{ broken: true }] }),
  ).not.toThrow()
})

it('reads a generateVideo call down to its first frame', () => {
  expect(facts('generateVideo', { prompt: '让镜头缓缓推近', imageId: 'image 1' })).toEqual({
    title: '视频：让镜头缓缓推近',
    prompt: '让镜头缓缓推近',
    anchorObjectId: 'canvas-first',
  })
  expect(facts('generateVideo', {})).toEqual({
    title: '生视频',
    prompt: undefined,
    anchorObjectId: undefined,
  })
})

it('reads a readLibrary call as something that never lands on the canvas', () => {
  expect(facts('readLibrary', { query: '公司 logo' })).toEqual({
    title: '素材：公司 logo',
    prompt: undefined,
    anchorObjectId: undefined,
  })
  expect(facts('readLibrary', {})).toEqual({
    title: '查素材库',
    prompt: undefined,
    anchorObjectId: undefined,
  })
  // 查素材库的结果卡不展示提示词，模型多塞一个 prompt 也不行。
  expect(facts('readLibrary', { query: 'logo', prompt: '画一只猫' }).prompt).toBeUndefined()
})

it('reserves no place on the canvas until the user confirms the draft', () => {
  // 生成工具只拟稿：这一刻还没有任务，占了位就是一个永远填不上的框。
  expect(start('generateImage', { prompt: '橘猫', n: 3 }).outputCount).toBeUndefined()
  expect(
    start('editImage', { prompt: '改背景', imageIds: ['image 1'], n: 2 }).outputCount,
  ).toBeUndefined()
  expect(start('generateVideo', { prompt: '让镜头缓缓推近' }).outputCount).toBeUndefined()
  expect(start('readLibrary', { query: 'logo' }).outputCount).toBeUndefined()
  // 中断续跑补写的是一次真的提交过的调用：那时任务已经在跑，占位数照记，与提交的张数同一个算式。
  expect(
    agentToolStartFromSnapshot('generateImage', 'call-1', {
      mode: 'image',
      args: { prompt: '橘猫', n: 3 },
    }).outputCount,
  ).toBe(3)
})

it('turns a finished tool call into the block the panel and the history share', () => {
  const artifacts: AgentToolArtifact[] = [
    { artifactId: 'agent_1', media: 'image', taskId: 'task-1', outputIndex: 0, mime: 'image/png' },
  ]
  const call = start('generateImage', { prompt: '画一只猫', n: 1 })
  expect(
    agentToolEnd(
      call,
      {
        content: [{ type: 'text', text: '已生成 1 张图' }],
        details: { executedPrompt: '画一只橘猫', artifacts, anchorObjectId: 'canvas-first' },
      },
      null,
    ),
  ).toEqual({
    block: {
      type: 'toolResult',
      toolCallId: 'call-1',
      toolName: 'generateImage',
      prompt: '画一只橘猫',
      snapshot: call.snapshot!,
      status: 'succeeded',
      title: '画一只猫',
      artifacts,
      anchorObjectId: 'canvas-first',
    },
    abortsTurn: false,
  })
  // 没有产物的工具只留标题与起跑时的提示词。
  expect(agentToolEnd(call, { content: [], details: {} }, null).block).toEqual({
    type: 'toolResult',
    toolCallId: 'call-1',
    toolName: 'generateImage',
    prompt: '画一只猫',
    snapshot: call.snapshot!,
    status: 'succeeded',
    title: '画一只猫',
  })
})

it('turns a failed tool call into a message, and knows whose failure stops the turn', () => {
  const failed = { content: [{ type: 'text', text: '图片 image 9 不可用' }], details: {} }
  const edit = start('editImage', { imageIds: ['image 9'] })
  expect(agentToolEnd(edit, failed, 'invalid_params')).toEqual({
    block: {
      type: 'toolResult',
      toolCallId: 'call-1',
      toolName: 'editImage',
      status: 'failed',
      title: '改图',
      message: '图片 image 9 不可用',
      errorCode: 'invalid_params',
      snapshot: edit.snapshot!,
    },
    abortsTurn: false,
  })
  // pi 也可能把结果整个丢掉（工具没跑就被判错），那时至少要有一句话。
  const blank = start('generateImage', {})
  expect(agentToolEnd(blank, undefined, 'unknown').block).toEqual({
    type: 'toolResult',
    toolCallId: 'call-1',
    toolName: 'generateImage',
    status: 'failed',
    title: '生图',
    message: '工具执行失败',
    errorCode: 'unknown',
    snapshot: blank.snapshot!,
  })
  expect(agentToolEnd(start('generateImage', {}), failed, 'upstream_error').abortsTurn).toBe(true)
  expect(agentToolEnd(start('generateVideo', {}), failed, 'upstream_error').abortsTurn).toBe(true)
  expect(agentToolEnd(start('readLibrary', {}), failed, 'upstream_error').abortsTurn).toBe(false)
  // 成功就不是中止的理由，哪怕这个工具失败会停轮。
  expect(
    agentToolEnd(start('generateImage', {}), { content: [], details: {} }, null).abortsTurn,
  ).toBe(false)
})

it('snapshots the arguments of a generation call as the model chose them', () => {
  const params = { size: '1024x1536', quality: 'high' }
  const edit = agentToolStart(
    'image',
    'editImage',
    'call-1',
    {
      prompt: '把猫换成狗',
      imageIds: ['image 1', 'asset-2'],
      selectionBindings: [{ imageId: 'image 1', selectionId: 'sel-1' }],
      n: '2',
    },
    images,
    params,
  )
  expect(edit.snapshot).toMatchObject({
    mode: 'image',
    // 模型写的字面量按 schema 换算过：`"2"` 在快照里就是它执行时会用的 2。
    args: {
      prompt: '把猫换成狗',
      imageIds: ['image 1', 'asset-2'],
      selectionBindings: [{ imageId: 'image 1', selectionId: 'sel-1' }],
      n: 2,
    },
    // `image 1` 这类编号只在这一轮有意义，快照里是真 id。
    imageIds: ['canvas-first', 'asset-2'],
    params,
  })
  // 不提交生成任务的工具没有参数可复原。
  expect(start('readLibrary', { query: 'logo' }).snapshot).toBeUndefined()
  expect(start('loadSkill', { name: 'poster' }).snapshot).toBeUndefined()
})

it('reads the mid-flight stage, and nothing else', () => {
  expect(agentToolStage({ content: [], details: { stage: 'running' } })).toBe('running')
  expect(agentToolStage({ content: [], details: {} })).toBeUndefined()
  expect(agentToolStage(undefined)).toBeUndefined()
})

it('pulls a clarification out of a tool result, and nothing else', () => {
  const clarification: AgentClarificationBlock = {
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
