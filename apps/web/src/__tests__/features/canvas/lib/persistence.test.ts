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
