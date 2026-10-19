// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import { CanvasEditor } from '../../../../features/canvas/lib/editor'
import { readPersistedScene } from '../../../../features/canvas/lib/persistence'
import { type CloudSceneStrategy, SceneRecord } from '../../../../features/canvas/lib/sceneRecord'
import { useCanvasProjectStore } from '../../../../features/canvas/projectStore'
import { setClientStorageScope } from '../../../../lib/authScope'
import { configureErrorReporting } from '../../../../lib/errorReporting'
import { _setRuntimeConfigForTesting, getRuntimeConfig } from '../../../../lib/runtimeConfig'
import { captureClientErrors } from '../../../helpers/clientErrors'
import { abortNextPut, freshSceneKey, openSceneRecord } from '../../../helpers/sceneRecord'

vi.mock('../../../../store', () => ({ useStore: { getState: () => ({ showToast: vi.fn() }) } }))

const runtime = getRuntimeConfig()
afterEach(() => {
  setClientStorageScope(null)
  _setRuntimeConfigForTesting(runtime)
  vi.restoreAllMocks()
})

describe('项目画布存档', () => {
  it('事务提交完成才算落盘，中止后重试仍会把这份写下去', async () => {
    const reports = captureClientErrors()
    const key = freshSceneKey()
    const record = await openSceneRecord(key)
    record.editor.doc.setCamera({ x: 123 })
    expect(await record.flush()).toBe(true)
    expect((await readPersistedScene(key))?.camera.x).toBe(123)

    const spy = abortNextPut()
    record.editor.doc.setCamera({ x: 4 })
    expect(await record.flush()).toBe(false)
    expect(record.getSnapshot().saveFailed).toBe(true)
    const failure = (await reports()).flatMap((batch) => batch.errors)
    expect(failure).toHaveLength(1)
    expect(failure[0]?.context).toMatchObject({ operation: 'canvas.scene.save', stage: 'put' })
    expect((await reports()).flatMap((batch) => batch.recoveries ?? [])).toEqual([])
    spy.mockRestore()
    // 文档没有再变，但上一次没落下去：这一次必须重写，不能当成「盘上已经是它」。
    expect(await record.flush()).toBe(true)
    expect((await readPersistedScene(key))?.camera.x).toBe(4)
    expect((await reports()).flatMap((batch) => batch.recoveries ?? [])).toEqual([
      { operation: 'canvas.scene.save', incidentId: failure[0]?.context?.incidentId },
    ])
    record.dispose()
  })

  it('catalog failure survives repeated flush failures and a successful checkpoint write', async () => {
    const reports = captureClientErrors()
    const record = await openSceneRecord(freshSceneKey())
    const catalog = vi.spyOn(useCanvasProjectStore.getState(), 'recordScene')
    catalog.mockRejectedValue(new Error('private-catalog-file-name'))
    record.editor.doc.setCamera({ x: 71 })
    expect(await record.flush()).toBe(false)
    expect(await record.flush()).toBe(false)
    expect(await record.persist()).toBe(true)
    const failed = (await reports()).flatMap((batch) => batch.errors)
    expect(failed).toHaveLength(1)
    expect(failed[0]?.context).toMatchObject({ stage: 'catalog' })
    expect((await reports()).flatMap((batch) => batch.recoveries ?? [])).toEqual([])
    catalog.mockRestore()
    expect(await record.flush()).toBe(true)
    expect((await reports()).flatMap((batch) => batch.recoveries ?? [])).toEqual([
      { operation: 'canvas.scene.save', incidentId: failed[0]?.context?.incidentId },
    ])
    expect(JSON.stringify(await reports())).not.toContain('private-catalog-file-name')
    record.dispose()
  })

  it('a failed checkpoint is not recovered by a no-change flush or another entry point', async () => {
    const reports = captureClientErrors()
    const record = await openSceneRecord(freshSceneKey())
    abortNextPut()
    expect(await record.persist()).toBe(false)
    expect(await record.flush()).toBe(true)
    record.editor.doc.setCamera({ x: 17 })
    expect(await record.flush()).toBe(true)
    expect((await reports()).flatMap((batch) => batch.recoveries ?? [])).toEqual([])
    expect(await record.persist()).toBe(true)
    expect((await reports()).flatMap((batch) => batch.recoveries ?? [])).toHaveLength(1)
    record.dispose()
  })

  it('a cloud save that does not commit a transaction cannot recover a failed save', async () => {
    const reports = captureClientErrors()
    const record = await openSceneRecord(freshSceneKey())
    abortNextPut()
    record.editor.doc.setCamera({ x: 73 })
    expect(await record.flush()).toBe(false)
    record.useCloud({
      checkpoint: () => ({
        version: 1,
        name: 'project',
        revision: 0,
        savedContent: null,
        pending: null,
        conflict: false,
      }),
      save: async () => true,
      markChanged() {},
      requestSync() {},
    })
    expect(await record.flush()).toBe(true)
    expect((await reports()).flatMap((batch) => batch.recoveries ?? [])).toEqual([])
    record.dispose()
  })

  it.each([
    'same target',
    'different target',
  ])('rebind recovery requires the same old and new key: %s', async (retry) => {
    const reports = captureClientErrors()
    const oldKey = freshSceneKey()
    const target = freshSceneKey()
    const record = await openSceneRecord(oldKey)
    record.editor.doc.setCamera({ x: 29 })
    await record.flush()
    abortNextPut()
    expect(await record.rebind(target)).toBe(false)
    expect(record.key).toBe(oldKey)
    expect(await record.persist()).toBe(true)
    expect((await reports()).flatMap((batch) => batch.recoveries ?? [])).toEqual([])
    const destination = retry === 'same target' ? target : freshSceneKey()
    expect(await record.rebind(destination)).toBe(true)
    expect(record.key).toBe(destination)
    expect((await readPersistedScene(destination))?.camera.x).toBe(29)
    expect(await readPersistedScene(oldKey)).toBeUndefined()
    expect((await reports()).flatMap((batch) => batch.recoveries ?? [])).toHaveLength(
      retry === 'same target' ? 1 : 0,
    )
    record.dispose()
  })

  it('captures the target after an earlier queued rebind completes', async () => {
    const reports = captureClientErrors()
    const record = await openSceneRecord(freshSceneKey())
    const target = freshSceneKey()
    const checkpoint = {
      version: 1,
      name: 'project',
      revision: 0,
      savedContent: null,
      pending: null,
      conflict: false,
    } as const
    record.useCloud({
      checkpoint: () => checkpoint,
      save: vi
        .fn<CloudSceneStrategy['save']>()
        .mockRejectedValueOnce(new Error('queue failure'))
        .mockImplementation((write) => write(checkpoint)),
      markChanged() {},
      requestSync() {},
    })
    record.editor.doc.setCamera({ x: 31 })
    const rebound = record.rebind(target)
    const persist = record.persist()
    expect(await rebound).toBe(true)
    expect(await persist).toBe(false)
    const failed = (await reports()).flatMap((batch) => batch.errors)
    expect(failed[0]?.context).toMatchObject({ stage: 'queue' })
    expect(await record.persist()).toBe(true)
    expect((await readPersistedScene(target))?.camera.x).toBe(31)
    expect((await reports()).flatMap((batch) => batch.recoveries ?? [])).toEqual([
      { operation: 'canvas.scene.save', incidentId: failed[0]?.context?.incidentId },
    ])
    record.dispose()
  })

  it.each([
    'dispose',
    'account',
    'endpoint',
    'backend',
  ])('does not recover after %s changes', async (change) => {
    const reports = captureClientErrors()
    const record = await openSceneRecord(freshSceneKey())
    abortNextPut()
    expect(await record.persist()).toBe(false)
    if (change === 'dispose') record.dispose()
    else if (change === 'account') setClientStorageScope('other')
    else if (change === 'endpoint') configureErrorReporting('https://other.test')
    else
      _setRuntimeConfigForTesting({
        ...runtime,
        bff: { ...runtime.bff, baseUrl: 'https://other.test' },
      })
    await record.persist()
    expect((await reports()).flatMap((batch) => batch.recoveries ?? [])).toEqual([])
    record.dispose()
  })

  it('does not recover a checkpoint incident while the record is reopening', async () => {
    const reports = captureClientErrors()
    const record = await openSceneRecord(freshSceneKey())
    abortNextPut()
    expect(await record.persist()).toBe(false)
    let finish!: () => void
    const attaching = new Promise<void>((resolve) => {
      finish = resolve
    })
    const opened = record.open(() => attaching)
    expect(await record.persist()).toBe(true)
    expect((await reports()).flatMap((batch) => batch.recoveries ?? [])).toEqual([])
    finish()
    await opened
    expect(await record.persist()).toBe(true)
    expect((await reports()).flatMap((batch) => batch.recoveries ?? [])).toHaveLength(1)
    record.dispose()
  })

  it('盘上那份只读一次：重开不拿磁盘那份盖掉内存里更新的文档', async () => {
    const key = freshSceneKey()
    const seed = await openSceneRecord(key)
    seed.editor.doc.setCamera({ x: 81 })
    await seed.flush()

    const record = await openSceneRecord(key)
    expect(record.editor.doc.camera.x).toBe(81)
    record.editor.doc.setCamera({ x: 7 })
    await record.open()
    expect(record.editor.doc.camera.x).toBe(7)
  })

  it('读不到就不许写：读失败期间不落盘，重开成功后恢复原内容（ADR-0005）', async () => {
    const key = freshSceneKey()
    const seed = await openSceneRecord(key)
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
    const key = freshSceneKey()
    const stale = await openSceneRecord(key)
    const newer = await openSceneRecord(key)
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
    const backup = await openSceneRecord('scene')
    backup.editor.doc.setCamera({ x: 987 })
    await backup.flush()

    const first = await openSceneRecord('conversation:a', { migrateLegacy: true })
    expect(first.editor.doc.camera.x).toBe(987)
    const second = await openSceneRecord('conversation:b', { migrateLegacy: true })
    expect(second.editor.doc.camera.x).toBe(0)

    first.editor.doc.setCamera({ x: 123 })
    await first.flush()
    expect((await readPersistedScene('scene'))?.camera.x).toBe(987)
  })
})
