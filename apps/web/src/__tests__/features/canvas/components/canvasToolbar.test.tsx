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
  'generation:video': false,
  'quota:daily': false,
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

function render(onImportImages = () => {}, onImportFolder = () => {}): void {
  act(() => {
    root.render(
      <CanvasToolbar
        doc={new CanvasDoc()}
        onImportImages={onImportImages}
        onImportFolder={onImportFolder}
      />,
    )
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
  it('对话与画布分栏后，工具条不再重复预留面板宽度', async () => {
    await enableAgent(true)
    useAgentStore.setState({ open: true, panelWidth: 300 })
    render()

    expect(toolbar().dataset.canvasToolbar).toBe('side')
    expect(toolbar().style.left).toBe('')
    expect(toolbar().querySelector('button[title="选择（V）"]')).not.toBeNull()
    expect(toolbar().querySelector('button[title="缩小"]')).not.toBeNull()
  })

  it('面板收起后仍位于画布侧边', async () => {
    await enableAgent(true)
    useAgentStore.setState({ open: false })
    render()

    expect(toolbar().dataset.canvasToolbar).toBe('side')
  })

  it('没有智能体时同样位于侧边', async () => {
    await enableAgent(false)
    useAgentStore.setState({ open: true, panelWidth: 300 })
    render()

    expect(toolbar().dataset.canvasToolbar).toBe('side')
  })

  it('画布有内容或没有内容时都能选择图片或文件夹', () => {
    const images = vi.fn()
    const folder = vi.fn()
    render(images, folder)
    act(() =>
      toolbar().querySelector<HTMLButtonElement>('button[aria-label="导入到画布"]')!.click(),
    )
    expect(document.body.textContent).toContain('导入图片')
    expect(document.body.textContent).toContain('导入文件夹')
    act(() =>
      [...document.body.querySelectorAll('button')]
        .find((button) => button.textContent?.trim() === '导入文件夹')!
        .click(),
    )
    expect(folder).toHaveBeenCalledOnce()
    expect(images).not.toHaveBeenCalled()
    act(() =>
      toolbar().querySelector<HTMLButtonElement>('button[aria-label="导入到画布"]')!.click(),
    )
    act(() =>
      [...document.body.querySelectorAll('button')]
        .find((button) => button.textContent?.trim() === '导入图片')!
        .click(),
    )
    expect(images).toHaveBeenCalledOnce()
  })
})
