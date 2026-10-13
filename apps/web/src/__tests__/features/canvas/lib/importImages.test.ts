// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import { CanvasEditor } from '../../../../features/canvas/lib/editor'
import { importImageFiles } from '../../../../features/canvas/lib/importImages'

vi.mock('../../../../lib/canvasImage', () => ({
  getImageDimensions: vi.fn(),
}))

import { getImageDimensions } from '../../../../lib/canvasImage'

it('keeps imported images but does not reselect them after reference context is cleared', async () => {
  let finish!: (value: { width: number; height: number }) => void
  vi.mocked(getImageDimensions).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const editor = new CanvasEditor(new CanvasDoc())
  const place = vi.spyOn(editor, 'placeImages').mockReturnValue(['imported'])
  const select = vi.spyOn(editor, 'setSelectedElements')
  let selectImported = true
  const imported = importImageFiles(
    editor,
    [new File(['image'], 'old.png', { type: 'image/png' })],
    { x: 0, y: 0 },
    () => selectImported,
  )
  await vi.waitFor(() => expect(getImageDimensions).toHaveBeenCalled())
  selectImported = false
  finish({ width: 100, height: 100 })
  expect(await imported).toBe(1)
  expect(place).toHaveBeenCalledOnce()
  expect(select).not.toHaveBeenCalled()
  vi.restoreAllMocks()
})
