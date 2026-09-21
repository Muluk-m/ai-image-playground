import { expect, it } from 'bun:test'
import sharp from 'sharp'
import type { AgentImageSource } from '../../../../lib/agent/images'
import type { AgentToolContext } from '../../../../lib/agent/tools/types'

// 这两条用例都在提交之前折返，一条 SQL 都不发；库名故意不可达，真连上就会立刻炸出来。
process.env.DATABASE_URL = 'postgres://unused/agent-edit-image'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'

// 动态引入：环境要先钉死，再让捕获配置的模块加载。
const { editImage } = await import('../../../../lib/agent/tools/editImage')
const { createAgentImageSource } = await import('../../../../lib/agent/images')
const { createTurnAuthorization } = await import('../../../../lib/agent/turn-authorization')
const { _setChannelsForTesting } = await import('../../../../lib/channels')

// 一个可用模型都没有：控制组走完身份检查后停在这一句，不必真提交一条任务。
_setChannelsForTesting([])
const NO_MODEL = '暂时没有可用的生图模型'
const INSTRUCTIONS = '把圈中的头枕降低到椅背上沿'

const PIXEL = `data:image/png;base64,${(
  await sharp({ create: { width: 4, height: 4, channels: 4, background: '#6386a3' } })
    .png()
    .toBuffer()
).toString('base64')}`

/**
 * 一次工具调用看得见的那一份上下文。`interjectWhileFetching` 把插话挂在取图这一步上——
 * 「用户赶在工具执行前插了一句」在工具眼里就是这个样子：快照取过了，授权原文却换了。
 */
function fixture() {
  const authorization = createTurnAuthorization({
    history: [],
    prompt: INSTRUCTIONS,
    references: [],
    attached: false,
  })
  let onResolve: (() => void) | undefined
  const real = createAgentImageSource({
    references: [{ imageId: 'target', dataUrl: PIXEL }],
    history: [],
    conversationId: 'conv-test',
    userId: null,
  })
  const images: AgentImageSource = {
    ...real,
    resolve: (imageId) => {
      onResolve?.()
      return real.resolve(imageId)
    },
  }
  const context: AgentToolContext = {
    mode: 'image',
    conversationId: 'conversation-1',
    turnId: 'turn-1',
    userId: null,
    deviceId: 'device-abcdefgh',
    images,
    authorization: () => authorization.current(),
  }
  return {
    context,
    interjectWhileFetching(text: string) {
      onResolve = () => authorization.amend(text, [], false)
    },
    revision: () => authorization.current().revision,
  }
}

function run(context: AgentToolContext) {
  return editImage
    .create(context)
    .execute('call-1', { prompt: '按要求改', imageIds: ['target'] }, undefined, undefined)
}

it('abandons the execution when the request text changed while it fetched the images', async () => {
  const turn = fixture()
  turn.interjectWhileFetching('不，改扶手')

  await expect(run(turn.context)).rejects.toThrow('用户原文已更新，请按最新原文核对后执行')
  expect(turn.revision()).toBe(1)
})

it('executes the call when nobody touched the request text', async () => {
  const turn = fixture()

  // 走完身份检查才会到「没有可用模型」这一句：它证明上一条不是随便哪个错都算。
  await expect(run(turn.context)).rejects.toThrow(NO_MODEL)
  expect(turn.revision()).toBe(0)
})
