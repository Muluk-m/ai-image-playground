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
vi.mock('../../../features/image-export/export', async (importActual) => ({
  ...(await importActual<typeof import('../../../features/image-export/export')>()),
  prepareExports: vi.fn(async (inputs: readonly { load: () => Promise<Blob> }[]) => {
    for (const input of inputs) await input.load()
    return []
  }),
}))
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
  it('reuses the original read for the size preview when exporting one image', async () => {
    const load = vi.fn(async () => new Blob(['image']))
    await act(async () => root.render(<ExportForm sources={[{ ...sources[0], load }]} />))
    await act(async () => exportButton().click())
    expect(load).toHaveBeenCalledTimes(1)
  })
  it('exposes only the replacement image resize tool', () => {
    expect(TOOLS.filter((tool) => tool.id === 'export')).toHaveLength(1)
    expect(TOOLS.some((tool) => String(tool.id) === 'resize')).toBe(false)
  })
  it('clears an empty draft when switching from one image to a batch', async () => {
    await act(async () => root.render(<ExportForm sources={sources} />))
    await fill(host.querySelector<HTMLInputElement>('#export-width')!, '')
    expect(exportButton().disabled).toBe(true)
    await act(async () =>
      root.render(<ExportForm sources={[...sources, { ...sources[0], id: 'two' }]} />),
    )
    expect(host.querySelector<HTMLInputElement>('#export-width')!.value).toBe('')
    expect(host.querySelector('[aria-label="export.size"]')).toBeNull()
    expect(exportButton().disabled).toBe(false)
  })
  it('shows one shared original size in the width and height fields', async () => {
    const batch = [
      { ...sources[0], width: 1440, height: 1440 },
      { ...sources[0], id: 'two', width: 1440, height: 1440 },
    ]
    await act(async () => root.render(<ExportForm sources={batch} />))
    const width = host.querySelector<HTMLInputElement>('#export-width')!
    const height = host.querySelector<HTMLInputElement>('#export-height')!
    expect(host.querySelector('[aria-label="export.size"]')).toBeNull()
    expect(width.value).toBe('1440')
    expect(height.value).toBe('1440')
    await fill(width, '720')
    expect(height.value).toBe('720')
    expect(exportButton().disabled).toBe(false)
  })
  it('links different-sized square images and keeps both fields visible when changing axes', async () => {
    const batch = [
      { ...sources[0], width: 1440, height: 1440 },
      { ...sources[0], id: 'two', width: 2000, height: 2000 },
    ]
    await act(async () => root.render(<ExportForm sources={batch} />))
    const width = host.querySelector<HTMLInputElement>('#export-width')!
    const height = host.querySelector<HTMLInputElement>('#export-height')!
    expect(width.placeholder).toBe('export.multipleValues')
    await fill(width, '1200')
    expect(height.value).toBe('1200')
    await fill(height, '800')
    expect(width.value).toBe('800')
    expect(height.value).toBe('800')
  })
  it('exports a mixed-ratio batch with independent sizes, relocks and resets separately', async () => {
    const { prepareExports } = await import('../../../features/image-export/export')
    const batch = [
      { ...sources[0], width: 1440, height: 1440 },
      { ...sources[0], id: 'two', width: 1600, height: 900 },
    ]
    await act(async () => root.render(<ExportForm sources={batch} />))
    const width = host.querySelector<HTMLInputElement>('#export-width')!
    const height = host.querySelector<HTMLInputElement>('#export-height')!
    const lock = () => host.querySelector<HTMLButtonElement>('button[aria-pressed]')!
    await fill(width, '1200')
    expect(width.value).toBe('1200')
    expect(height.value).toBe('')
    expect(host.textContent).toContain('1200 × 1200')
    expect(host.textContent).toContain('1200 × 675')
    await act(async () => lock().click())
    expect(lock().getAttribute('aria-pressed')).toBe('false')
    expect(width.value).toBe('1200')
    expect(host.textContent).toContain('1200 × 675')
    await fill(height, '800')
    expect(width.value).toBe('1200')
    expect(height.value).toBe('800')
    await act(async () => exportButton().click())
    expect(prepareExports).toHaveBeenLastCalledWith(
      batch,
      expect.objectContaining({
        mode: 'width',
        value: 1200,
        stretch: { height: 800 },
      }),
      expect.any(AbortSignal),
      expect.any(Function),
    )
    await fill(width, '')
    await fill(height, '900')
    expect(width.value).toBe('')
    expect(exportButton().disabled).toBe(true)
    expect(lock().disabled).toBe(true)
    await fill(width, '640')
    expect(height.value).toBe('900')
    await act(async () => lock().click())
    expect(width.value).toBe('640')
    expect(height.value).toBe('')
    expect(host.textContent).toContain('640 × 360')
    const reset = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'export.reset',
    )!
    await act(async () => reset.click())
    expect(host.textContent).toContain('1440 × 1440')
    expect(host.textContent).toContain('1600 × 900')
    expect(lock().getAttribute('aria-pressed')).toBe('true')
  })
  it('allows independent dimensions on a single image and restores its original ratio', async () => {
    await act(async () => root.render(<ExportForm sources={sources} />))
    const width = host.querySelector<HTMLInputElement>('#export-width')!
    const height = host.querySelector<HTMLInputElement>('#export-height')!
    const lock = host.querySelector<HTMLButtonElement>('button[aria-pressed]')!
    await act(async () => lock.click())
    await fill(width, '800')
    await fill(height, '800')
    expect(width.value).toBe('800')
    expect(height.value).toBe('800')
    await act(async () => lock.click())
    expect(width.value).toBe('1067')
    expect(height.value).toBe('800')
  })
})
