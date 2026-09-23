import type { AgentToolArtifact } from '@image-playground/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'

// 取网图那条路要下载媒体字节；这里只关心「按什么 id 取、落成什么画布对象」。
vi.mock('../../../../lib/cloudMedia', () => ({
  mediaIdentity: (source: string) => source.match(/^aip-media:([0-9a-f-]{36})$/i)?.[1],
  resolveMediaSource: async (source: string, variant = 'original') => `${variant}:${source}`,
}))

import {
  createArtifactDelivery,
  deliverable,
  fetchedCanvasId,
  placedArtifact,
} from '../../../../features/agent/lib/artifactDelivery'
import {
  type AgentCanvasSink,
  type AgentPlacedArtifact,
  setAgentCanvasSink,
} from '../../../../features/agent/lib/canvasSink'
import type { AgentToolMessage } from '../../../../features/agent/types'

const POSTER = 'data:image/png;base64,UE9T'

function artifact(extra: Partial<AgentToolArtifact> = {}): AgentToolArtifact {
  return {
    artifactId: 'a1',
    media: 'video',
    taskId: 't1',
    outputIndex: 2,
    mime: 'video/mp4',
    ...extra,
  }
}

describe('智能体产物到画布对象', () => {
  it('carries what the video was generated with onto the canvas object', () => {
    const generation = {
      model: 'grok-imagine-video',
      duration: 6,
      aspectRatio: '9:16',
      resolution: '720p',
    } as const
    expect(placedArtifact(artifact({ video: generation }), POSTER)).toEqual({
      artifactId: 'a1',
      dataUrl: POSTER,
      video: { taskId: 't1', outputIndex: 2, generation },
    })
  })

  it('keeps older video records playable without parameters', () => {
    expect(placedArtifact(artifact(), POSTER).video).toEqual({ taskId: 't1', outputIndex: 2 })
  })

  it('drops a malformed record instead of writing it into the canvas', () => {
    const broken = { model: '', duration: 6 } as unknown as AgentToolArtifact['video']
    expect(placedArtifact(artifact({ video: broken }), POSTER).video).toEqual({
      taskId: 't1',
      outputIndex: 2,
    })
  })

  it('places images without a video source', () => {
    expect(placedArtifact(artifact({ media: 'image', mime: 'image/png' }), POSTER)).toEqual({
      artifactId: 'a1',
      dataUrl: POSTER,
    })
  })
})

/** 落下去的东西；交付只碰这一样，画布上有没有它由同一张表回答。 */
function stubCanvas() {
  const placed: AgentPlacedArtifact[] = []
  const present = new Set<string>()
  const sink = {
    has: (objectId: string) => present.has(objectId),
    async place(items: readonly AgentPlacedArtifact[]) {
      placed.push(...items)
      for (const item of items) present.add(item.artifactId)
      return 'placed' as const
    },
    async reserve() {
      return []
    },
    discard() {},
    markFailed() {},
    focus() {},
    async thumbnail() {
      return null
    },
  } satisfies AgentCanvasSink
  setAgentCanvasSink(sink)
  return placed
}

function fetchCard(): AgentToolMessage {
  return {
    kind: 'tool',
    id: 'msg-1',
    turnId: 'turn-1',
    toolCallId: 'call-1',
    toolName: 'fetchImage',
    title: '获取图片：example.com',
    status: 'succeeded',
    fetchedImages: [
      {
        imageId: '11111111-2222-4333-8444-555555555555',
        sourceUrl: 'https://example.com/cat.png',
        mime: 'image/png',
        name: '橘猫实拍',
      },
    ],
  }
}

describe('取回来的网图落画布', () => {
  afterEach(() => {
    setAgentCanvasSink(null)
  })

  /**
   * 取到的网图要能当参考图用，第一步就是它真的在画布上。字节按媒体 id 取，落成的画布对象
   * 另起一个 id——同一张媒体可能被取两次，画布对象 id 必须只属于这一次调用。
   */
  it('places the fetched bytes as a canvas object of its own', async () => {
    const placed = stubCanvas()
    const turn = createArtifactDelivery(() => {}).beginTurn()

    turn.enqueue(fetchCard())
    await turn.settled()

    expect(placed).toEqual([
      {
        artifactId: fetchedCanvasId('call-1', 0),
        dataUrl: 'original:aip-media:11111111-2222-4333-8444-555555555555',
        name: '橘猫实拍',
      },
    ])
  })

  // 续播、切回画布都会把同一条结果卡再交付一遍：id 是算出来的，已经在画布上就不落第二遍。
  it('does not place the same fetched image twice', async () => {
    const placed = stubCanvas()
    const delivery = createArtifactDelivery(() => {})

    const first = delivery.beginTurn()
    first.enqueue(fetchCard())
    await first.settled()
    await delivery.placeOnCanvas(fetchCard())

    expect(placed).toHaveLength(1)
  })

  // 没有产物、没有时间线，交付层也得认得这张卡；不认它就永远不落画布。
  it('counts a fetched image as something to deliver', () => {
    expect(deliverable(fetchCard())).toBe(true)
    expect(deliverable({ ...fetchCard(), fetchedImages: [] })).toBe(false)
  })
})
