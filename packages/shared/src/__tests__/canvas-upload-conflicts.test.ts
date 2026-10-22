import { describe, expect, it } from 'bun:test'
import * as Y from 'yjs'
import { CANVAS_UPLOAD_DEVICE_META, CANVAS_UPLOAD_STARTED_META } from '../canvas-cloud'
import {
  canvasOrigin,
  type ImageNodeData,
  insertCanvasNode,
  readCanvasDocument,
  updateCanvasNode,
} from '../canvas-document'
import { promoteCanvasResultMedia } from '../canvas-results'
import {
  mergeCanvasUploadConflict,
  readOverwrittenLocalData,
  watchCanvasUploadConflicts,
} from '../canvas-upload-conflicts'

const local = canvasOrigin('user', 'test')
const remote = canvasOrigin('system', 'remote')
const media = '11111111-1111-4111-8111-111111111111'
const claim = { [CANVAS_UPLOAD_DEVICE_META]: 'uploader', [CANVAS_UPLOAD_STARTED_META]: '1000' }

function device(clientID: number) {
  const doc = new Y.Doc()
  doc.clientID = clientID
  const stop = watchCanvasUploadConflicts(doc, (origin) => origin === remote, local)
  return { doc, stop }
}
function data(doc: Y.Doc): ImageNodeData {
  return readCanvasDocument(doc).nodes.find((node) => node.id === 'image')?.data as ImageNodeData
}
function edit(doc: Y.Doc, patch: Partial<ImageNodeData>) {
  updateCanvasNode(doc, 'image', { data: { ...data(doc), ...patch } }, local)
}
async function exchange(a: Y.Doc, b: Y.Doc) {
  // 两边各自离线改完，再互相发更新，等补写的微任务跑完后再同步一轮。
  const toB = Y.encodeStateAsUpdate(a, Y.encodeStateVector(b))
  const toA = Y.encodeStateAsUpdate(b, Y.encodeStateVector(a))
  Y.applyUpdate(b, toB, remote)
  Y.applyUpdate(a, toA, remote)
  await Promise.resolve()
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)), remote)
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)), remote)
  await Promise.resolve()
}
function pair(editorId: number, uploaderId: number) {
  const editor = device(editorId)
  const uploader = device(uploaderId)
  insertCanvasNode(
    uploader.doc,
    {
      id: 'image',
      type: 'image',
      x: 0,
      y: 0,
      width: 100,
      height: 80,
      data: { fileId: 'local-file', name: 'photo', meta: claim },
    },
    local,
  )
  Y.applyUpdate(editor.doc, Y.encodeStateAsUpdate(uploader.doc), remote)
  return { editor, uploader }
}

describe('上传簿记与并发编辑', () => {
  // 两种 clientID 顺序分别让「改名」和「收成云媒体」在 Yjs 的取舍里赢一次。
  for (const [editorId, uploaderId] of [
    [1, 2],
    [2, 1],
  ] as const)
    it(`收成云媒体与别的设备改名并发时两边都保留（editor=${editorId}）`, async () => {
      const { editor, uploader } = pair(editorId, uploaderId)
      edit(editor.doc, { name: 'renamed' })
      promoteCanvasResultMedia(uploader.doc, 'image', 'local-file', media, local)

      await exchange(editor.doc, uploader.doc)

      for (const doc of [editor.doc, uploader.doc]) {
        expect(data(doc).name).toBe('renamed')
        expect(data(doc).mediaId).toBe(media)
        expect(data(doc).fileId).toBe(`cloud-${media}`)
        expect(data(doc).meta?.[CANVAS_UPLOAD_DEVICE_META]).toBeUndefined()
      }
      editor.stop()
      uploader.stop()
    })

  for (const [editorId, uploaderId] of [
    [1, 2],
    [2, 1],
  ] as const)
    it(`续写上传声明与别的设备改提示词并发时两边都保留（editor=${editorId}）`, async () => {
      const { editor, uploader } = pair(editorId, uploaderId)
      edit(editor.doc, { meta: { ...data(editor.doc).meta, nodePrompt: 'a cat' } })
      edit(uploader.doc, { meta: { ...claim, [CANVAS_UPLOAD_STARTED_META]: '2000' } })

      await exchange(editor.doc, uploader.doc)

      for (const doc of [editor.doc, uploader.doc]) {
        expect(data(doc).meta?.nodePrompt).toBe('a cat')
        expect(data(doc).meta?.[CANVAS_UPLOAD_STARTED_META]).toBe('2000')
      }
      editor.stop()
      uploader.stop()
    })

  it('先后修改（远端看过本机这一版）不补写', async () => {
    const { editor, uploader } = pair(1, 2)
    edit(editor.doc, { name: 'renamed' })
    Y.applyUpdate(uploader.doc, Y.encodeStateAsUpdate(editor.doc), remote)
    await Promise.resolve()
    edit(uploader.doc, { name: 'renamed again' })
    const writes: unknown[] = []
    editor.doc.on('update', (_update: Uint8Array, origin: unknown) => {
      if (origin === local) writes.push(origin)
    })

    await exchange(editor.doc, uploader.doc)

    expect(data(editor.doc).name).toBe('renamed again')
    expect(writes).toHaveLength(0)
    editor.stop()
    uploader.stop()
  })

  it('两边都是用户编辑时照 Yjs 原样取舍', async () => {
    const { editor, uploader } = pair(1, 2)
    edit(editor.doc, { name: 'editor' })
    edit(uploader.doc, { name: 'uploader' })

    await exchange(editor.doc, uploader.doc)

    expect(data(editor.doc).name).toBe(data(uploader.doc).name)
    expect(['editor', 'uploader']).toContain(String(data(editor.doc).name))
    editor.stop()
    uploader.stop()
  })

  it('mergeCanvasUploadConflict 只认上传簿记', () => {
    const base = { fileId: 'local-file', name: 'photo', meta: claim }
    const promoted = {
      ...base,
      mediaId: media,
      fileId: `cloud-${media}`,
      meta: { contentIdentity: 'local-file' },
    }
    expect(mergeCanvasUploadConflict({ ...base, name: 'x' }, promoted)).toEqual({
      ...promoted,
      name: 'x',
    })
    expect(mergeCanvasUploadConflict(promoted, { ...base, name: 'x' })).toEqual({
      ...promoted,
      name: 'x',
    })
    expect(
      mergeCanvasUploadConflict({ ...base, name: 'x' }, { ...base, name: 'y' }),
    ).toBeUndefined()
    expect(mergeCanvasUploadConflict(base, promoted)).toBeUndefined()
  })

  it('本机这一版经远端多个中间版本后才被覆盖时，是先后改，不补写', async () => {
    const { editor, uploader } = pair(1, 2)
    promoteCanvasResultMedia(editor.doc, 'image', 'local-file', media, local)
    // 远端看过本机这一版后连改两次，两次更新一起到达。
    Y.applyUpdate(uploader.doc, Y.encodeStateAsUpdate(editor.doc), remote)
    await Promise.resolve()
    edit(uploader.doc, { name: 'first' })
    edit(uploader.doc, { name: 'second', mediaId: undefined, fileId: 'local-file' })
    const writes: unknown[] = []
    editor.doc.on('update', (_update: Uint8Array, origin: unknown) => {
      if (origin === local) writes.push(origin)
    })

    Y.applyUpdate(
      editor.doc,
      Y.encodeStateAsUpdate(uploader.doc, Y.encodeStateVector(editor.doc)),
      remote,
    )
    await Promise.resolve()

    expect(writes).toHaveLength(0)
    expect(data(editor.doc).name).toBe('second')
    expect(data(editor.doc).mediaId).toBeUndefined()
    editor.stop()
    uploader.stop()
  })

  it('停止监听后已排队的补写作废', async () => {
    const { editor, uploader } = pair(1, 2)
    edit(editor.doc, { name: 'renamed' })
    promoteCanvasResultMedia(uploader.doc, 'image', 'local-file', media, local)
    const writes: unknown[] = []
    editor.doc.on('update', (_update: Uint8Array, origin: unknown) => {
      if (origin === local) writes.push(origin)
    })
    const loser = editor.doc.clientID < uploader.doc.clientID ? editor : uploader
    const other = loser === editor ? uploader : editor
    loser.doc.on('update', (_update: Uint8Array, origin: unknown) => {
      if (origin === local) writes.push(origin)
    })
    Y.applyUpdate(
      loser.doc,
      Y.encodeStateAsUpdate(other.doc, Y.encodeStateVector(loser.doc)),
      remote,
    )
    loser.stop()
    await Promise.resolve()

    expect(writes).toHaveLength(0)
    other.stop()
  })

  it('合并结果与赢的一版只差键顺序时不重复写回', () => {
    const base = { fileId: 'local-file', name: 'photo', meta: claim }
    const winner = {
      meta: { contentIdentity: 'local-file' },
      name: 'x',
      mediaId: media,
      fileId: `cloud-${media}`,
    }
    expect(mergeCanvasUploadConflict({ ...base, name: 'x' }, winner)).toBeUndefined()
  })

  it('Yjs 内部结构不认识时当作没有冲突，不抛错', () => {
    const fake = {
      target: {},
      adds: () => true,
      deletes: () => true,
    } as unknown as Y.YEvent<Y.AbstractType<unknown>>
    expect(readOverwrittenLocalData(fake, 1)).toBeUndefined()
    const broken = {
      target: { _map: new Map([['data', { id: { client: 1 } }]]) },
      adds: () => true,
      deletes: () => true,
    } as unknown as Y.YEvent<Y.AbstractType<unknown>>
    expect(readOverwrittenLocalData(broken, 1)).toBeUndefined()
  })
})

describe('Yjs 内部结构契约（升级 yjs 时这里失败就要同步改 readOverwrittenLocalData）', () => {
  it('Y.Map 的 _map 条目带 id/left/origin/deleted/content，并发覆盖可以读出输掉的一版', async () => {
    const a = new Y.Doc()
    a.clientID = 1
    const b = new Y.Doc()
    b.clientID = 2
    const nodeA = a.getMap<Y.Map<unknown>>('nodes')
    a.transact(() => {
      const node = new Y.Map<unknown>()
      node.set('data', { v: 'base' })
      nodeA.set('n', node)
    })
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
    a.getMap<Y.Map<unknown>>('nodes').get('n')?.set('data', { v: 'from-a' })
    b.getMap<Y.Map<unknown>>('nodes').get('n')?.set('data', { v: 'from-b' })

    const item = (
      nodeA.get('n') as unknown as { _map: Map<string, Record<string, unknown>> }
    )._map.get('data')
    for (const key of ['id', 'left', 'origin', 'deleted', 'content'])
      expect(item && key in item).toBe(true)

    const seen: { lost: unknown; winner: unknown }[] = []
    nodeA.observeDeep((events) => {
      for (const event of events) {
        const overwritten = readOverwrittenLocalData(event, a.clientID)
        if (overwritten) seen.push(overwritten)
      }
    })
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)))
    // clientID 大的一方（b）在 Yjs 的取舍里赢，a 的那一版被并发顶掉。
    expect(seen).toEqual([{ lost: { v: 'from-a' }, winner: { v: 'from-b' } }])
  })
})
