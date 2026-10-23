import { describe, expect, it } from 'bun:test'
import * as Y from 'yjs'
import {
  CANVAS_UPLOAD_CLOCK_SKEW_MS,
  CANVAS_UPLOAD_STALE_MS,
  canvasProjectDocument,
  canvasUploadClaimNextChange,
  canvasUploadingElsewhere,
  canvasUploadRejection,
  initializeCanvasConnectionRules,
  nextCanvasUploadStamp,
  releaseCanvasUploadClaim,
  validateCloudCanvas,
  withoutCanvasUploadClaim,
  withoutCanvasUploadRejection,
} from '../canvas-cloud'
import {
  canvasOrigin,
  connectCanvasNodes,
  createCanvasUndoManager,
  deleteCanvasNode,
  disconnectCanvasNodes,
  importLegacyElements,
  insertCanvasNode,
  moveCanvasNodes,
  readCanvasDocument,
  updateCanvasNode,
} from '../canvas-document'
import { createCanvasGroup } from '../canvas-groups'
import { canvasSyncStep1, canvasSyncStep2, readCanvasSyncMessage } from '../canvas-sync'
import type { ProjectDocument } from '../project-protocol'

const origin = canvasOrigin('user', 'one')
const legacy: ProjectDocument = {
  version: 1,
  elements: [
    {
      id: 'text',
      type: 'text',
      text: '旧标题',
      x: 25,
      y: -50,
      width: 100,
      height: 60,
      fill: '#fff',
      fontSize: 16,
    },
  ],
}
describe('cloud canvas migration and protocol', () => {
  it('keeps legacy ids and geometry and allows disconnected offline edits to converge', () => {
    const server = new Y.Doc()
    importLegacyElements(server, legacy.elements, origin)
    const a = new Y.Doc()
    const b = new Y.Doc()
    Y.applyUpdate(a, Y.encodeStateAsUpdate(server))
    Y.applyUpdate(b, Y.encodeStateAsUpdate(server))
    moveCanvasNodes(a, [{ id: 'text', x: 140, y: 70 }], origin)
    insertCanvasNode(
      b,
      { id: 'new', type: 'image', x: 400, y: 0, width: 200, height: 100, data: {} },
      origin,
    )
    connectCanvasNodes(b, { source: 'text', target: 'new' }, origin)
    for (const doc of [a, b]) {
      const request = readCanvasSyncMessage(canvasSyncStep1(server))
      const reply = readCanvasSyncMessage(canvasSyncStep2(doc, request.value))
      Y.applyUpdate(server, reply.value)
    }
    for (const doc of [a, b]) Y.applyUpdate(doc, Y.encodeStateAsUpdate(server))
    expect(readCanvasDocument(a)).toEqual(readCanvasDocument(b))
    expect(canvasProjectDocument(server, legacy).elements[0]).toMatchObject({
      id: 'text',
      x: 140,
      y: 70,
      text: '旧标题',
    })
    validateCloudCanvas(server, legacy)
  })
  it('retains media ids, video playback reference and annotations through migration', () => {
    const document: ProjectDocument = {
      version: 1,
      elements: [
        {
          id: 'video',
          type: 'image',
          mediaId: '11111111-1111-4111-8111-111111111111',
          video: { taskId: 'video-task', outputIndex: 0 },
          x: 30,
          y: 40,
          width: 300,
          height: 200,
          rotation: 20,
        },
        { id: 'ink', type: 'freedraw', points: [1, 2, 3, 4], stroke: '#fff', strokeWidth: 2 },
      ],
    }
    const doc = new Y.Doc()
    importLegacyElements(doc, document.elements, origin)
    expect(canvasProjectDocument(doc, document)).toEqual(document)
    validateCloudCanvas(doc, document)
  })
  it('accepts an uploading local image but rejects forged or inline bitmap references', () => {
    const doc = new Y.Doc()
    importLegacyElements(doc, [], origin)
    let next = 0
    const image = (fileId: string, mediaId?: string) => ({
      id: `upload-${next++}`,
      type: 'image' as const,
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      data: { fileId, ...(mediaId ? { mediaId } : {}) },
    })
    // 上传还没完成：只有本机认得的 fileId，先同步位置；旧读模型里不出现这张图。
    insertCanvasNode(doc, image('Vk3n_x-9:story-grid:0'), origin)
    validateCloudCanvas(doc, legacy)
    expect(canvasProjectDocument(doc, legacy).elements).toEqual([])
    for (const forged of [
      image('cloud-11111111-1111-4111-8111-111111111111'),
      image('data:image/png;base64,AAAA'),
      image('x'.repeat(257)),
      image('local', '11111111-1111-4111-8111-111111111111'),
      // 客户端用普通对象 files[fileId] 查本机图，原型链上的名字会查到继承来的函数或对象。
      image('__proto__'),
      image('constructor'),
      image('toString'),
    ]) {
      insertCanvasNode(doc, forged, origin)
      expect(() => validateCloudCanvas(doc, legacy)).toThrow(
        forged.data.fileId.startsWith('data:') ? 'invalid_canvas_node' : 'canvas_media_not_ready',
      )
      deleteCanvasNode(doc, forged.id, origin)
    }
    // mediaId 是 null、空串或不是 UUID 的字符串时直接判非法，不能当成「还没 mediaId」的上传中节点放过去。
    for (const mediaId of [null, 0, false, '', 'x']) {
      const forged = {
        ...image('Vk3n_x-9:story-grid:0'),
        data: { fileId: 'Vk3n_x-9:story-grid:0', mediaId },
      }
      insertCanvasNode(doc, forged as never, origin)
      expect(() => validateCloudCanvas(doc, legacy)).toThrow('invalid_canvas_node')
      deleteCanvasNode(doc, forged.id, origin)
    }
    // 不带 fileId 的空节点也一样。
    const noFile = { ...image('unused'), data: { mediaId: 'x' } }
    insertCanvasNode(doc, noFile as never, origin)
    expect(() => validateCloudCanvas(doc, legacy)).toThrow('invalid_canvas_node')
    deleteCanvasNode(doc, noFile.id, origin)
  })
  it('rejects malformed roots and non-finite geometry', () => {
    const doc = new Y.Doc()
    importLegacyElements(doc, [], origin)
    doc.getMap('secrets').set('payload', true)
    expect(() => validateCloudCanvas(doc, legacy)).toThrow()
  })
  it('preserves interleaved node and annotation layers', () => {
    const document: ProjectDocument = {
      version: 1,
      elements: [
        { id: 'ink', type: 'freedraw', points: [1, 2, 3, 4], stroke: '#fff', strokeWidth: 2 },
        ...legacy.elements,
        { id: 'arrow', type: 'arrow', points: [1, 2, 3, 4], stroke: '#fff', strokeWidth: 2 },
      ],
    }
    const doc = new Y.Doc()
    importLegacyElements(doc, document.elements, origin)
    expect(canvasProjectDocument(doc, document)).toEqual(document)
    validateCloudCanvas(doc, document)
  })
  it('rejects malformed empty-node data and annotations before clients see them', () => {
    for (const patch of [
      { type: 'text', data: { text: '', fontSize: 16, fill: '#fff', name: {} } },
      { type: 'video', data: {} },
      { type: 'image', data: { pending: { type: 'placeholder' } } },
      {
        type: 'image',
        data: { pending: { type: 'placeholder', status: 'loading', message: '', meta: null } },
      },
      {
        type: 'image',
        data: {
          pending: {
            type: 'placeholder',
            status: 'loading',
            message: '',
            meta: {},
            id: 'override',
          },
        },
      },
      { type: 'image', data: { pending: { type: 'generation' } } },
    ]) {
      const doc = new Y.Doc()
      importLegacyElements(doc, legacy.elements, origin)
      const node = doc.getMap<Y.Map<unknown>>('nodes').get('text')!
      for (const [key, value] of Object.entries(patch)) node.set(key, value)
      expect(() => validateCloudCanvas(doc, legacy)).toThrow()
      doc.destroy()
    }
    const doc = new Y.Doc()
    importLegacyElements(doc, legacy.elements, origin)
    doc.getMap('annotations').set('fake', { ...legacy.elements[0], id: 'fake', z: 1 })
    expect(() => validateCloudCanvas(doc, legacy)).toThrow('invalid_canvas_annotation')
    doc.destroy()
  })
  it('rejects malformed and trailing wire data', () => {
    expect(() => readCanvasSyncMessage(new Uint8Array([9]))).toThrow()
    const bytes = canvasSyncStep1(new Y.Doc())
    expect(() => readCanvasSyncMessage(new Uint8Array([...bytes, 0]))).toThrow()
  })
})

it('enforces registry connections on the server without breaking pre-registry archives', () => {
  const doc = new Y.Doc()
  importLegacyElements(doc, legacy.elements, origin)
  insertCanvasNode(
    doc,
    {
      id: 'video',
      type: 'image',
      x: 0,
      y: 0,
      width: 300,
      height: 200,
      data: { meta: { nodeKind: 'video' } },
    },
    origin,
  )
  doc.getMap('edges').set('video:text', { id: 'video:text', source: 'video', target: 'text' })
  expect(() => validateCloudCanvas(doc, legacy)).toThrow('invalid_canvas_connection')
  initializeCanvasConnectionRules(doc)
  const legacyConnections = doc.getMap<string>('legacyConnections').toJSON()
  const undo = createCanvasUndoManager(doc, origin)
  moveCanvasNodes(doc, [{ id: 'text', x: 1000, y: 5 }], origin)
  expect(() => validateCloudCanvas(doc, legacy, legacyConnections)).not.toThrow()
  disconnectCanvasNodes(doc, 'video:text', origin)
  expect(() => validateCloudCanvas(doc, legacy, legacyConnections)).not.toThrow()
  undo.undo()
  expect(readCanvasDocument(doc).edges).toHaveLength(1)
  expect(() => validateCloudCanvas(doc, legacy, legacyConnections)).not.toThrow()
  insertCanvasNode(
    doc,
    {
      id: 'new-text',
      type: 'text',
      x: 0,
      y: 0,
      width: 300,
      height: 200,
      data: { text: '', fontSize: 16, fill: '#fff' },
    },
    origin,
  )
  doc
    .getMap('edges')
    .set('video:new-text', { id: 'video:new-text', source: 'video', target: 'new-text' })
  expect(() => validateCloudCanvas(doc, legacy, legacyConnections)).toThrow(
    'invalid_canvas_connection',
  )
  doc
    .getMap('legacyConnections')
    .set('video:new-text', JSON.stringify(['video', 'new-text', 'video', 'text']))
  expect(() => validateCloudCanvas(doc, legacy, legacyConnections)).toThrow(
    'invalid_canvas_connection_policy',
  )
  undo.destroy()
  doc.destroy()
})

it('rejects malformed group geometry and membership before broadcasting', () => {
  const doc = new Y.Doc()
  importLegacyElements(doc, legacy.elements, origin)
  createCanvasGroup(doc, 'scene', ['text'], '第一场', origin)
  expect(() => validateCloudCanvas(doc, legacy)).not.toThrow()
  doc.getMap<Y.Map<unknown>>('groups').get('scene')!.set('width', Number.NaN)
  expect(() => validateCloudCanvas(doc, legacy)).toThrow('invalid_canvas_group')
  doc.getMap<Y.Map<unknown>>('groups').get('scene')!.set('width', 500)
  doc.getMap('groupMembers').set('text', { id: 'scene' })
  expect(() => validateCloudCanvas(doc, legacy)).toThrow('invalid_canvas_group')
  doc.destroy()
})

it('accepts concurrent overflow without dropping slots and remains syncable after reconciliation', () => {
  const a = new Y.Doc(),
    b = new Y.Doc()
  insertCanvasNode(
    a,
    {
      id: 'timeline',
      type: 'timeline',
      x: 0,
      y: 0,
      width: 500,
      height: 240,
      data: { clips: Array.from({ length: 63 }, (_, i) => ({ elementId: `old-${i}`, in: 0 })) },
    },
    origin,
  )
  for (const id of ['a', 'b'])
    insertCanvasNode(
      a,
      {
        id,
        type: 'image',
        x: 0,
        y: 0,
        width: 320,
        height: 180,
        data: { meta: { nodeKind: 'video' } },
      },
      origin,
    )
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
  connectCanvasNodes(a, { source: 'a', target: 'timeline' }, origin)
  connectCanvasNodes(b, { source: 'b', target: 'timeline' }, origin)
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b))
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
  const node = readCanvasDocument(a).nodes.find((n) => n.id === 'timeline')!
  if (node.type !== 'timeline') throw new Error('missing timeline')
  expect(node.data.clips).toHaveLength(65)
  validateCloudCanvas(a, legacy)
  updateCanvasNode(a, 'timeline', { data: { clips: node.data.clips.slice(1) } }, origin)
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
  expect(readCanvasDocument(b).nodes.find((n) => n.id === 'timeline')?.data).toEqual({
    clips: node.data.clips.slice(1),
  })
  validateCloudCanvas(b, legacy)
})

it('rejects malformed timeline slot payloads even when their target is absent', () => {
  for (const [field, value] of [
    ['clip', { elementId: 'a', in: -1 }],
    ['order', NaN],
    ['deleted', 'yes'],
    ['secret', 'x'],
  ]) {
    const doc = new Y.Doc()
    doc.getMap('timelineSlots').set(JSON.stringify(['timeline', 'source', 'a', field]), value)
    expect(() => validateCloudCanvas(doc, legacy)).toThrow('invalid_canvas_timeline')
  }
})

describe('canvas upload claims', () => {
  const now = 1_000_000_000
  const claimed = (by: string, since: number) => ({
    fileId: 'local-1',
    meta: { uploadDevice: by, uploadStartedAt: String(since), prompt: 'p' },
  })

  it('给出上传中状态下一次翻转的时刻，到点前后结果确实不同', () => {
    const fresh = claimed('other', now - 1000)
    const expiry = canvasUploadClaimNextChange(fresh, 'me', now)
    expect(expiry).toBe(now - 1000 + CANVAS_UPLOAD_STALE_MS)
    expect(canvasUploadingElsewhere(fresh, 'me', (expiry as number) - 1)).toBe(true)
    expect(canvasUploadingElsewhere(fresh, 'me', expiry as number)).toBe(false)
    const ahead = claimed('other', now + CANVAS_UPLOAD_CLOCK_SKEW_MS + 60_000)
    const start = canvasUploadClaimNextChange(ahead, 'me', now) as number
    expect(canvasUploadingElsewhere(ahead, 'me', start - 1)).toBe(false)
    expect(canvasUploadingElsewhere(ahead, 'me', start)).toBe(true)
    expect(canvasUploadClaimNextChange(claimed('me', now), 'me', now)).toBeUndefined()
    expect(
      canvasUploadClaimNextChange(claimed('other', now - CANVAS_UPLOAD_STALE_MS), 'me', now),
    ).toBeUndefined()
    expect(canvasUploadClaimNextChange({ ...fresh, mediaId: 'm' }, 'me', now)).toBeUndefined()
  })

  it('只把别的设备声明在传、还没过期的本机图片当作上传中', () => {
    expect(canvasUploadingElsewhere(claimed('other', now - 1000), 'me', now)).toBe(true)
    expect(canvasUploadingElsewhere(claimed('me', now - 1000), 'me', now)).toBe(false)
    expect(
      canvasUploadingElsewhere(claimed('other', now - CANVAS_UPLOAD_STALE_MS), 'me', now),
    ).toBe(false)
    expect(canvasUploadingElsewhere({ fileId: 'local-1' }, 'me', now)).toBe(false)
    // 别的设备时钟快几分钟照样算在传；开始时间远在未来（时钟错乱或伪造）不算，避免一直绕过缺图处理。
    expect(canvasUploadingElsewhere(claimed('other', now + 60_000), 'me', now)).toBe(true)
    expect(
      canvasUploadingElsewhere(claimed('other', now + CANVAS_UPLOAD_CLOCK_SKEW_MS + 1), 'me', now),
    ).toBe(false)
    expect(canvasUploadingElsewhere({ ...claimed('other', now), mediaId: 'm' }, 'me', now)).toBe(
      false,
    )
    expect(
      canvasUploadingElsewhere({ ...claimed('other', now), fileId: 'cloud-x' }, 'me', now),
    ).toBe(false)
  })

  it('收成云媒体时去掉声明、保留其余 meta', () => {
    expect(withoutCanvasUploadClaim(claimed('other', now).meta)).toEqual({ prompt: 'p' })
    const plain = { prompt: 'p' }
    expect(withoutCanvasUploadClaim(plain)).toBe(plain)
    expect(withoutCanvasUploadClaim(undefined)).toBeUndefined()
  })
  it('服务端收不了的图：撤销时记下错误码，重新声明或收成云媒体后就不算失败', () => {
    const rejected = releaseCanvasUploadClaim(
      claimed('tab', now - 5).meta,
      now,
      'media_invalid_image',
    )
    expect(rejected).toEqual({
      prompt: 'p',
      uploadReleasedAt: String(now),
      uploadRejected: 'media_invalid_image',
    })
    expect(canvasUploadRejection({ fileId: 'local', meta: rejected })).toBe('media_invalid_image')
    // 暂时性失败撤销时不带错误码，也去掉上一次的失败记录。
    expect(releaseCanvasUploadClaim(rejected, now)).not.toHaveProperty('uploadRejected')
    // 重新声明在传（用户点了重试）、已有云媒体：都不再显示上传失败。
    expect(
      canvasUploadRejection({
        fileId: 'local',
        meta: { ...rejected, uploadDevice: 'tab', uploadStartedAt: String(now + 1) },
      }),
    ).toBeUndefined()
    expect(canvasUploadRejection({ fileId: 'local', mediaId: 'm', meta: rejected })).toBeUndefined()
    expect(withoutCanvasUploadClaim(rejected)).toEqual({ prompt: 'p' })
    expect(withoutCanvasUploadRejection(rejected)).toEqual({
      prompt: 'p',
      uploadReleasedAt: String(now),
    })
    const plain = { prompt: 'p' }
    expect(withoutCanvasUploadRejection(plain)).toBe(plain)
  })
  it('新簿记的时间总晚于节点上已有的声明或撤销，即使本机时钟落后', () => {
    const ahead = { uploadDevice: 'b', uploadStartedAt: '5000', prompt: 'p' }
    // 本机时钟（1000）落后于别的设备写的声明（5000）：撤销仍记成更晚的 5001。
    expect(releaseCanvasUploadClaim(ahead, 1000)).toEqual({ prompt: 'p', uploadReleasedAt: '5001' })
    expect(nextCanvasUploadStamp({ uploadReleasedAt: '7000' }, 1000)).toBe(7001)
    expect(nextCanvasUploadStamp(ahead, 9000)).toBe(9000)
    expect(nextCanvasUploadStamp(undefined, 9000)).toBe(9000)
    // 没有设备的开始时间不算声明。
    expect(nextCanvasUploadStamp({ uploadStartedAt: '5000' }, 1000)).toBe(1000)
  })
})
