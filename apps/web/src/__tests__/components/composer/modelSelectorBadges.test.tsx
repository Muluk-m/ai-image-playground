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

it('states a duration of a minute or more in minutes', () => {
  const pro = {
    ...lite,
    value: 'vertex::pro',
    label: 'Nano Banana Pro',
    badges: undefined,
    etaSeconds: 80,
  }
  act(() => root.render(<ModelList options={[pro]} value="" onPick={() => {}} />))
  expect(optionNamed('Nano Banana Pro').textContent).toContain('约 1 分钟')
})

it('states a tier-dependent duration as a range in seconds up to two minutes', () => {
  const grok: ModelChoice = {
    value: 'grok::grok-imagine-image-2.0',
    model: 'grok-imagine-image-2.0',
    profileId: 'grok',
    label: 'Grok Imagine Image 2.0',
    description: 'Grok',
    etaSeconds: 40,
    etaMaxSeconds: 100,
  }
  act(() => root.render(<ModelList options={[grok]} value="" onPick={() => {}} />))
  const option = optionNamed('Grok Imagine Image 2.0')
  expect(option.textContent).toContain('约 40–100 秒')
  expect(option.getAttribute('aria-label')).toBe('Grok Imagine Image 2.0 · 约 40–100 秒 · Grok')
})

it('states a longer range in minutes and collapses it when both ends round alike', () => {
  const slow = { ...lite, badges: undefined, etaSeconds: 90, etaMaxSeconds: 300 }
  act(() => root.render(<ModelList options={[slow]} value="" onPick={() => {}} />))
  expect(optionNamed('Nano Banana 2 Lite').textContent).toContain('约 2–5 分钟')
  act(() =>
    root.render(
      <ModelList
        options={[{ ...slow, etaSeconds: 130, etaMaxSeconds: 140 }]}
        value=""
        onPick={() => {}}
      />,
    ),
  )
  expect(optionNamed('Nano Banana 2 Lite').textContent).toContain('约 2 分钟')
  expect(optionNamed('Nano Banana 2 Lite').textContent).not.toContain('–')
})

it.each([
  [40, 40],
  [40, 20],
  [40, 2.5],
  [0, 100],
])('drops an unusable range %p–%p down to the single value or nothing', (etaSeconds, etaMaxSeconds) => {
  act(() =>
    root.render(
      <ModelList options={[{ ...lite, etaSeconds, etaMaxSeconds }]} value="" onPick={() => {}} />,
    ),
  )
  const text = optionNamed('Nano Banana 2 Lite').textContent ?? ''
  expect(text).not.toContain('–')
  if (etaSeconds > 0) expect(text).toContain(`约 ${etaSeconds} 秒`)
  else expect(text).not.toMatch(/约|秒|分钟/)
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

it.each([
  0,
  -1,
  Number.POSITIVE_INFINITY,
  Number.NaN,
])('shows no duration for an unusable eta %p from a stale catalog', (etaSeconds) => {
  act(() =>
    root.render(<ModelList options={[{ ...lite, etaSeconds }]} value="" onPick={() => {}} />),
  )
  const option = optionNamed('Nano Banana 2 Lite')
  expect(option.textContent).not.toMatch(/约|秒|分钟/)
  expect(option.getAttribute('aria-label')).toBe('Nano Banana 2 Lite · 速度快 · 便宜 · Vertex AI')
})

it.each([
  0.1, 2.5, 3601,
])('shows no duration for an eta %p outside 1–3600 whole seconds', (etaSeconds) => {
  act(() =>
    root.render(<ModelList options={[{ ...lite, etaSeconds }]} value="" onPick={() => {}} />),
  )
  expect(optionNamed('Nano Banana 2 Lite').textContent).not.toMatch(/约|秒|分钟/)
})
