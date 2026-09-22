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

/** 宽到足以证明「裁的是原件的像素」：从 4×4 那张缩略图里裁不出 1000 见方。 */
const WIDE = `data:image/png;base64,${(
  await sharp({ create: { width: 4000, height: 1000, channels: 3, background: '#4488cc' } })
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
      references: [
        { imageId: 'canvas-1', dataUrl: PIXEL },
        { imageId: 'wide-1', dataUrl: WIDE },
      ],
      history: [],
      conversationId: 'conv-test',
      userId: null,
    }),
  }
}

function run(imageIds: string[], params: Record<string, unknown> = {}) {
  return viewImage
    .create(context())
    .execute('call-1', { imageIds, ...params }, undefined, undefined)
}

function sizeOf(block: { data: string }) {
  return sharp(Buffer.from(block.data, 'base64')).metadata()
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

// 细节靠把框缩小换来，不是靠多拉像素：裁完仍收到预览规格，所以取回来的量是恒定的。
// 不收口的话 region 给成 0~1 就等于又开了一个取整张原件的入口。
it('crops the region out of the original and still bounds what comes back', async () => {
  const result = await run(['wide-1'], { region: { x: 0.5, y: 0, width: 0.25, height: 1 } })
  const size = await sizeOf(
    result.content.find((block) => block.type === 'image') as { data: string },
  )
  // 4000×1000 的右侧四分之一是 1000 见方——缩略图只有 1024 长边，裁不出这个尺寸。
  expect(size.width).toBe(1000)
  expect(size.height).toBe(1000)

  // 框给到整张就得被收口，否则 region 等于又开了一个取整张原件的入口。
  const whole = await run(['wide-1'], { region: { x: 0, y: 0, width: 1, height: 1 } })
  const bounded = await sizeOf(
    whole.content.find((block) => block.type === 'image') as { data: string },
  )
  expect(bounded.width).toBe(1024)
})

// 一个框套到四张尺寸不同的图上，裁出来的是四块不相干的东西。
it('refuses a region that comes with more than one image id', async () => {
  const result = await run(['canvas-1', 'wide-1'], {
    region: { x: 0, y: 0, width: 0.5, height: 0.5 },
  })

  expect(result.content.some((block) => block.type === 'image')).toBe(false)
  expect(result.content[0]).toMatchObject({ text: expect.stringContaining('region 只能配一个') })
})
