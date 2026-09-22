import { expect, it } from 'bun:test'
import { resolve } from 'node:path'
import sharp from 'sharp'
import type { AgentToolContext } from '../../../../lib/agent/tools/types'

// 只按 id 取本轮引用的字节，一条 SQL 都不发；库名故意不可达，真连上就会立刻炸出来。
process.env.DATABASE_URL = 'postgres://unused/agent-save-asset'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
// 存素材要写进这个人的素材库：同步没开、没登录，工具就不该在清单里。
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../../../sync-operator-config.json')

// 动态引入：环境要先钉死，再让捕获配置的模块加载。
const { saveAsset } = await import('../../../../lib/agent/tools/saveAsset')
const { agentToolDeclarations } = await import('../../../../lib/agent/tools')
const { createAgentImageSource } = await import('../../../../lib/agent/images')

const PIXEL = `data:image/png;base64,${(
  await sharp({ create: { width: 4, height: 4, channels: 4, background: '#6386a3' } })
    .png()
    .toBuffer()
).toString('base64')}`

function context(): AgentToolContext {
  return {
    mode: 'image',
    conversationId: 'conversation-1',
    turnId: 'turn-1',
    userId: 'user-1',
    deviceId: 'device-abcdefgh',
    images: createAgentImageSource({
      references: [{ imageId: 'upload-1', dataUrl: PIXEL }],
      history: [],
      conversationId: 'conversation-1',
      userId: null,
    }),
  }
}

function run(params: Record<string, unknown>) {
  return saveAsset.create(context()).execute('call-1', params, undefined, undefined)
}

const VIEW = { imageId: 'upload-1', label: 'front', source: 'upload' } as const

it('hands back a pending card with the real image ids', async () => {
  const result = await run({
    // 模型多半按本轮编号说话：卡片要存的是真 id，出了这一轮编号就没人认得。
    name: '  浴缸  ',
    kind: 'product',
    background: 'transparent',
    views: [{ imageId: 'image 1', label: 'sheet', source: 'generated' }, VIEW],
  })

  expect(result.details.saveCard).toEqual({
    kind: 'asset',
    status: 'pending',
    name: '浴缸',
    assetKind: 'product',
    background: 'transparent',
    views: [
      { imageId: 'upload-1', label: 'sheet', source: 'generated' },
      { imageId: 'upload-1', label: 'front', source: 'upload' },
    ],
  })
  // 卡片只是放到对话里：模型不能据此宣布已经入库。
  expect(result.content[0]).toMatchObject({ text: expect.stringContaining('按下保存') })
})

/** id 是模型编的、或者那张图已经没了：给它一条改口的路，别让用户拿到一张点不开的卡。 */
it('refuses the card and names every id it could not resolve', async () => {
  await expect(
    run({
      name: '浴缸',
      kind: 'product',
      background: 'solid',
      views: [VIEW, { imageId: 'nope', label: 'detail', source: 'generated' }],
    }),
  ).rejects.toThrow('nope')
})

it('needs a name', async () => {
  await expect(
    run({ name: '   ', kind: 'product', background: 'solid', views: [VIEW] }),
  ).rejects.toThrow('名字')
})

/** 素材库是这个人的东西：没登录的那一轮根本不该看见这个工具。 */
it('stays out of the tool list for a turn with no user', () => {
  const anonymous = agentToolDeclarations('image').map((one) => one.name)
  expect(anonymous).not.toContain('saveAsset')

  const signedIn = agentToolDeclarations('image', { userId: 'user-1' }).map((one) => one.name)
  expect(signedIn).toContain('saveAsset')
})
