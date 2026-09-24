import { expect, it } from 'bun:test'
import { resolve } from 'node:path'
import type { AgentTurnParams } from '@image-playground/shared'
import type { AgentToolContext } from '../../../../lib/agent/tools/types'

// 只拼卡片，一条 SQL 都不发；库名故意不可达，真连上就会立刻炸出来。
process.env.DATABASE_URL = 'postgres://unused/agent-save-look'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.SAMPLE_OPENAI_KEY = 'fixture-channel-key'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../../../sync-operator-config.json')

// 动态引入：环境要先钉死，再让捕获配置的模块加载。
const { _setChannelsForTesting } = await import('../../../../lib/channels')
const { saveLook } = await import('../../../../lib/agent/tools/saveLook')
const { createAgentImageSource } = await import('../../../../lib/agent/images')

_setChannelsForTesting([
  {
    id: 'sample-openai',
    kind: 'openai-queue',
    label: 'Sample OpenAI',
    baseUrl: 'https://example.com/v1',
    auth: { type: 'bearer', secretRef: 'SAMPLE_OPENAI_KEY' },
    models: [
      { id: 'image-a', label: 'Image A', capabilities: ['generate', 'edit'] },
      { id: 'image-b', label: 'Image B', capabilities: ['generate', 'edit'] },
    ],
    defaults: { apiMode: 'images', timeout: 600 },
    allowedPaths: ['images/generations', 'images/edits'],
  },
] as never)

function run(params: Record<string, unknown>, turn?: AgentTurnParams) {
  const context: AgentToolContext = {
    mode: 'image',
    conversationId: 'conversation-1',
    turnId: 'turn-1',
    userId: 'user-1',
    deviceId: 'device-abcdefgh',
    images: createAgentImageSource({
      references: [],
      history: [],
      conversationId: 'conversation-1',
      userId: null,
    }),
    ...(turn ? { params: turn } : {}),
  }
  return saveLook.create(context).execute('call-1', params as never, undefined, undefined)
}

const LOOK = {
  name: '暖木湖景',
  description: '给一条家居素材，出暖木色湖景酒店场景图。',
  purpose: 'scene',
  body: '## 1. 一句话目标\n...',
  slotCount: 1,
  referenceImageIds: [],
}

it('pins the model and size of the turn when the agent leaves them out', async () => {
  // 模型看不见这一轮的参数：让它自己写模型名，它只能凭印象写一个这个部署没有的。
  const result = await run(LOOK, { model: 'image-b', size: '1024x1536' })

  expect(result.details.saveCard).toMatchObject({ model: 'image-b', size: '1024x1536' })
})

it('falls back to the deployment image model and auto size without turn params', async () => {
  const result = await run(LOOK)

  expect(result.details.saveCard).toMatchObject({ model: 'image-a', size: 'auto' })
})

it('still rejects a model this deployment does not have when the agent names one', async () => {
  await expect(run({ ...LOOK, model: 'gpt-image-1' })).rejects.toThrow('gpt-image-1')
})
