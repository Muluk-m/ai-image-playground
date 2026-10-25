// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ImageSettings } from '../../components/ParamControls'
import { setChannels } from '../../lib/channels/channelStore'
import type { ClientProfile } from '../../lib/channels/types'
import { DEFAULT_PARAMS, type TaskParams } from '../../types'
import { stubPointerApis } from '../helpers/radix'

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
afterEach(() => setChannels([]))

const profile = (model: string): ClientProfile => ({
  id: 'vertex-images',
  source: 'builtin-edge',
  channelId: 'vertex-images',
  selectedModelId: model,
})

/** 打开「生成设置」卡片，读分辨率那一组的按钮文字和选中项。 */
async function resolutionOf(model: string, params: Partial<TaskParams> = {}) {
  stubPointerApis()
  setChannels([
    {
      id: 'vertex-images',
      label: 'Vertex AI',
      kind: 'gemini-queue',
      defaults: {},
      models: [
        {
          id: 'gemini-3-pro-image',
          label: 'Pro',
          capabilities: ['generate', 'edit', 'size'],
          imageSizes: ['1K', '2K'],
        },
        {
          id: 'gemini-3.1-flash-lite-image',
          label: 'Lite',
          capabilities: ['generate', 'edit', 'size'],
          imageSizes: ['1K'],
        },
        { id: 'gemini-undeclared-image', label: 'Plain', capabilities: ['generate', 'size'] },
      ],
    },
  ])
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () =>
      root.render(
        <ImageSettings
          controlled={{
            profile: profile(model),
            params: { ...DEFAULT_PARAMS, ...params },
            onChange: () => {},
          }}
        />,
      ),
    )
    const trigger = host.querySelector<HTMLButtonElement>('button[aria-label^="生成设置: "]')!
    const summary = trigger.getAttribute('aria-label')
    await act(async () => trigger.click())
    const buttons = [
      ...document.body.querySelectorAll<HTMLButtonElement>(
        '[role="group"][aria-label="分辨率"] button',
      ),
    ]
    return {
      options: buttons.map((one) => one.textContent),
      selected: buttons
        .filter((one) => one.getAttribute('aria-pressed') === 'true')
        .map((one) => one.textContent),
      summary,
    }
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
}

it('lists only the resolutions the channel declares for the model', async () => {
  expect((await resolutionOf('gemini-3-pro-image')).options).toEqual(['自动', '1K', '2K'])
  expect((await resolutionOf('gemini-3.1-flash-lite-image')).options).toEqual(['自动', '1K'])
})

it('keeps every shared resolution for a model without a declaration', async () => {
  expect((await resolutionOf('gemini-undeclared-image')).options).toEqual([
    '自动',
    '512',
    '1K',
    '2K',
  ])
})

it('shows a stored tier the model does not render as the nearest one it does', async () => {
  const lite = await resolutionOf('gemini-3.1-flash-lite-image', { gemini_image_size: '2K' })
  expect(lite.selected).toEqual(['1K'])
  expect(lite.summary).toContain('1K')
  expect(lite.summary).not.toContain('2K')
  const pro = await resolutionOf('gemini-3-pro-image', { gemini_image_size: '512' })
  expect(pro.selected).toEqual(['1K'])
})
