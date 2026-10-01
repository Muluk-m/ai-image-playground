// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import RegionPromptEditor, { useRegionPrompt } from '../../components/RegionPromptEditor'
import { setContentEditableCursor } from '../../lib/promptEditorDom'

vi.mock('../../i18n', () => ({ useTranslation: () => ({ t: translate }) }))
const translate = (key: string, values?: { no: number }) =>
  key === 'inpaint.regionName'
    ? `区域 ${values?.no}`
    : key === 'inpaint.regionRemoved'
      ? '（已移除）'
      : key

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement
let root: Root
let regions: (ids: number[]) => void
let prompt: ReturnType<typeof useRegionPrompt>
let rerender: (value: string) => void
function Harness() {
  const [ids, setIds] = useState<number[]>([])
  const [value, setValue] = useState('前文后文')
  regions = setIds
  rerender = setValue
  prompt = useRegionPrompt({
    ids,
    value,
    onChange: setValue,
    onRemove: (id) => setIds(ids.filter((v) => v !== id)),
  })
  return <RegionPromptEditor prompt={prompt} label="编辑要求" placeholder="编辑要求" />
}
const editable = () => host.querySelector<HTMLElement>('[contenteditable]')!
beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root.render(<Harness />))
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  window.getSelection()?.removeAllRanges()
})
describe('inline region references', () => {
  it('inserts once at the saved caret without replacing surrounding prose', () => {
    editable().focus()
    setContentEditableCursor(editable(), 2)
    act(() => prompt.onBlur())
    act(() => regions([41]))
    expect(prompt.serialize()).toBe('前文@区域1 后文')
    act(() => regions([41]))
    expect(prompt.serialize()).toBe('前文@区域1 后文')
    expect(host.querySelectorAll('.region-prompt-chip')).toHaveLength(1)
  })
  it('invalidates undone references, restores on redo, and never retargets a stale number', () => {
    act(() => regions([41, 73]))
    expect(prompt.serialize()).toBe('前文后文@区域1 @区域2 ')
    act(() => regions([41]))
    expect(prompt.hasMissing).toBe(true)
    expect(host.textContent).toContain('@区域2（已移除）')
    act(() => regions([41, 73]))
    expect(prompt.hasMissing).toBe(false)
    expect(prompt.serialize()).toBe('前文后文@区域1 @区域2 ')
    act(() => regions([73, 90]))
    expect(prompt.numberFor(73)).toBe(2)
    expect(prompt.numberFor(90)).toBe(3)
    expect(prompt.hasMissing).toBe(true)
  })
  it('removes the corresponding region through the inline chip, preserving prose', () => {
    act(() => regions([41, 73]))
    act(() => host.querySelector<HTMLButtonElement>('.region-prompt-chip button')!.click())
    expect(prompt.serialize()).toBe('前文后文 @区域2 ')
    expect(prompt.hasMissing).toBe(false)
    expect(host.querySelectorAll('.region-prompt-chip')).toHaveLength(1)
    act(() => regions([73]))
    expect(prompt.serialize()).toBe('前文后文 @区域2 ')
  })
  it('defers incoming regions until IME commits without replacing its DOM node', () => {
    editable().focus()
    act(() => editable().dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })))
    const node = editable().firstChild as Text
    node.data = '前文中文后文'
    setContentEditableCursor(editable(), 4)
    act(() =>
      editable().dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true })),
    )
    act(() => regions([41]))
    expect(editable().firstChild).toBe(node)
    expect(host.querySelectorAll('.region-prompt-chip')).toHaveLength(0)
    act(() => editable().dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })))
    expect(prompt.serialize()).toBe('前文中文@区域1 后文')
  })
  it('does not reinsert a manually removed reference when the user keeps editing', () => {
    act(() => regions([41]))
    act(() => rerender('新要求'))
    expect(prompt.serialize()).toBe('新要求')
    expect(prompt.hasMissing).toBe(false)
  })
})
