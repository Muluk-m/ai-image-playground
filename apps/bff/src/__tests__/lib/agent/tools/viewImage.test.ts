import { expect, it } from 'bun:test'
import sharp from 'sharp'
import type { AgentToolContext } from '../../../../lib/agent/tools/types'

// 只按 id 取本轮引用的字节，一条 SQL 都不发；库名故意不可达，真连上就会立刻炸出来。
process.env.DATABASE_URL = 'postgres://unused/agent-view-image'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'

// 动态引入：环境要先钉死，再让捕获配置的模块加载。
const { viewImage } = await import('../../../../lib/agent/tools/viewImage')
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
    userId: null,
    deviceId: 'device-abcdefgh',
    images: createAgentImageSource({
      references: [{ imageId: 'canvas-1', dataUrl: PIXEL }],
      history: [],
      userId: null,
    }),
  }
}

function run(imageIds: string[]) {
  return viewImage.create(context()).execute('call-1', { imageIds }, undefined, undefined)
}

it('hands the model the bytes of the images it asked to see', async () => {
  const result = await run(['canvas-1'])

  const images = result.content.filter((block) => block.type === 'image')
  expect(images).toHaveLength(1)
  expect(result.content[0]).toMatchObject({ type: 'text' })
  // 清单与参考图那一套同源：模型据它知道第几块是哪张图。
  expect(result.content[0]).toMatchObject({ text: expect.stringContaining('图片 canvas-1 原图') })
})

/** 模型报的 id 可能是它自己编的：这时要给它一条改口的路，而不是把整轮停下。 */
it('reports an unknown id instead of throwing', async () => {
  const partial = await run(['canvas-1', 'nope'])
  expect(partial.content.filter((block) => block.type === 'image')).toHaveLength(1)
  expect(partial.content[0]).toMatchObject({ text: expect.stringContaining('nope') })

  const none = await run(['nope'])
  expect(none.content.filter((block) => block.type === 'image')).toEqual([])
  expect(none.content[0]).toMatchObject({ text: expect.stringContaining('没有取到任何图') })
})
