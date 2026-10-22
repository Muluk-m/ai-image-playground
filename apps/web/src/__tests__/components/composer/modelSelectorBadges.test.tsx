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

const lite: ModelChoice = {
  value: 'vertex::gemini-3.1-flash-lite-image',
  model: 'gemini-3.1-flash-lite-image',
  profileId: 'vertex',
  label: 'Nano Banana 2 Lite',
  description: 'Vertex AI',
  badges: ['fast', 'value'],
  etaSeconds: 3,
}

const plain: ModelChoice = {
  value: 'openai::gpt-image-2.5-flare',
  model: 'gpt-image-2.5-flare',
  profileId: 'openai',
  label: 'Image 2.5 Flare',
  description: 'OpenAI',
}

function optionNamed(label: string): HTMLButtonElement {
  const option = [...host.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((one) =>
    one.textContent?.includes(label),
  )
  if (!option) throw new Error(`no option ${label}`)
  return option
}

it('shows the badges after the name and the typical duration under it', async () => {
  act(() => root.render(<ModelList options={[lite, plain]} value="" onPick={() => {}} />))
  const option = optionNamed('Nano Banana 2 Lite')
  expect(option.textContent).toContain('速度快')
  expect(option.textContent).toContain('便宜')
  expect(option.textContent).toContain('约 3 秒')
  expect(option.getAttribute('aria-label')).toBe(
    'Nano Banana 2 Lite · 速度快 · 便宜 · 约 3 秒 · Vertex AI',
  )
  // 名字本身可见，aria-label 不能再变成悬停提示重复一遍。
  await act(async () => option.focus())
  expect(document.querySelector('[role="tooltip"]')).toBeNull()
})

it('keeps a model without selector metadata on its single line', () => {
  act(() => root.render(<ModelList options={[lite, plain]} value="" onPick={() => {}} />))
  const option = optionNamed('Image 2.5 Flare')
  expect(option.textContent).toBe('Image 2.5 FlareOpenAI')
  expect(option.getAttribute('aria-label')).toBe('Image 2.5 Flare · OpenAI')
})

it('finds a model by its badge text in the search field', async () => {
  const many = Array.from({ length: 8 }, (_, index) => ({
    ...plain,
    value: `openai::m${index}`,
    model: `gpt-image-m${index}`,
    label: `GPT ${index}`,
  }))
  act(() => root.render(<ModelList options={[...many, lite]} value="" onPick={() => {}} />))
  const search = host.querySelector('input') as HTMLInputElement
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setValue.call(search, '速度快')
    search.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const options = [...host.querySelectorAll('[role="option"]')]
  expect(options.map((one) => one.textContent)).toEqual([
    expect.stringContaining('Nano Banana 2 Lite'),
  ])
})
