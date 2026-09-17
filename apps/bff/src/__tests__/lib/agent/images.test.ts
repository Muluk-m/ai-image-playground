import { expect, it } from 'bun:test'
import type {
  AgentMessageView,
  AgentStoredReference,
  AgentToolArtifact,
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

it('reports a mask when the archived reference kept its selection in object storage', () => {
  expect(
    source({
      history: [
        userMessage([
          {
            imageId: 'a',
            image: { object: 'agent/c/t/0/in/0', mime: 'image/png' },
            mask: { object: 'agent/c/t/0/in/mask', mime: 'image/png' },
          },
        ]),
      ],
    }).masked,
  ).toBe(true)
})

it('asks only the batch the turn is working on, not every reference ever seen', () => {
  const masked = userMessage([
    {
      imageId: 'old',
      image: { object: 'agent/c/t/0/in/0', mime: 'image/png' },
      mask: { object: 'agent/c/t/0/in/mask', mime: 'image/png' },
    },
  ])
  const plain = userMessage([
    { imageId: 'newer', image: { object: 'agent/c/t/1/in/0', mime: 'image/png' } },
  ])
  // 最近一批引用说了算：更早那批仍可凭原 id 取回，但不再让这一轮变成遮罩轮。
  expect(source({ history: [masked, plain] }).masked).toBe(false)
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

/** 视频与图片并列各有一张表：模型指得到视频，但改图工具永远取不到它。 */
function assistantWithArtifacts(artifacts: AgentToolArtifact[]): AgentMessageView {
  return {
    id: crypto.randomUUID(),
    turnId: 'turn-old',
    role: 'assistant',
    content: [
      {
        type: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'generateVideo',
        status: 'succeeded',
        title: '生视频',
        artifacts,
      },
    ],
    createdAt: 2,
  }
}

const VIDEO: AgentToolArtifact = {
  artifactId: 'agent_video_1',
  media: 'video',
  taskId: 'task-v',
  outputIndex: 0,
  mime: 'video/mp4',
}

const IMAGE: AgentToolArtifact = {
  artifactId: 'agent_image_1',
  media: 'image',
  taskId: 'task-i',
  outputIndex: 0,
  mime: 'image/png',
}

it('lists the finished videos of this conversation, and only those', () => {
  const images = source({ history: [assistantWithArtifacts([VIDEO, IMAGE])] })
  expect(images.videoIds).toEqual([VIDEO.artifactId])
})

it('picks up a video the current turn just produced', () => {
  const images = source({})
  expect(images.videoIds).toEqual([])
  images.note([VIDEO, IMAGE])
  expect(images.videoIds).toEqual([VIDEO.artifactId])
})

it('separates an id it never saw from one it would have to go read', async () => {
  const images = source({ history: [assistantWithArtifacts([VIDEO])] })
  // 认不出来的 id 一个字节都不取，所以这一句不碰数据库。
  expect(await images.resolveVideo('agent_nope')).toEqual({ kind: 'unknown' })
})
