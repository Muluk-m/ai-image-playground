// @vitest-environment jsdom
import { IDBFactory } from 'fake-indexeddb'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import InputBar from '../../components/InputBar'
import { DEFAULT_SETTINGS, normalizeSettings } from '../../lib/apiProfiles'
import { setChannels } from '../../lib/channels/channelStore'
import { useStore } from '../../store'
import { DEFAULT_PARAMS } from '../../types'
import { stubPointerApis } from '../helpers/radix'

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
vi.mock('../../features/agent/lib/useAgentSkills', () => ({ useAgentSkills: () => [] }))

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  stubPointerApis()
  setChannels([
    {
      id: 'image26',
      label: 'Image 2.6',
      kind: 'openai-queue',
      defaults: {},
      models: [
        {
          id: 'gpt-image-2.6-flare',
          label: 'Image 2.6 Flare',
          capabilities: ['generate', 'edit', 'quality', 'size'],
        },
      ],
    },
  ])
  useStore.setState({
    settings: normalizeSettings({
      ...DEFAULT_SETTINGS,
      profiles: [
        {
          id: 'image26',
          source: 'builtin-edge',
          channelId: 'image26',
          selectedModelId: 'gpt-image-2.6-flare',
        },
      ],
      activeProfileId: 'image26',
    }),
    createTarget: 'generate',
    params: { ...DEFAULT_PARAMS },
    inputImages: [],
    maskDraft: null,
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  setChannels([])
  vi.unstubAllGlobals()
})

it.each(['512x512', '768x768'])('restores a saved GIF at %s without crashing', async (size) => {
  useStore.setState({
    params: { ...DEFAULT_PARAMS, output_format: 'gif', size, quality: 'medium', n: 1 },
  })
  await act(async () => root.render(<InputBar />))

  expect(host.querySelector('[contenteditable]')).not.toBeNull()
  expect(host.querySelector('[aria-label^="生成设置:"]')?.getAttribute('aria-label')).toContain(
    'GIF',
  )
  expect(useStore.getState().params.size).toBe(size)
})

it('switches to GIF and keeps the input usable', async () => {
  await act(async () => root.render(<InputBar />))
  const trigger = host.querySelector<HTMLButtonElement>('[aria-label^="生成设置:"]')
  expect(trigger).not.toBeNull()
  await act(async () => trigger?.click())
  const format = document.body.querySelector('[role="group"][aria-label="格式"]')
  const gif = [...(format?.querySelectorAll('button') ?? [])].find((button) =>
    button.textContent?.includes('GIF'),
  )
  expect(gif).toBeDefined()
  await act(async () => gif?.click())

  expect(host.querySelector('[contenteditable]')).not.toBeNull()
  expect(useStore.getState().params).toMatchObject({ output_format: 'gif', size: '768x768' })
})
