// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import type { AgentMaskProposal } from '@image-playground/shared'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AgentClarification from '../../../../features/agent/components/AgentClarification'
import { useAgentStore } from '../../../../features/agent/store'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const PROPOSAL = {
  id: 'proposal-1',
  imageId: 'file_chair',
  mediaId: 'media-original',
  width: 64,
  height: 64,
  target: '椅子',
  change: '换成红色',
  keep: [],
  box: { x: 0.2, y: 0.2, width: 0.5, height: 0.5 },
  segmentation: 'server',
  model: { id: 'gpt-image-2', label: 'GPT Image 2' },
} as unknown as AgentMaskProposal

const CLARIFICATION = {
  kind: 'clarification' as const,
  id: 'clar-1',
  turnId: 'turn-1',
  question: '确认修改范围',
  options: [],
  maskProposal: PROPOSAL,
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 404 })),
  )
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

function renderAnswered(text: string, references: unknown[]): void {
  useAgentStore.setState({
    messages: [
      CLARIFICATION,
      { kind: 'text', id: 'user-2', role: 'user', text, references },
    ] as never,
  })
  act(() => {
    root.render(<AgentClarification message={CLARIFICATION} answered />)
  })
}

describe('答过的范围确认卡', () => {
  it('回答带着这张图的蒙版就算已确认，与回答当时的界面语言无关', () => {
    renderAnswered('Confirmed "chair": make it red', [
      { imageId: 'file_chair', dataUrl: 'aip-media:media-original', maskMediaId: 'media-mask' },
    ])
    expect(host.querySelector('[data-look="confirmed"]')).not.toBeNull()
  })

  it('自己另写的回答（没带蒙版）不算确认', () => {
    renderAnswered('算了，不改了', [])
    expect(host.querySelector('[data-look="confirmed"]')).toBeNull()
  })
})
