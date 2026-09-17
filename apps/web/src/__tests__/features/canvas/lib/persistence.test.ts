// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import { CanvasEditor } from '../../../../features/canvas/lib/editor'
import { loadScene, saveScene } from '../../../../features/canvas/lib/persistence'

describe('画布保存', () => {
  it('事务提交完成后才返回成功，并可恢复场景', async () => {
    const editor = new CanvasEditor(new CanvasDoc())
    editor.doc.setCamera({ x: 123 })
    expect(await saveScene(editor)).toBe(true)
    const restored = new CanvasEditor(new CanvasDoc())
    expect(await loadScene(restored)).toBe(true)
    expect(restored.doc.camera.x).toBe(123)
  })
  it('事务中止时返回失败，随后重试能成功', async () => {
    const original = IDBObjectStore.prototype.put
    const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(function (
      this: IDBObjectStore,
      ...args: Parameters<IDBObjectStore['put']>
    ) {
      const request = original.apply(this, args)
      this.transaction.abort()
      return request
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const editor = new CanvasEditor(new CanvasDoc())
    expect(await saveScene(editor)).toBe(false)
    spy.mockRestore()
    warn.mockRestore()
    expect(await saveScene(editor)).toBe(true)
  })
})

describe('画布存档隔离与迁移', () => {
  it('旧单场景仅被一个画布认领，备份保持不变', async () => {
    const old = new CanvasEditor(new CanvasDoc())
    old.doc.setCamera({ x: 987 })
    await saveScene(old)
    const first = new CanvasEditor(new CanvasDoc())
    const second = new CanvasEditor(new CanvasDoc())
    expect(await loadScene(first, 'conversation:a', true)).toBe(true)
    expect(first.doc.camera.x).toBe(987)
    expect(await loadScene(second, 'conversation:b', true)).toBe(false)
    first.doc.setCamera({ x: 123 })
    await saveScene(first, 'conversation:a')
    const backup = new CanvasEditor(new CanvasDoc())
    await loadScene(backup)
    expect(backup.doc.camera.x).toBe(987)
    expect(second.doc.camera.x).toBe(0)
  })
})
