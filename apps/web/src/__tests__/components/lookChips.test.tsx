// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import LookChips, { LookCapsule } from '../../components/LookChips'
import { useLibraryStore } from '../../features/library/store'
import type { LookRecord } from '../../features/library/types'

vi.mock('../../features/agent/lib/useAgentSkills', () => ({
  useAgentSkills: () => [
    {
      name: 'look-rock-wall-marble',
      title: '岩壁大理石',
      description: '',
      icon: 'image',
      summary: '',
      template: {
        purpose: 'scene',
        model: 'gpt-image-2.5-sunburst',
        size: '3:4',
        slotCount: 1,
        coverUrl: '/cover.webp',
        referenceUrls: [],
        body: '',
      },
    },
  ],
}))

vi.mock('../../features/library/lib/activeLook', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../features/library/lib/activeLook')>()),
  availableImageModels: () => new Set(['gpt-image-2.5-sunburst']),
}))

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useLibraryStore.setState({ looks: [] })
})

function makeLook(overrides: Partial<LookRecord>): LookRecord {
  return {
    id: 'l1',
    name: '北欧客厅',
    description: '',
    purpose: 'scene',
    body: '',
    model: 'gpt-image-2.5-sunburst',
    size: '1:1',
    slotCount: 1,
    referenceImageIds: [],
    coverImageId: null,
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: 1,
    ...overrides,
  }
}

function pills(): HTMLButtonElement[] {
  return [...host.querySelectorAll<HTMLButtonElement>('[data-look-chips] button')]
}

describe('LookChips', () => {
  it('自建在前、预置在后，点了把这条模板交给调用方', () => {
    useLibraryStore.setState({ looks: [makeLook({})] })
    const onPick = vi.fn()
    act(() => root.render(<LookChips onPick={onPick} />))

    const labels = pills().map((pill) => pill.textContent)
    expect(labels[0]).toContain('北欧客厅')
    expect(labels[1]).toContain('岩壁大理石')

    act(() => pills()[1].click())
    expect(onPick).toHaveBeenCalledWith(
      expect.objectContaining({ skillName: 'look-rock-wall-marble', origin: 'builtin' }),
    )
  })

  it('钉死的模型不在清单里的模板点不了', () => {
    useLibraryStore.setState({ looks: [makeLook({ model: 'gone-model' })] })
    act(() => root.render(<LookChips onPick={() => {}} />))
    expect(pills()[0].disabled).toBe(true)
    expect(pills()[0].textContent).toContain('需重新调试')
  })
})

describe('LookCapsule', () => {
  it('素材位对不上时亮出缺几条，摘掉胶囊回到普通提交', () => {
    useLibraryStore.setState({ looks: [makeLook({ slotCount: 2 })] })
    const onRemove = vi.fn()
    act(() =>
      root.render(
        <LookCapsule
          look={{
            skillName: 'look-l1',
            origin: 'user',
            name: '北欧客厅',
            description: '',
            purpose: 'scene',
            model: 'gpt-image-2.5-sunburst',
            size: '1:1',
            slotCount: 2,
            cover: null,
            references: [],
          }}
          issue={{ reason: 'slot_mismatch', expected: 2 }}
          onRemove={onRemove}
        />,
      ),
    )
    expect(host.textContent).toContain('这个模板需要 2 条素材')
    act(() => host.querySelector<HTMLButtonElement>('[data-look-capsule] button')?.click())
    expect(onRemove).toHaveBeenCalled()
  })
})
