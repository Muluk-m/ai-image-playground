// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ModelLogo } from '../../components/ModelIdentity'
import { resetChannelCatalog, setChannels } from '../../lib/channels/channelStore'
import type { PublicChannel } from '../../lib/channels/types'

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)

const host = document.createElement('div')
document.body.append(host)
let root = createRoot(host)
afterEach(() => {
  act(() => root.unmount())
  root = createRoot(host)
  resetChannelCatalog()
})

const VERTEX: PublicChannel = {
  id: 'vertex-images',
  kind: 'gemini-queue',
  label: 'Vertex AI',
  models: [
    {
      id: 'gemini-3-pro-image',
      label: 'Nano Banana Pro',
      capabilities: ['generate'],
      logo: 'nano-banana',
    },
    { id: 'gemini-3.1-flash-image', label: 'Gemini 3.1 Flash', capabilities: ['generate'] },
  ],
  defaults: { apiMode: 'images', timeout: 600 },
}

function render(model: string, logo?: 'nano-banana' | null) {
  act(() => root.render(<ModelLogo model={model} logo={logo} />))
  return host.firstElementChild
}

it('uses the logo the channel declares for the model, not the vendor icon', () => {
  setChannels([VERTEX])
  const logo = render('gemini-3-pro-image')
  expect(logo?.tagName).toBe('IMG')
  expect(logo?.getAttribute('src')).toBe('/model-logos/nano-banana.svg')
  // 官方彩色图标在暗色主题下也不能被反色。
  expect(logo?.getAttribute('class')).not.toContain('invert')
})

it('falls back to the vendor icon by id prefix when no logo is declared', () => {
  setChannels([VERTEX])
  const undeclared = render('gemini-3.1-flash-image')
  expect(undeclared?.tagName.toLowerCase()).toBe('svg')
  expect(host.querySelector('img')).toBeNull()
})

it('switches to the declared logo once a late channel list arrives', () => {
  const logo = render('gemini-3-pro-image')
  expect(logo?.tagName.toLowerCase()).toBe('svg')
  act(() => setChannels([VERTEX]))
  expect(host.firstElementChild?.getAttribute('src')).toBe('/model-logos/nano-banana.svg')
})

it('draws the logo the caller resolved without consulting the catalog', () => {
  setChannels([VERTEX])
  // 选择器从该选项自己的渠道取到「没有声明」：别的渠道的声明不能串过来。
  expect(render('gemini-3-pro-image', null)?.tagName.toLowerCase()).toBe('svg')
  expect(render('gemini-3.1-flash-image', 'nano-banana')?.getAttribute('src')).toBe(
    '/model-logos/nano-banana.svg',
  )
})
