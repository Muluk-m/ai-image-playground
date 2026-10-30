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
  tier: 'fast',
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

it('shows the name on its own line and only the duration under it, with no descriptive tags', async () => {
  act(() => root.render(<ModelList options={[lite, plain]} value="" onPick={() => {}} />))
  const option = optionNamed('Nano Banana 2 Lite')
  const name = option.querySelector('span[title="Nano Banana 2 Lite"]')
  expect(name?.className).toContain('truncate')
  expect(option.textContent).toBe('Nano Banana 2 Lite约 3 秒Vertex AI')
  // 快慢、画质交给分组，名字后面不再挂「速度快」「质量好」之类的说明。
  expect(option.textContent).not.toMatch(/速度快|质量好|便宜|推荐|最新/)
  expect(option.getAttribute('aria-label')).toBe('Nano Banana 2 Lite · 约 3 秒 · Vertex AI')
  // 名字本身可见，aria-label 不能再变成悬停提示重复一遍。
  await act(async () => option.focus())
  expect(document.querySelector('[role="tooltip"]')).toBeNull()
})

it('marks only a latest model with a small New badge and ignores the other tag tokens', () => {
  const latest: ModelChoice = {
    ...lite,
    value: 'vertex::nb21',
    model: 'gemini-nano-banana-2.1',
    label: 'Nano Banana 2.1',
    badges: ['latest'],
    etaSeconds: 14,
  }
  const tagged: ModelChoice = { ...plain, badges: ['recommended', 'quality', 'value'] }
  act(() => root.render(<ModelList options={[latest, tagged]} value="" onPick={() => {}} />))
  const option = optionNamed('Nano Banana 2.1')
  expect(option.textContent).toBe('Nano Banana 2.1New约 14 秒Vertex AI')
  expect(option.getAttribute('aria-label')).toBe('Nano Banana 2.1 · New · 约 14 秒 · Vertex AI')
  expect(optionNamed('Image 2.5 Flare').textContent).toBe('Image 2.5 FlareOpenAI')
})

it('groups models under 快速 and 高质量 headers, fastest first inside a group', () => {
  const nb21: ModelChoice = {
    ...lite,
    value: 'vertex::nb21',
    model: 'gemini-nano-banana-2.1',
    label: 'Nano Banana 2.1',
    etaSeconds: 14,
  }
  const pro: ModelChoice = {
    ...lite,
    value: 'vertex::pro',
    model: 'gemini-3-pro-image',
    label: 'Nano Banana Pro',
    tier: 'quality',
    etaSeconds: 24,
  }
  const gpt: ModelChoice = { ...plain, tier: 'quality', etaSeconds: 40 }
  const untiered: ModelChoice = { ...plain, value: 'x::other', model: 'other', label: 'Other' }
  act(() =>
    root.render(
      <ModelList options={[gpt, nb21, untiered, pro, lite]} value="" onPick={() => {}} />,
    ),
  )
  const groups = [...host.querySelectorAll('[role="group"]')]
  expect(groups.map((group) => group.getAttribute('aria-labelledby'))).toHaveLength(2)
  const heading = (group: Element) =>
    document.getElementById(group.getAttribute('aria-labelledby') ?? '')?.textContent
  expect(groups.map(heading)).toEqual(['快速', '高质量'])
  // 组头配一个小图标，不带别的说明文字。
  expect(groups.every((group) => group.querySelector('svg'))).toBe(true)
  const labelsIn = (group: Element) =>
    [...group.querySelectorAll('[role="option"]')].map(
      (one) => one.getAttribute('aria-label')?.split(' · ')[0],
    )
  expect(labelsIn(groups[0])).toEqual(['Nano Banana 2 Lite', 'Nano Banana 2.1'])
  expect(labelsIn(groups[1])).toEqual(['Nano Banana Pro', 'Image 2.5 Flare'])
  // 没分组的模型排在最后，不出组头；键盘顺序跟着显示顺序。
  const all = [...host.querySelectorAll('[role="option"]')].map(
    (one) => one.getAttribute('aria-label')?.split(' · ')[0],
  )
  expect(all).toEqual([
    'Nano Banana 2 Lite',
    'Nano Banana 2.1',
    'Nano Banana Pro',
    'Image 2.5 Flare',
    'Other',
  ])
  expect(host.querySelector('[role="option"][tabindex="0"]')?.textContent).toContain(
    'Nano Banana 2 Lite',
  )
})

it('keeps a flat list without headers when no model declares a group', () => {
  act(() =>
    root.render(
      <ModelList options={[{ ...lite, tier: undefined }, plain]} value="" onPick={() => {}} />,
    ),
  )
  expect(host.querySelectorAll('[role="group"]')).toHaveLength(0)
  expect(host.textContent).not.toMatch(/快速|高质量/)
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

it('finds a model by its group name in the search field', async () => {
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
    setValue.call(search, '快速')
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
  expect(option.getAttribute('aria-label')).toBe('Nano Banana 2 Lite · Vertex AI')
})

it.each([
  0.1, 2.5, 3601,
])('shows no duration for an eta %p outside 1–3600 whole seconds', (etaSeconds) => {
  act(() =>
    root.render(<ModelList options={[{ ...lite, etaSeconds }]} value="" onPick={() => {}} />),
  )
  expect(optionNamed('Nano Banana 2 Lite').textContent).not.toMatch(/约|秒|分钟/)
})
