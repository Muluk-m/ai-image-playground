import { afterEach, expect, it } from 'bun:test'
import { resolve } from 'node:path'

const TEST_DB = process.env.TEST_DATABASE_URL
if (!TEST_DB) throw new Error('TEST_DATABASE_URL is required for PostgreSQL tests')
process.env.DATABASE_URL = TEST_DB
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../agent-video-operator-config.json')

const { _setChannelsForTesting } = await import('../../lib/channels')
const { _setPrivateBffOverlayForTesting, EMPTY_PRIVATE_BFF_OVERLAY } = await import(
  '../../lib/private-overlay'
)
const { _resetInactiveModelsForTesting, knownInactiveModels, refreshInactiveModels } = await import(
  '../../lib/model-availability'
)
const { agentVideoAvailable, agentVideoModels, videoNodeModeRejection } = await import(
  '../../lib/agent/video-models'
)
type InternalChannel = import('../../lib/channels').InternalChannel

const videoChannel = (id: string, capabilities: string[] = ['generate']): InternalChannel => ({
  id: `video-${id}`,
  kind: 'openai-queue',
  label: id,
  baseUrl: 'https://gateway.example/v1',
  auth: { type: 'bearer', secretRef: 'VIDEO_API_KEY', secret: 'k' },
  allowedPaths: ['videos/generations'],
  models: [{ id, label: id, media: 'video', capabilities: capabilities as never }],
  defaults: { asyncTasks: true },
})

function stopModels(answer: () => Promise<ReadonlySet<string>>): void {
  _setPrivateBffOverlayForTesting(
    Object.freeze({
      ...EMPTY_PRIVATE_BFF_OVERLAY,
      present: true,
      taskHooks: { ...EMPTY_PRIVATE_BFF_OVERLAY.taskHooks, inactiveModels: answer },
    }),
  )
}

afterEach(() => {
  _setPrivateBffOverlayForTesting()
  _setChannelsForTesting([])
  _resetInactiveModelsForTesting()
})

it('leaves video models the operator stopped out of what the agent may use', async () => {
  _setChannelsForTesting([
    videoChannel('grok-imagine-video-1.5-lite'),
    videoChannel('grok-imagine-video', ['generate', 'reference_images']),
  ])
  stopModels(async () => new Set(['grok-imagine-video']))
  await refreshInactiveModels()
  expect(agentVideoModels().map((model) => model.target.model)).toEqual([
    'grok-imagine-video-1.5-lite',
  ])
  // 停掉的模型不再被当作节点模型：参考生按剩下的 Lite 判断，列出 Lite 支持的模式。
  expect(videoNodeModeRejection('reference', 'grok-imagine-video')).toContain(
    'grok-imagine-video-1.5-lite 只支持 文生（text）、首帧（first）',
  )
  expect(videoNodeModeRejection('first', 'grok-imagine-video')).toBeNull()

  stopModels(async () => new Set(['grok-imagine-video', 'grok-imagine-video-1.5-lite']))
  await refreshInactiveModels()
  expect(agentVideoModels()).toEqual([])
  expect(agentVideoAvailable()).toBe(false)
  expect(videoNodeModeRejection('text')).toContain('当前部署没有可用的视频模型')
})

it('treats every model as active when the stopped-model lookup fails', async () => {
  _setChannelsForTesting([videoChannel('grok-imagine-video-1.5-lite')])
  stopModels(async () => new Set(['grok-imagine-video-1.5-lite']))
  await refreshInactiveModels()
  expect(agentVideoAvailable()).toBe(false)
  stopModels(async () => {
    throw new Error('database unavailable')
  })
  expect(await refreshInactiveModels()).toEqual(new Set())
  expect(knownInactiveModels().size).toBe(0)
  expect(agentVideoAvailable()).toBe(true)
})
