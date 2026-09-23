// @vitest-environment jsdom

import 'fake-indexeddb/auto'
import type { AgentTurnReference } from '@image-playground/shared'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AgentComposer from '../../../../features/agent/components/AgentComposer'
import { agentDraft } from '../../../../features/agent/lib/drafts'
import { EMPTY_DRAFT } from '../../../../features/agent/lib/references'
import { useAgentStore } from '../../../../features/agent/store'
import { CanvasDoc, type ImageEl } from '../../../../features/canvas/lib/canvasDoc'
import { useLibraryStore } from '../../../../features/library/store'
import { setClientStorageScope } from '../../../../lib/authScope'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const PIXEL = 'data:image/png;base64,aGk='

function imageElement(id: string, fileId: string): ImageEl {
  return { id, type: 'image', x: 0, y: 0, width: 10, height: 10, rotation: 0, fileId }
}

let host: HTMLDivElement
let root: Root
let doc: CanvasDoc
let send: (text: string, references?: readonly AgentTurnReference[]) => void

function render(): void {
  act(() => {
    root.render(<AgentComposer doc={doc} />)
  })
}

function editor(): HTMLElement {
  return host.querySelector<HTMLElement>('[contenteditable]')!
}

/** 见 agentComposer.test.tsx：jsdom 没有真实光标，追加文本节点就是在末尾打字。 */
function type(text: string): void {
  const el = editor()
  el.appendChild(document.createTextNode(text))
  act(() => {
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** 翻历史后回焦与落光标挂在 0ms 定时器上，等它跑完这一下才算翻完。 */
async function press(key: string): Promise<void> {
  act(() => {
    editor().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function options(): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>('[role="option"]')]
}

function submit(): void {
  const button = host.querySelector<HTMLButtonElement>('button[aria-label="发送并拟提示词"]')!
  act(() => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

beforeEach(async () => {
  setClientStorageScope(null)
  localStorage.clear()
  const session = agentDraft(null)
  await vi.waitFor(() => expect(session.getSnapshot().loading).toBe(false))
  session.update(EMPTY_DRAFT)
  session.setSubmitting(false)
  doc = new CanvasDoc()
  doc.restore([imageElement('canvas-1', 'file-1')], { 'file-1': PIXEL })
  send = vi.fn()
  useAgentStore.setState({
    turn: 'idle',
    conversationId: null,
    send: async (text, references, accepted) => {
      send(text, references)
      accepted?.()
    },
  })
  useLibraryStore.setState({ assets: [], loadAssets: async () => {} })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  window.getSelection()?.removeAllRanges()
  setClientStorageScope(null)
  vi.unstubAllGlobals()
})

describe('输入框的历史提示词', () => {
  it('上键翻出发过的提示词，下键翻回来并还原打到一半的那句', async () => {
    render()
    type('第一句')
    submit()
    type('第二句')
    submit()
    type('打到一半')

    await press('ArrowUp')
    expect(editor().textContent).toBe('第二句')
    await press('ArrowUp')
    expect(editor().textContent).toBe('第一句')
    // 最旧的那条到头就停住，不绕回最新的。
    await press('ArrowUp')
    expect(editor().textContent).toBe('第一句')

    await press('ArrowDown')
    expect(editor().textContent).toBe('第二句')
    await press('ArrowDown')
    expect(editor().textContent).toBe('打到一半')
  })

  it('`@` 菜单开着时上键走候选，不翻历史', async () => {
    render()
    type('先发一句')
    submit()

    type('把@')
    expect(options().map((one) => one.textContent)).toContain('画布图1')

    await press('ArrowUp')
    expect(editor().textContent).toBe('把@')
  })

  it('连着发同一句只记一条', async () => {
    render()
    type('先发的那句')
    submit()
    type('又一句')
    submit()
    type('又一句')
    submit()

    await press('ArrowUp')
    expect(editor().textContent).toBe('又一句')
    await press('ArrowUp')
    expect(editor().textContent).toBe('先发的那句')
  })

  it('翻到一半又动手打字就不算在翻，下一次上键从最新那条重新数', async () => {
    render()
    type('旧的那句')
    submit()

    await press('ArrowUp')
    expect(editor().textContent).toBe('旧的那句')
    type('改一改')

    await press('ArrowUp')
    expect(editor().textContent).toBe('旧的那句')
    await press('ArrowDown')
    expect(editor().textContent).toBe('旧的那句改一改')
  })

  it('历史留在本机，输入框卸载再挂载还翻得到', async () => {
    render()
    type('留着的那句')
    submit()

    act(() => root.render(null))
    render()

    await press('ArrowUp')
    expect(editor().textContent).toBe('留着的那句')
  })

  it('历史按账号隔开，换个身份翻不到上一个身份发过的话', async () => {
    render()
    type('匿名时发的那句')
    submit()

    setClientStorageScope('u1')
    await press('ArrowUp')
    expect(editor().textContent).toBe('')
  })
})
