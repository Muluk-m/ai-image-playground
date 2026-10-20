// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import TextNodeComposer from '../../../../features/canvas/components/TextNodeComposer'
import { fetchTextChatModels } from '../../../../features/canvas/lib/textGenerationModels'
import { stubPointerApis } from '../../../helpers/radix'

vi.mock('../../../../features/canvas/lib/textGenerationModels', () => ({
  fetchTextChatModels: vi.fn(),
}))
stubPointerApis()
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
const host = document.createElement('div')
document.body.append(host)
let root = createRoot(host)
afterEach(() => {
  act(() => root.unmount())
  root = createRoot(host)
  vi.clearAllMocks()
})

it('shows readable model names and OpenAI logos while submitting the selected opaque id', async () => {
  const models = ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra'].map((model) => ({
    id: `upstream-gateway::${model}`,
    model,
    label: model,
  }))
  vi.mocked(fetchTextChatModels).mockResolvedValue({ models, defaultModel: models[0]!.id })
  const submit = vi.fn()
  await act(async () =>
    root.render(
      <TextNodeComposer
        references={[]}
        files={{}}
        value="写一段开场"
        onChange={() => {}}
        onSubmit={submit}
      />,
    ),
  )
  const trigger = host.querySelector<HTMLButtonElement>('button[aria-label="选择 Chat 模型"]')!
  expect(trigger.textContent).toBe('GPT-6 Luna')
  expect(trigger.querySelector('svg[viewBox="0 0 256 260"]')).not.toBeNull()
  await act(async () => trigger.click())
  const options = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
  expect(options.map((option) => option.textContent)).toEqual([
    'GPT-6 Luna',
    'GPT-6.1 Sol',
    'GPT-6 Astra',
  ])
  for (const option of options) {
    expect(option.querySelector('svg[viewBox="0 0 256 260"]')).not.toBeNull()
    expect(option.textContent).not.toContain('gpt-6')
    expect(option.textContent).not.toContain('网关')
    expect(option.getAttribute('aria-label')).toBe(option.textContent)
  }
  await act(async () => options[1]!.click())
  expect(trigger.textContent).toBe('GPT-6.1 Sol')
  act(() => host.querySelector<HTMLButtonElement>('button[aria-label="生成文本"]')!.click())
  expect(submit).toHaveBeenCalledWith(models[1]!.id)
})

it('preserves a configured model label instead of replacing it with the model id', async () => {
  vi.mocked(fetchTextChatModels).mockResolvedValue({
    models: [{ id: 'custom::gpt-6-luna', model: 'gpt-6-luna', label: 'Creative Writer' }],
    defaultModel: 'custom::gpt-6-luna',
  })
  await act(async () =>
    root.render(
      <TextNodeComposer
        references={[]}
        files={{}}
        value=""
        onChange={() => {}}
        onSubmit={() => {}}
      />,
    ),
  )
  expect(host.querySelector('button[aria-label="选择 Chat 模型"]')?.textContent).toBe(
    'Creative Writer',
  )
})
