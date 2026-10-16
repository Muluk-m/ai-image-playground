// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import CanvasEditPromptDialog from '../../../../features/canvas/components/CanvasEditPromptDialog'
import { CanvasDoc, type ImageEl } from '../../../../features/canvas/lib/canvasDoc'
import { CanvasEditor } from '../../../../features/canvas/lib/editor'

const submit = vi.hoisted(() => vi.fn(async () => true))
vi.mock('../../../../features/canvas/lib/canvasImageEdits', () => ({
  submitCanvasImageEdit: submit,
}))
vi.mock('../../../../lib/privateOverlay', () => ({
  usePrivateSubmissionGuard: () => ({ blocked: false }),
}))
globalThis.IS_REACT_ACT_ENVIRONMENT = true

it('names the edit dialog and preserves prompt focus and the keyboard submission', async () => {
  const host = document.createElement('div')
  const opener = document.createElement('button')
  document.body.append(host, opener)
  opener.focus()
  const root = createRoot(host)
  const close = vi.fn()
  const editor = new CanvasEditor(new CanvasDoc())
  const image: ImageEl = {
    id: 'image',
    type: 'image',
    fileId: 'file',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
  }
  try {
    act(() => root.render(<CanvasEditPromptDialog editor={editor} image={image} onClose={close} />))
    const dialog = document.querySelector('[role="dialog"]')!
    expect(document.getElementById(dialog.getAttribute('aria-labelledby') ?? '')?.textContent).toBe(
      '整图编辑',
    )
    const input = dialog.querySelector('textarea')!
    expect(document.activeElement).toBe(input)
    expect(
      dialog.querySelector<HTMLButtonElement>('[data-slot="dialog-footer"] button')?.disabled,
    ).toBe(true)
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        input,
        '保留包装，改为蓝色背景',
      )
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () =>
      input.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    )
    expect(submit).toHaveBeenCalledWith(editor, image, '保留包装，改为蓝色背景')
    expect(close).toHaveBeenCalledOnce()
  } finally {
    act(() => root.unmount())
    expect(document.activeElement).toBe(opener)
    host.remove()
    opener.remove()
  }
})
