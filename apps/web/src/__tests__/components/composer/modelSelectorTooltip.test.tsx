// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { type ModelChoice, ModelList } from '../../../components/composer/ModelSelector'

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
)

const host = document.createElement('div')
document.body.append(host)
let root = createRoot(host)
afterEach(() => {
  act(() => root.unmount())
  root = createRoot(host)
})

const agnes: ModelChoice = {
  value: 'profile::agnes-image-2.5-flash',
  model: 'agnes-image-2.5-flash',
  profileId: 'profile',
  label: 'Agnes 2.5 Flash',
  description: 'Agnes AI',
}

it('does not repeat the model name or expose the model id on a menu option', async () => {
  act(() => root.render(<ModelList options={[agnes]} value="" onPick={() => {}} />))
  const option = host.querySelector('[role="option"]') as HTMLButtonElement
  expect(option.getAttribute('title')).toBeNull()
  expect(option.getAttribute('aria-label')).toBe('Agnes 2.5 Flash · Agnes AI')
  expect(host.textContent).toContain('Agnes 2.5 Flash')
  expect(host.textContent).toContain('Agnes AI')
  expect(host.textContent).not.toContain('agnes-image-2.5-flash')
  await act(async () => option.focus())
  expect(document.querySelector('[role="tooltip"]')).toBeNull()
})
