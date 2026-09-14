// @vitest-environment jsdom

import type { AgentTurnReference } from '@image-playground/shared'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AgentComposer from '../../../../features/agent/components/AgentComposer'
import { useAgentStore } from '../../../../features/agent/store'
import { CanvasDoc, type ImageEl } from '../../../../features/canvas/lib/canvasDoc'
import { useLibraryStore } from '../../../../features/library/store'
import { useStore } from '../../../../store'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const PIXEL = 'data:image/png;base64,aGk='
const PREPARED = 'data:image/png;base64,cHJlcA=='
const MASK = 'data:image/png;base64,bWFzaw=='

function imageElement(id: string, fileId: string): ImageEl {
  return { id, type: 'image', x: 0, y: 0, width: 10, height: 10, rotation: 0, fileId }
}

let host: HTMLDivElement
let root: Root
let doc: CanvasDoc
let send: (text: string, references?: readonly AgentTurnReference[]) => Promise<void>

function render(): void {
  act(() => {
    root.render(<AgentComposer doc={doc} />)
  })
}

function editor(): HTMLElement {
  return host.querySelector<HTMLElement>('[contenteditable]')!
}

/**
 * jsdom 里没有真实光标，`getContentEditableSelection` 回落到文本末尾——正好是打字的位置。
 * 追加文本节点而不是重设 textContent：后者会把已经插好的胶囊 DOM 一起抹掉。
 */
function type(text: string): void {
  const el = editor()
  el.appendChild(document.createTextNode(text))
  act(() => {
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function options(): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>('[role="option"]')]
}

function pick(label: string): void {
  const option = options().find((one) => one.textContent?.includes(label))!
  act(() => {
    option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  })
}

function click(label: string): void {
  const button =
    host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`) ??
    [...host.querySelectorAll('button')].find((one) => one.textContent === label)!
  act(() => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

async function save(result: {
  maskDataUrl: string
  targetImageId: string
  targetDataUrl: string
}): Promise<void> {
  const session = useStore.getState().maskEditorSession!
  await act(async () => {
    await session.onSave(result)
  })
}

function capsules(): string[] {
  return [...host.querySelectorAll('.mention-tag')].map((node) => node.textContent ?? '')
}

beforeEach(() => {
  doc = new CanvasDoc()
  doc.restore([imageElement('canvas-1', 'file-1')], { 'file-1': PIXEL })
  send = vi.fn<(text: string, references?: readonly AgentTurnReference[]) => Promise<void>>(
    async () => {},
  )
  useAgentStore.setState({ turn: 'idle', send })
  useStore.setState({ maskEditorImageId: null, maskEditorSession: null })
  useLibraryStore.setState({ assets: [], loadAssets: async () => {} })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  // 插胶囊后那个 0ms 的回焦定时器会在下一个用例里落到已卸载的输入框上，把选区甩到
  // <body>；不清掉，下一个用例算出的光标就是 0，`@` 菜单再也开不出来。
  window.getSelection()?.removeAllRanges()
  vi.unstubAllGlobals()
})

describe('智能体输入框', () => {
  it('`@` 从画布挑一张图，插成引用胶囊', () => {
    render()
    type('把@')

    expect(options().map((one) => one.textContent)).toContain('画布图1')
    pick('画布图1')

    expect(capsules()).toEqual(['@图1'])
  })

  it('发送时把胶囊转成按序号的引用，参考图一起带上', () => {
    render()
    type('把@')
    pick('画布图1')
    type('的背景换成浅木色')

    click('发送')

    expect(send).toHaveBeenCalledWith('把[image 1]的背景换成浅木色', [
      { imageId: 'canvas-1', dataUrl: PIXEL },
    ])
  })

  it('同一张图引用两次复用同一个序号，参考图不重复附加', () => {
    render()
    type('把@')
    pick('画布图1')
    type(' 和 @')
    pick('图1')

    expect(capsules()).toEqual(['@图1', '@图1'])

    click('发送')
    expect(send).toHaveBeenCalledWith('把[image 1] 和 [image 1]', [
      { imageId: 'canvas-1', dataUrl: PIXEL },
    ])
  })

  it('给已引用的画布图开遮罩编辑器，直接把图交过去而不是按 id 回存储里找', () => {
    render()
    type('把@')
    pick('画布图1')

    click('给参考图 @图1 画遮罩')

    const state = useStore.getState()
    expect(state.maskEditorImageId).toBe('canvas-1')
    expect(state.maskEditorSession?.targetDataUrl).toBe(PIXEL)
    expect(state.maskEditorSession?.maskDataUrl).toBe(null)
    expect(state.maskEditorSession?.keepSemantics).toBe(false)
  })

  it('画完的遮罩随这一轮提交，图换成编辑器对齐过的那张', async () => {
    render()
    type('把@')
    pick('画布图1')
    type('的桌面换成木纹')

    click('给参考图 @图1 画遮罩')
    await save({ maskDataUrl: MASK, targetImageId: 'img-prepared', targetDataUrl: PREPARED })

    click('发送')
    expect(send).toHaveBeenCalledWith('把[image 1]的桌面换成木纹', [
      { imageId: 'canvas-1', dataUrl: PREPARED, maskDataUrl: MASK },
    ])
  })

  it('已经画过的遮罩再打开时打底，移除后这一轮不再带遮罩', async () => {
    render()
    type('把@')
    pick('画布图1')
    click('给参考图 @图1 画遮罩')
    await save({ maskDataUrl: MASK, targetImageId: 'img-prepared', targetDataUrl: PREPARED })

    click('修改参考图 @图1 的遮罩')
    expect(useStore.getState().maskEditorSession?.maskDataUrl).toBe(MASK)

    await act(async () => {
      await useStore.getState().maskEditorSession?.onRemove?.()
    })

    click('发送')
    expect(send).toHaveBeenCalledWith('把[image 1]', [{ imageId: 'canvas-1', dataUrl: PREPARED }])
  })

  it('移掉参考图后引用降级为已移除，这一轮仍然发得出去', () => {
    render()
    type('把@')
    pick('画布图1')
    type('改成木色')

    click('移除参考图 @图1')

    expect(capsules()).toEqual([])
    click('发送')
    expect(send).toHaveBeenCalledWith('把@已移除图片改成木色', [])
  })
})
