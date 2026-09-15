// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAgentStore } from '../../../../features/agent/store'
import CanvasToolbar from '../../../../features/canvas/components/CanvasToolbar'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import { bootstrapClientCapabilities } from '../../../../lib/clientCapabilities'

const MANIFEST = {
  'accounts:login': false,
  'accounts:self-register': false,
  'accounts:sync': false,
  'agent:chat': true,
  'billing:credits': false,
  'generation:byok': true,
  'generation:storyboard': false,
  'generation:video': false,
  'matte:server': false,
  'quota:daily': false,
  'remix:analyze': false,
  'remix:listing': false,
}

let host: HTMLDivElement
let root: Root

async function enableAgent(enabled: boolean): Promise<void> {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ ...MANIFEST, 'agent:chat': enabled })),
  )
  await bootstrapClientCapabilities(true, 'http://bff.test')
  vi.unstubAllGlobals()
}

function render(): void {
  act(() => {
    root.render(<CanvasToolbar doc={new CanvasDoc()} />)
  })
}

function toolbar(): HTMLElement {
  return host.querySelector<HTMLElement>('[data-canvas-toolbar]')!
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('画布工具条', () => {
  it('对话面板开着时贴在面板右缘竖排，面板多宽就让多远', async () => {
    await enableAgent(true)
    useAgentStore.setState({ open: true, panelWidth: 300 })
    render()

    expect(toolbar().dataset.canvasToolbar).toBe('docked')
    expect(toolbar().style.left).toBe('320px')
    expect(toolbar().querySelector('button[title="选择（V）"]')).not.toBeNull()
    expect(toolbar().querySelector('button[title="缩小"]')).not.toBeNull()
  })

  it('面板收起后退回底部横排', async () => {
    await enableAgent(true)
    useAgentStore.setState({ open: false })
    render()

    expect(toolbar().dataset.canvasToolbar).toBe('bottom')
  })

  it('没有智能体时一直在底部', async () => {
    await enableAgent(false)
    useAgentStore.setState({ open: true, panelWidth: 300 })
    render()

    expect(toolbar().dataset.canvasToolbar).toBe('bottom')
  })
})
