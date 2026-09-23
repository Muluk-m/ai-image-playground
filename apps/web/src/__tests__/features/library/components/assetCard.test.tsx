// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AssetCard from '../../../../features/library/components/AssetCard'
import type { AssetRecord } from '../../../../features/library/types'
import { ensureAssetImage } from '../../../../lib/sync/assetImages'
import { useSyncStatus } from '../../../../lib/sync/status'

vi.mock('../../../../lib/sync/assetImages', () => ({ ensureAssetImage: vi.fn() }))

const ensureAssetImageMock = vi.mocked(ensureAssetImage)

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const ASSET: AssetRecord = {
  id: 'a1',
  name: '产品白底图',
  views: [{ imageId: 'image-1', label: 'none', source: 'upload' }],
  createdAt: 1,
  updatedAt: 1,
  lastUsedAt: 1,
}

let host: HTMLDivElement
let root: Root

function render(): void {
  act(() => {
    root.render(<AssetCard asset={ASSET} onOpen={() => {}} />)
  })
}

beforeEach(() => {
  ensureAssetImageMock.mockReset()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useSyncStatus.setState({ enabled: false, unsyncedImages: [] })
})

describe('a visible asset card', () => {
  it('asks for the image only once it is on screen', () => {
    render()

    expect(ensureAssetImageMock).toHaveBeenCalledWith('image-1')
  })
})

describe('the unsynced mark on an asset card', () => {
  it('shows on an image the server refused', () => {
    useSyncStatus.setState({ enabled: true, unsyncedImages: ['image-1'] })

    render()

    expect(host.textContent).toContain('等待保存')
  })

  it('stays away while the engine is not running', () => {
    useSyncStatus.setState({ enabled: false, unsyncedImages: ['image-1'] })

    render()

    expect(host.textContent).not.toContain('等待保存')
  })
})
