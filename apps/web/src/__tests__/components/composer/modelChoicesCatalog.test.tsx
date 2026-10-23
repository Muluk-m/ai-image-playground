// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { useModelChoices } from '../../../components/composer/ModelSelector'
import { createBuiltinEdgeProfile } from '../../../lib/apiProfiles'
import { resetChannelCatalog, setChannels } from '../../../lib/channels/channelStore'
import type { PublicChannel } from '../../../lib/channels/types'
import { useStore } from '../../../store'

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)

const host = document.createElement('div')
document.body.append(host)
const root = createRoot(host)
afterEach(() => {
  act(() => root.render(null))
  resetChannelCatalog()
})

const channel = (etaSeconds: number): PublicChannel => ({
  id: 'openai-images',
  kind: 'openai-queue',
  label: 'OpenAI',
  models: [
    {
      id: 'gpt-image-2.5-flare',
      label: 'Flare',
      capabilities: ['generate'],
      badges: ['recommended'],
      etaSeconds,
    },
  ],
  defaults: { apiMode: 'images', timeout: 600 },
})

function Probe() {
  const { options } = useModelChoices()
  return <output>{options.map((one) => `${one.model}:${one.etaSeconds ?? '-'}`).join(',')}</output>
}

it('shows the latest channel metadata after the catalog is replaced', () => {
  setChannels([channel(30)])
  useStore.setState({
    settings: {
      ...useStore.getState().settings,
      profiles: [createBuiltinEdgeProfile('openai-images', 'gpt-image-2.5-flare')],
      activeProfileId: 'openai-images',
    },
  })
  act(() => root.render(<Probe />))
  expect(host.textContent).toBe('gpt-image-2.5-flare:30')

  act(() => setChannels([channel(45)]))
  expect(host.textContent).toBe('gpt-image-2.5-flare:45')
})
