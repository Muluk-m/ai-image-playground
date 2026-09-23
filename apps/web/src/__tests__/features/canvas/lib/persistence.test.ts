// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { expect, it } from 'vitest'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import {
  type CloudSceneCheckpoint,
  openCanvasDatabase,
  persistedScene,
  readPersistedScene,
  writePersistedScene,
} from '../../../../features/canvas/lib/persistence'

const key = () => `persistence:${crypto.randomUUID()}`

const checkpoint: CloudSceneCheckpoint = {
  version: 1,
  name: '云端那份',
  revision: 7,
  savedContent: 'saved',
  pending: null,
  conflict: false,
}

function docWithImage(fileId: string, files: Record<string, string>): CanvasDoc {
  const doc = new CanvasDoc()
  doc.addElements(
    [{ id: 'img', type: 'image', x: 0, y: 0, width: 10, height: 10, rotation: 0, fileId }],
    { files },
  )
  return doc
}

it('要落盘的那一份只带还被引用的位图，删掉的图不再占着存档', () => {
  const doc = docWithImage('kept', {
    kept: 'data:image/png;base64,AAAA',
    gone: 'data:image/png;base64,BBBB',
  })

  expect(persistedScene(doc).files).toEqual({ kept: 'data:image/png;base64,AAAA' })
})

it('认不出的存档格式要报错，不能当成一张空画布交出去（ADR-0005）', async () => {
  const scene = key()
  const db = await openCanvasDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('scene', 'readwrite')
    // 未来版本写下的记录：这台机器上的旧代码读不懂它。
    transaction
      .objectStore('scene')
      .put({ version: 99, elements: [], files: {}, camera: { x: 0, y: 0, zoom: 1 } }, scene)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })

  await expect(readPersistedScene(scene)).rejects.toThrow()
})

it('只在本机的那次写入不抹掉盘上的云端基线', async () => {
  const scene = key()
  await writePersistedScene(persistedScene(new CanvasDoc(), checkpoint), scene)

  const local = docWithImage('kept', { kept: 'data:image/png;base64,AAAA' })
  await writePersistedScene(persistedScene(local), scene)

  const stored = await readPersistedScene(scene)
  expect(stored?.elements).toHaveLength(1)
  expect(stored?.cloud).toEqual(checkpoint)
})
