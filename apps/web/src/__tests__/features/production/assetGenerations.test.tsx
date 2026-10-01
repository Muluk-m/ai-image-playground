// @vitest-environment jsdom
import type { ProductionDocument } from '@image-playground/shared'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import ProductionAssetGenerations from '../../../features/production/components/ProductionAssetGenerations'
import {
  activateProduction,
  productionTurnContext,
} from '../../../features/production/lib/productionContext'

const candidate = vi.hoisted(() => vi.fn())
vi.mock('../../../features/production/components/ProductionGenerations', () => ({
  default: (props: unknown) => {
    candidate(props)
    return null
  },
}))
vi.mock('../../../lib/channels/channelStore', () => ({
  getStoredChannels: () => [{ models: [{ id: 'image-model' }] }],
}))
globalThis.IS_REACT_ACT_ENVIRONMENT = true
it('keeps three-view generation on the same look and freezes the visible target for Chat', async () => {
  const doc: ProductionDocument = {
    id: 'doc',
    conversationId: 'conv',
    projectId: null,
    revision: 5,
    updatedAt: 1,
    content: {
      title: '雨夜',
      setting: '',
      outline: '',
      scenes: [],
      characters: [
        {
          id: 'hero',
          name: '林遥',
          description: '邮递员',
          looks: [
            {
              id: 'raincoat',
              name: '雨衣',
              description: '黄色雨衣',
              reference: { kind: 'media', mediaId: 'owned' },
            },
          ],
        },
      ],
    },
  }
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const close = activateProduction('conv', () => {})
  try {
    await act(async () =>
      root.render(
        <ProductionAssetGenerations
          document={doc}
          target={{ kind: 'look', id: 'raincoat' }}
          unsaved={false}
          onSaved={() => {}}
        />,
      ),
    )
    expect(productionTurnContext('conv').production).toEqual({
      documentId: 'doc',
      revision: 5,
      target: 'look',
      lookId: 'raincoat',
    })
    await act(async () =>
      [...host.querySelectorAll('button')]
        .find((button) => button.textContent === '角色三视图')!
        .click(),
    )
    expect(candidate.mock.lastCall?.[0]).toMatchObject({
      target: { kind: 'look', id: 'raincoat' },
      initialDraft: {
        model: 'image-model',
        references: [{ reference: { kind: 'media', mediaId: 'owned' } }],
      },
    })
    expect(candidate.mock.lastCall?.[0].initialDraft.prompt).toContain('正面')
    expect(candidate.mock.lastCall?.[0].initialDraft.prompt).toContain('黄色雨衣')
    await act(async () =>
      root.render(
        <ProductionAssetGenerations
          document={doc}
          target={{ kind: 'look', id: 'raincoat' }}
          unsaved={true}
          onSaved={() => {}}
        />,
      ),
    )
    expect(candidate.mock.lastCall?.[0].preparationBlocked).toBeTruthy()
  } finally {
    await act(async () => root.unmount())
    close()
    host.remove()
  }
  expect(productionTurnContext('conv')).toEqual({})
})
