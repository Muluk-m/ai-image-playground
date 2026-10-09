// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ExportForm from '../../../features/image-export/ExportForm'
import { TOOLS } from '../../../features/toolbox/lib/registry'

vi.mock('../../../i18n', () => {
  const t = (key: string) => key
  return { useTranslation: () => ({ t }) }
})
vi.mock('../../../features/toolbox/lib/deliver', () => ({ downloadImages: vi.fn() }))
const sources = [
  { id: 'one', name: 'photo', media: 'image' as const, load: async () => new Blob(['image']) },
]
let host: HTMLDivElement
let root: Root
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ width: 1440, height: 1080, close: vi.fn() })),
  )
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})
async function fill(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
function exportButton() {
  return [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === 'export.action',
  )!
}
describe('image resize editing', () => {
  it('allows clearing the final digit, blocks export while empty and links the next size', async () => {
    await act(async () => root.render(<ExportForm sources={sources} />))
    const width = host.querySelector<HTMLInputElement>('#export-width')!
    const height = host.querySelector<HTMLInputElement>('#export-height')!
    await fill(width, '2')
    await fill(width, '')
    expect(width.value).toBe('')
    expect(exportButton().disabled).toBe(true)
    await fill(width, '720')
    expect(width.value).toBe('720')
    expect(height.value).toBe('540')
    expect(exportButton().disabled).toBe(false)
    await fill(height, '')
    expect(height.value).toBe('')
    expect(exportButton().disabled).toBe(true)
    await fill(height, '1080')
    expect(width.value).toBe('1440')
    expect(exportButton().disabled).toBe(false)
  })
  it('keeps invalid fractional pixels editable without enabling export', async () => {
    await act(async () => root.render(<ExportForm sources={sources} />))
    const width = host.querySelector<HTMLInputElement>('#export-width')!
    await fill(width, '2.5')
    expect(width.value).toBe('2.5')
    expect(exportButton().disabled).toBe(true)
    await fill(width, '240')
    expect(host.querySelector<HTMLInputElement>('#export-height')!.value).toBe('180')
    expect(exportButton().disabled).toBe(false)
  })
  it('exposes only the replacement image resize tool', () => {
    expect(TOOLS.filter((tool) => tool.id === 'export')).toHaveLength(1)
    expect(TOOLS.some((tool) => String(tool.id) === 'resize')).toBe(false)
  })
})
