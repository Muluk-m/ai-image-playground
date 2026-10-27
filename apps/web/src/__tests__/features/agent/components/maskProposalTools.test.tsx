// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import type { AgentMaskProposal } from '@image-playground/shared'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AgentClarification from '../../../../features/agent/components/AgentClarification'
import { useAgentStore } from '../../../../features/agent/store'
import { stubPointerApis } from '../../../helpers/radix'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const POINT_LABEL = /^(点选|Click select)$/

function clarification(segmentation: AgentMaskProposal['segmentation']) {
  return {
    kind: 'clarification' as const,
    id: 'clar-1',
    turnId: 'turn-1',
    question: '确认修改范围',
    options: [],
    maskProposal: {
      id: 'proposal-1',
      imageId: 'file_chair',
      mediaId: 'media-original',
      width: 64,
      height: 64,
      target: '椅子',
      change: '换成红色',
      keep: [],
      box: { x: 0.2, y: 0.2, width: 0.5, height: 0.5 },
      segmentation,
      model: { id: 'gpt-image-2', label: 'GPT Image 2' },
    } as unknown as AgentMaskProposal,
  }
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  // 画笔工具带 Radix 滑块，要用到 ResizeObserver。
  stubPointerApis()
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

function pressedTools(segmentation: AgentMaskProposal['segmentation']) {
  const message = clarification(segmentation)
  useAgentStore.setState({ messages: [message] as never })
  act(() => {
    root.render(<AgentClarification message={message} />)
  })
  return [...host.querySelectorAll<HTMLButtonElement>('[role="toolbar"] button[aria-pressed]')]
}

describe('范围确认卡的工具', () => {
  it('服务端分割过的提议默认用点选', () => {
    const point = pressedTools('server').find((one) => POINT_LABEL.test(one.textContent ?? ''))
    expect(point?.getAttribute('aria-pressed')).toBe('true')
  })

  it('没有服务端分割时不提供点选，默认用画笔', () => {
    const tools = pressedTools('box')
    expect(tools.some((one) => POINT_LABEL.test(one.textContent ?? ''))).toBe(false)
    expect(tools.find((one) => one.getAttribute('aria-pressed') === 'true')).toBeDefined()
  })
})
