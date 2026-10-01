// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import CanvasImageToolbar from '../../../../features/canvas/components/CanvasImageToolbar'
import { useInpaintSession } from '../../../../features/canvas/inpaintStore'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import { CanvasEditor } from '../../../../features/canvas/lib/editor'

vi.mock('../../../../lib/canvasImage', () => ({
  loadImage: async () => ({ naturalWidth: 1024, naturalHeight: 1024 }),
}))
vi.mock('../../../../features/canvas/lib/submitInpaint', () => ({ inpaintRefusal: () => null }))
vi.mock('../../../../lib/privateOverlay', () => ({
  usePrivateSubmissionGuard: () => ({ blocked: false, disabledReason: null }),
}))

it('inserts region 1 after restarting intelligent edit or switching back from erase', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const doc = new CanvasDoc()
  doc.addElements(
    [
      {
        id: 'image',
        type: 'image',
        x: 0,
        y: 0,
        width: 300,
        height: 300,
        rotation: 0,
        fileId: 'file',
      },
    ],
    { files: { file: 'data:image/png;base64,AA==' } },
  )
  doc.setSelection(['image'])
  const editor = new CanvasEditor(doc)
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const click = async (label: string) => {
    const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (item) => item.getAttribute('aria-label') === label,
    )
    expect(button?.disabled).toBe(false)
    await act(async () => button!.click())
  }
  const draw = () =>
    act(() =>
      useInpaintSession.getState().addStroke({
        tool: 'brush',
        shape: 'rect',
        width: 0,
        points: [
          { x: 10, y: 10 },
          { x: 80, y: 80 },
        ],
      }),
    )
  try {
    act(() => root.render(<CanvasImageToolbar editor={editor} />))
    await click('智能改图')
    draw()
    expect(host.querySelector('[contenteditable]')?.textContent).toContain('@区域1')
    const send = [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.includes('发送给 Agent'),
    )
    expect(send?.disabled).toBe(true)
    act(() =>
      useInpaintSession.getState().setPrompt(useInpaintSession.getState().prompt + '修改颜色'),
    )
    expect(send?.disabled).toBe(false)
    await click('智能改图')
    expect(useInpaintSession.getState().prompt).toBe('')
    draw()
    expect(host.querySelector('[contenteditable]')?.textContent).toContain('@区域1')
    await click('擦除')
    await click('智能改图')
    draw()
    expect(host.querySelector('[contenteditable]')?.textContent).toContain('@区域1')
  } finally {
    act(() => root.unmount())
    host.remove()
    useInpaintSession.getState().close()
  }
})
