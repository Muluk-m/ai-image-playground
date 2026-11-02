import { describe, expect, it, vi } from 'vitest'
import type { AgentPanelMessage, AgentToolMessage } from '../../../../features/agent/types'
import {
  assetFormat,
  type CanvasAssetItem,
  canvasAssetsFromMessages,
  groupAssetsByDay,
  messageTimes,
  sortCanvasAssets,
} from '../../../../features/canvas/lib/canvasAssets'

vi.mock('../../../../features/agent/lib/artifactPreview', () => ({
  artifactPreview: async () => ({ source: 'preview' }),
  fetchedImagePreview: async () => ({ source: 'preview' }),
  INLINE_RESULT_THUMBNAIL_SCALE: 1,
}))

function tool(overrides: Partial<AgentToolMessage>): AgentToolMessage {
  return {
    kind: 'tool',
    id: 'tool-1',
    turnId: 'turn-1',
    toolCallId: 'call-1',
    title: '海边日落',
    status: 'succeeded',
    ...overrides,
  }
}

function item(id: string, createdAt: number, mediaId = id): CanvasAssetItem {
  return {
    id,
    createdAt,
    insert: { kind: 'image', source: { type: 'media', mediaId } },
  } as CanvasAssetItem
}

describe('canvas assets', () => {
  it('reads the format from the mime type', () => {
    expect(assetFormat('image/jpeg', 'image')).toBe('JPG')
    expect(assetFormat('image/webp', 'image')).toBe('WEBP')
    expect(assetFormat('video/quicktime', 'video')).toBe('MOV')
    expect(assetFormat(undefined, 'video')).toBe('MP4')
    expect(assetFormat('', 'image')).toBe('PNG')
  })

  it('lists only succeeded generations, with the message time', () => {
    const messages: AgentPanelMessage[] = [
      tool({
        artifacts: [
          {
            artifactId: 'a1',
            media: 'image',
            taskId: 't1',
            outputIndex: 0,
            mime: 'image/png',
            mediaId: 'm1',
          },
          { artifactId: 'v1', media: 'video', taskId: 't2', outputIndex: 0, mime: 'video/mp4' },
        ],
      }),
      tool({
        id: 'tool-2',
        status: 'failed',
        artifacts: [
          { artifactId: 'x', media: 'image', taskId: 't3', outputIndex: 0, mime: 'image/png' },
        ],
      }),
    ]
    const time = messageTimes(
      {
        messages: [{ id: 'tool-1', turnId: 'turn-1', createdAt: 1000 }],
      } as unknown as Parameters<typeof messageTimes>[0],
      5,
    )
    const items = canvasAssetsFromMessages(messages, 'c1', time)
    expect(items.map((one) => [one.id, one.media, one.format, one.createdAt])).toEqual([
      ['a1', 'image', 'PNG', 1000],
      ['v1', 'video', 'MP4', 1000],
    ])
    expect(items[0]?.insert).toEqual({
      kind: 'image',
      source: { type: 'media', mediaId: 'm1' },
      name: '海边日落',
    })
    expect(items[1]?.insert).toMatchObject({
      kind: 'video',
      source: { type: 'queue', taskId: 't2', outputIndex: 0 },
    })
    expect(items.every((one) => one.conversationId === 'c1')).toBe(true)
  })

  it('sorts newest first and drops duplicates', () => {
    const sorted = sortCanvasAssets([item('a', 1), item('b', 3), item('a', 1), item('c', 2)])
    expect(sorted.map((one) => one.id)).toEqual(['b', 'c', 'a'])
  })

  it('drops a canvas result that points at an asset already listed', () => {
    const sorted = sortCanvasAssets([item('a', 2), item('result:r1', 1, 'a'), item('d', 0)])
    expect(sorted.map((one) => one.id)).toEqual(['a', 'd'])
  })

  it('keeps a queue and a local result that share a task id', () => {
    const task = (id: string, type: 'queue' | 'local') =>
      ({
        id,
        createdAt: 1,
        insert: { kind: 'image', source: { type, taskId: 't1', outputIndex: 0 } },
      }) as CanvasAssetItem
    const sorted = sortCanvasAssets([task('q', 'queue'), task('l', 'local')])
    expect(sorted.map((one) => one.id).sort()).toEqual(['l', 'q'])
  })

  it('groups by today, yesterday and a calendar date', () => {
    const now = new Date(2026, 9, 27, 15).getTime()
    const groups = groupAssetsByDay(
      [
        item('t', new Date(2026, 9, 27, 9).getTime()),
        item('t2', new Date(2026, 9, 27, 1).getTime()),
        item('y', new Date(2026, 9, 26, 23).getTime()),
        item('d', new Date(2026, 9, 20, 12).getTime()),
      ],
      now,
    )
    expect(groups.map((group) => [group.day, group.items.map((one) => one.id)])).toEqual([
      [{ kind: 'today' }, ['t', 't2']],
      [{ kind: 'yesterday' }, ['y']],
      [{ kind: 'date', month: 10, day: 20, year: 2026 }, ['d']],
    ])
  })
})
