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
const { _resetInactiveModelsForTesting, INACTIVE_MODELS_TTL_MS, refreshInactiveModels } =
  await import('../../lib/model-availability')
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
  await refreshInactiveModels(Date.now() + INACTIVE_MODELS_TTL_MS)
  expect(agentVideoModels()).toEqual([])
  expect(agentVideoAvailable()).toBe(false)
  expect(videoNodeModeRejection('text')).toContain('当前部署没有可用的视频模型')
})

it('treats every model as active only until the first successful lookup', async () => {
  _setChannelsForTesting([videoChannel('grok-imagine-video-1.5-lite')])
  stopModels(async () => {
    throw new Error('database unavailable')
  })
  expect(await refreshInactiveModels()).toEqual(new Set())
  expect(agentVideoAvailable()).toBe(true)

  stopModels(async () => new Set(['grok-imagine-video-1.5-lite']))
  await refreshInactiveModels()
  expect(agentVideoAvailable()).toBe(false)
  // 之后再查失败：沿用上一次查到的清单，停用的模型不会重新露出来。
  stopModels(async () => {
    throw new Error('database unavailable')
  })
  expect(await refreshInactiveModels(Date.now() + INACTIVE_MODELS_TTL_MS)).toEqual(
    new Set(['grok-imagine-video-1.5-lite']),
  )
  expect(agentVideoAvailable()).toBe(false)
})

it('shares one lookup between concurrent refreshes and reuses it for a while', async () => {
  let lookups = 0
  let answer!: (inactive: ReadonlySet<string>) => void
  stopModels(() => {
    lookups += 1
    return new Promise((resolve) => (answer = resolve))
  })
  const first = refreshInactiveModels()
  const second = refreshInactiveModels()
  await Bun.sleep(0)
  answer(new Set(['a']))
  expect(await first).toEqual(new Set(['a']))
  expect(await second).toEqual(new Set(['a']))
  expect(lookups).toBe(1)
  await refreshInactiveModels(Date.now() + INACTIVE_MODELS_TTL_MS - 1_000)
  expect(lookups).toBe(1)
  stopModels(async () => {
    lookups += 1
    return new Set(['b'])
  })
  expect(await refreshInactiveModels(Date.now() + INACTIVE_MODELS_TTL_MS)).toEqual(new Set(['b']))
  expect(lookups).toBe(2)
})
