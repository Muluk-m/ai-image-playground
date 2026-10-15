// @vitest-environment jsdom
import type { AgentModelSettingsView } from '@image-playground/shared'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { AgentModelSettingsForm } from '../../../features/agent-models/AgentModelSettingsForm'

function fixture(): AgentModelSettingsView {
  return {
    revision: 1,
    credentialReady: { example: true },
    templates: [{ id: 'custom', name: '自定义 API', baseUrl: '', models: [] }],
    settings: {
      providers: [
        {
          id: 'example',
          name: 'Example',
          template: 'custom',
          baseUrl: 'https://example.com/v1',
          secretRef: 'EXAMPLE_API_KEY',
          models: [
            {
              id: 'model-a',
              name: 'Model A',
              api: 'openai-completions',
              contextWindow: 128000,
              maxTokens: 16000,
              imageInput: true,
              reasoningLevels: ['off', 'low', 'high'],
            },
          ],
        },
      ],
      profiles: {
        default: { providerId: 'example', modelId: 'model-a', reasoning: 'off' },
        fast: { providerId: 'example', modelId: 'model-a', reasoning: 'low' },
        medium: { providerId: 'example', modelId: 'model-a', reasoning: 'low' },
        deep: { providerId: 'example', modelId: 'model-a', reasoning: 'high' },
      },
    },
  }
}

it('changes a product depth effort without changing its model or another depth', async () => {
  const save = vi.fn(async (_settings: AgentModelSettingsView['settings']) => {})
  render(<AgentModelSettingsForm initial={fixture()} save={save} pending={false} error={null} />)
  fireEvent.keyDown(screen.getByRole('combobox', { name: '普通 · 模型推理强度' }), {
    key: 'ArrowDown',
  })
  fireEvent.click(await screen.findByRole('option', { name: '高（high）' }))
  fireEvent.click(screen.getByRole('button', { name: '保存配置' }))
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
  expect(save.mock.calls[0]?.[0]).toMatchObject({
    profiles: {
      medium: { modelId: 'model-a', reasoning: 'high' },
      fast: { modelId: 'model-a', reasoning: 'low' },
    },
  })
})

it('lets operators add a model draft and retains edits when saving fails', () => {
  render(
    <AgentModelSettingsForm
      initial={fixture()}
      save={async () => {}}
      pending={false}
      error="配置已被其他操作更新，请刷新后重试"
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: '添加自定义模型' }))
  expect(screen.getByRole('textbox', { name: 'example 模型 2 · 模型 ID' })).toHaveValue('')
  fireEvent.change(screen.getByRole('textbox', { name: 'example · 密钥环境变量名' }), {
    target: { value: 'NEW_API_KEY' },
  })
  expect(screen.getByRole('alert')).toHaveTextContent('配置已被其他操作更新')
  expect(screen.getByRole('textbox', { name: 'example · 密钥环境变量名' })).toHaveValue(
    'NEW_API_KEY',
  )
  expect(screen.getByRole('button', { name: '删除 Example' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: '放弃修改' }))
  expect(screen.getByRole('textbox', { name: 'example · 密钥环境变量名' })).toHaveValue(
    'EXAMPLE_API_KEY',
  )
})
