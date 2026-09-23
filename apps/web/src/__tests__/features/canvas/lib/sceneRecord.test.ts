// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import { CanvasEditor } from '../../../../features/canvas/lib/editor'
import { readPersistedScene } from '../../../../features/canvas/lib/persistence'
import { SceneRecord } from '../../../../features/canvas/lib/sceneRecord'

vi.mock('../../../../store', () => ({ useStore: { getState: () => ({ showToast: vi.fn() }) } }))

afterEach(() => vi.restoreAllMocks())

const freshKey = () => `scene-record:${crypto.randomUUID()}`

async function opened(key: string, migrateLegacy = false): Promise<SceneRecord> {
  const record = new SceneRecord(new CanvasEditor(new CanvasDoc()), key, migrateLegacy)
  await record.open()
  return record
}

function abortNextPut() {
  const put = IDBObjectStore.prototype.put
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  return vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(function (
    this: IDBObjectStore,
    ...args: Parameters<IDBObjectStore['put']>
  ) {
    const request = put.apply(this, args)
    this.transaction.abort()
    return request
  })
}

describe('项目画布存档', () => {
  it('事务提交完成才算落盘，中止后重试仍会把这份写下去', async () => {
    const key = freshKey()
    const record = await opened(key)
    record.editor.doc.setCamera({ x: 123 })
    expect(await record.flush()).toBe(true)
    expect((await readPersistedScene(key))?.camera.x).toBe(123)

    const spy = abortNextPut()
    record.editor.doc.setCamera({ x: 4 })
    expect(await record.flush()).toBe(false)
    expect(record.getSnapshot().saveFailed).toBe(true)
    spy.mockRestore()
    // 文档没有再变，但上一次没落下去：这一次必须重写，不能当成「盘上已经是它」。
    expect(await record.flush()).toBe(true)
    expect((await readPersistedScene(key))?.camera.x).toBe(4)
  })

  it('盘上那份只读一次：重开不拿磁盘那份盖掉内存里更新的文档', async () => {
    const key = freshKey()
    const seed = await opened(key)
    seed.editor.doc.setCamera({ x: 81 })
    await seed.flush()

    const record = await opened(key)
    expect(record.editor.doc.camera.x).toBe(81)
    record.editor.doc.setCamera({ x: 7 })
    await record.open()
    expect(record.editor.doc.camera.x).toBe(7)
  })

  it('读不到就不许写：读失败期间不落盘，重开成功后恢复原内容（ADR-0005）', async () => {
    const key = freshKey()
    const seed = await opened(key)
    seed.editor.doc.setCamera({ x: 81 })
    await seed.flush()

    vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementationOnce(() => {
      throw new Error('offline storage')
    })
    const record = new SceneRecord(new CanvasEditor(new CanvasDoc()), key)
    await expect(record.open()).rejects.toThrow()
    expect(record.getSnapshot().loadFailed).toBe(true)
    expect(await record.flush()).toBe(false)
    expect(await record.persist()).toBe(false)
    expect((await readPersistedScene(key))?.camera.x).toBe(81)

    await record.open()
    expect(record.editor.doc.camera.x).toBe(81)
    record.editor.doc.setCamera({ x: 9 })
    expect(await record.flush()).toBe(true)
    expect((await readPersistedScene(key))?.camera.x).toBe(9)
  })

  it('只挪过相机的旧标签页不覆盖另一标签页写下的新结构', async () => {
    const key = freshKey()
    const stale = await opened(key)
    const newer = await opened(key)
    newer.editor.doc.addElements([
      {
        id: 'note',
        type: 'text',
        x: 0,
        y: 0,
        width: 100,
        height: 30,
        text: '另一标签页的新内容',
        fontSize: 24,
        fill: '#000',
      },
    ])
    expect(await newer.flush()).toBe(true)

    stale.editor.doc.setCamera({ x: 5 })
    expect(await stale.flush()).toBe(true)
    const saved = await readPersistedScene(key)
    expect(saved?.elements).toHaveLength(1)
    expect(saved?.camera.x).toBe(5)
  })

  it('旧单场景只被一个画布认领，备份保持不变', async () => {
    const backup = await opened('scene')
    backup.editor.doc.setCamera({ x: 987 })
    await backup.flush()

    const first = await opened('conversation:a', true)
    expect(first.editor.doc.camera.x).toBe(987)
    const second = await opened('conversation:b', true)
    expect(second.editor.doc.camera.x).toBe(0)

    first.editor.doc.setCamera({ x: 123 })
    await first.flush()
    expect((await readPersistedScene('scene'))?.camera.x).toBe(987)
  })
})
