// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import AgentCanvasHandoffDialog from '../../../../features/agent/components/AgentCanvasHandoffDialog'
import AgentPromptDialog from '../../../../features/agent/components/AgentPromptDialog'

const { saveTemplate, copy } = vi.hoisted(() => ({ saveTemplate: vi.fn(), copy: vi.fn() }))
vi.mock('../../../../features/library/store', () => ({
  useLibraryStore: { getState: () => ({ savePromptTemplate: saveTemplate }) },
}))
vi.mock('../../../../lib/clipboard', () => ({
  copyTextToClipboard: copy,
  getClipboardFailureMessage: (message: string) => message,
}))
let host: HTMLDivElement
let root: Root
globalThis.IS_REACT_ACT_ENVIRONMENT = true
beforeEach(() => {
  vi.resetAllMocks()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})
function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find(
    (item) => item.textContent?.trim() === text || item.getAttribute('aria-label') === text,
  )
  if (!found) throw new Error(`Missing button: ${text}`)
  return found
}

it('keeps the canvas handoff open and disabled while choosing, then allows retry after failure', async () => {
  let finish!: (value: boolean) => void
  const onChoose = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve
      }),
  )
  const onClose = vi.fn()
  act(() =>
    root.render(
      <AgentCanvasHandoffDialog count={1} projects={[]} onChoose={onChoose} onClose={onClose} />,
    ),
  )
  const choose = document.querySelector<HTMLButtonElement>(
    '[role="dialog"] button:not([aria-label])',
  )!
  expect(document.activeElement).toBe(choose)
  act(() => choose.click())
  expect(onChoose).toHaveBeenCalledOnce()
  expect([...document.querySelectorAll('button')].every((item) => item.disabled)).toBe(true)
  act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(onClose).not.toHaveBeenCalled()
  await act(async () => finish(false))
  expect(document.querySelector('[role="alert"]')).not.toBeNull()
  expect(choose.disabled).toBe(false)
  expect(document.activeElement).toBe(choose)
  act(() => document.querySelector<HTMLButtonElement>('button[aria-label]')!.click())
  expect(onClose).toHaveBeenCalledOnce()
})

it('saves the complete prompt once and returns focus to the template action', async () => {
  let finish!: () => void
  saveTemplate.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
  )
  const prompt = '第一段\n第二段'
  act(() => root.render(<AgentPromptDialog prompt={prompt} onClose={() => {}} />))
  const save = button('存为模板')
  act(() => save.click())
  const field = document.querySelector('input')!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      field,
      '模板示例',
    )
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const submit = document.querySelector<HTMLButtonElement>('button[type="submit"]')!
  act(() => submit.click())
  expect(saveTemplate).toHaveBeenCalledWith('模板示例', prompt)
  expect(submit.disabled).toBe(true)
  await act(async () => finish())
  expect(document.querySelector('form')).toBeNull()
  expect(document.activeElement).toBe(save)
})
