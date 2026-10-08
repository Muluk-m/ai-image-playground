import type { AgentToolArtifact } from '@image-playground/shared'
import { expect, it } from 'vitest'
import {
  assetsFromBatch,
  assetsFromMessages,
  batchNeedsRefresh,
  loadAssetOriginal,
} from '../../../../features/agent/lib/assetItems'
import type { AgentPanelMessage, AgentToolMessage } from '../../../../features/agent/types'

function tool(id: string, extra: Partial<AgentToolMessage> = {}): AgentToolMessage {
  return {
    kind: 'tool',
    id,
    turnId: id,
    toolCallId: id,
    title: `Result ${id}`,
    status: 'succeeded',
    artifacts: [{ artifactId: id, media: 'image', taskId: id, outputIndex: 0, mime: 'image/png' }],
    ...extra,
  }
}

function artifact(id: string, media: 'image' | 'video' = 'image'): AgentToolArtifact {
  return { artifactId: id, media, taskId: id, outputIndex: 0, mime: 'image/png' }
}

const plan = tool('plan', { title: '背景优化', artifacts: undefined, batchId: 'batch-1' })

it('keeps generated results and adds attached references without listing them twice', () => {
  const messages: AgentPanelMessage[] = [
    {
      kind: 'text',
      id: 'user-1',
      turnId: 'turn-1',
      role: 'user',
      text: '优化',
      streaming: false,
      references: [
        { imageId: 'img-1', mediaId: 'media-1', name: '01-主图场景' },
        { imageId: 'inline-1', dataUrl: 'data:image/png;base64,aaaa', name: '草图' },
      ],
    },
    tool('older'),
    tool('newer'),
  ]
  const items = assetsFromMessages(messages)
  expect(items.map((item) => [item.id, item.title, item.open.kind])).toEqual([
    ['newer', 'Result newer', 'result'],
    ['older', 'Result older', 'result'],
    ['media:media-1', '01-主图场景', 'source'],
    ['ref:user-1:1', '草图', 'source'],
  ])
})

it('lists a batch plan in order, including finished results and skipping duplicate inputs', () => {
  const items = assetsFromBatch(plan, {
    items: [
      {
        inputs: [{ imageId: 'i1', mediaId: 'media-1', name: '01-主图场景' }],
        progress: 'ready',
      },
      {
        inputs: [
          { imageId: 'i2', mediaId: 'media-2', name: '02-场景二-烛光深色墙' },
          { imageId: 'i2b', mediaId: 'media-2', name: '重复' },
        ],
        progress: 'completed',
        execution: {
          status: 'completed',
          artifacts: [artifact('out-2'), artifact('out-2b', 'video')],
        },
      },
      {
        inputs: [{ imageId: 'i3', mediaId: 'media-3', name: '03-夜景' }],
        progress: 'in_flight',
        execution: { status: 'in_progress', artifacts: [artifact('not-yet')] },
      },
    ],
  })
  expect(items.map((item) => [item.id, item.title, item.media, item.open.kind])).toEqual([
    ['media:media-1', '01-主图场景', 'image', 'source'],
    ['media:media-2', '02-场景二-烛光深色墙', 'image', 'source'],
    ['out-2', '02-场景二-烛光深色墙', 'image', 'result'],
    ['out-2b', '02-场景二-烛光深色墙', 'video', 'result'],
    ['media:media-3', '03-夜景', 'image', 'source'],
  ])
  expect(items[0]?.open).toEqual({ kind: 'source', mediaId: 'media-1' })
  const result = items[2]!
  expect(result.open.kind === 'result' && result.open.message.artifacts?.[0]?.artifactId).toBe(
    'out-2',
  )
  expect(
    batchNeedsRefresh({
      batch: { status: 'paused' },
      items: [{ progress: 'in_flight', execution: { status: 'in_progress' } }],
    }),
  ).toBe(true)
  expect(
    batchNeedsRefresh({
      batch: { status: 'paused' },
      items: [{ progress: 'ready' }],
    }),
  ).toBe(false)
})

it('loads a stored reference snapshot by its message index', async () => {
  const message: AgentPanelMessage = {
    kind: 'text',
    id: 'user-1',
    turnId: 'turn-1',
    role: 'user',
    text: '优化',
    streaming: false,
    references: [{ imageId: 'img-1', name: '草图', image: { object: 'obj-1', mime: 'image/png' } }],
  }
  expect(assetsFromMessages([message])).toEqual([])
  const items = assetsFromMessages([message], {
    conversationId: 'conversation-1',
    loadReference: async (_conversationId, messageId, index, variant) =>
      `${variant}:${messageId}:${index}`,
  })
  expect(items.map((item) => [item.id, item.title, item.open.kind])).toEqual([
    ['ref:user-1:0', '草图', 'source'],
  ])
  expect(await items[0]?.load()).toBe('preview:user-1:0')
  expect(await loadAssetOriginal(items[0]!, async () => 'original:user-1:0')).toBe(
    'original:user-1:0',
  )
})
