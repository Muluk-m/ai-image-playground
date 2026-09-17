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

beforeEach(async () => {
  const session = agentDraft(null)
  await vi.waitFor(() => expect(session.getSnapshot().loading).toBe(false))
  session.update(EMPTY_DRAFT)
  session.setSubmitting(false)
  doc = new CanvasDoc()
  doc.restore([imageElement('canvas-1', 'file-1')], { 'file-1': PIXEL })
  send = vi.fn<(text: string, references?: readonly AgentTurnReference[]) => Promise<void>>(
    async () => {},
  )
  useAgentStore.setState({
    turn: 'idle',
    conversationId: null,
    send: async (text, references, accepted) => {
      await send(text, references)
      accepted?.()
    },
  })
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

function png(name = 'photo.png'): File {
  return new File([new Uint8Array([137, 80, 78, 71])], name, { type: 'image/png' })
}

function fireDrag(target: Element, type: string, files: File[]): void {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', {
    value: {
      files,
      types: ['Files'],
      items: files.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file })),
    },
  })
  act(() => {
    target.dispatchEvent(event)
  })
}

/** 读文件与压缩都是异步的，等它们落进引用区。 */
async function attached(): Promise<string[]> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  return [...host.querySelectorAll('img')].map((img) => img.getAttribute('src') ?? '')
}

describe('智能体输入框', () => {
  it('图片文件拖进输入框就成为参考图，名字用文件名', async () => {
    render()
    const zone = host.querySelector('[data-image-dropzone]')!

    fireDrag(zone, 'dragenter', [png()])
    expect(host.textContent).toContain('松开即作为参考图')
    fireDrag(zone, 'drop', [png('海报底图.png')])

    const sources = await attached()
    expect(sources).toHaveLength(1)
    expect(sources[0]).toMatch(/^data:image\/png;base64,/)
    expect(host.textContent).toContain('海报底图')
    expect(host.textContent).not.toContain('松开即作为参考图')

    type('把它放到浴缸旁边')
    click('发送并创作')
    expect(send).toHaveBeenCalledWith('把它放到浴缸旁边', [
      expect.objectContaining({ imageId: expect.stringMatching(/^file_/), name: '海报底图' }),
    ])
  })

  it('粘贴图片同样进引用区；非图片文件不收', async () => {
    render()
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', {
      value: {
        files: [png('clip.png'), new File(['%PDF'], 'brief.pdf', { type: 'application/pdf' })],
      },
    })
    act(() => {
      editor().dispatchEvent(event)
    })

    expect(await attached()).toHaveLength(1)
    expect(useStore.getState().toast?.message).toBe('只支持图片文件')
  })

  it('输入框卸载再挂载后保留文字、引用和遮罩', async () => {
    render()
    type('把@')
    pick('画布图1')
    click('给参考图 @图1 画遮罩')
    await save({ maskDataUrl: MASK, targetImageId: 'prepared', targetDataUrl: PREPARED })
    act(() => root.render(null))
    render()
    expect(capsules()).toEqual(['@图1'])
    expect(host.querySelector('img')?.getAttribute('src')).toBe(PREPARED)
    expect(host.textContent).toContain('MASK')
    click('发送并创作')
    expect(send).toHaveBeenCalledWith('把[image 1]', [
      { imageId: 'canvas-1', dataUrl: PREPARED, maskDataUrl: MASK },
    ])
  })

  it('敲下发送输入框立刻清空，不等服务端接收', async () => {
    let accept!: () => void
    useAgentStore.setState({
      send: async (_text, _references, accepted) => {
        await new Promise<void>((resolve) => {
          accept = () => {
            accepted?.()
            resolve()
          }
        })
      },
    })
    render()
    type('把背景换成浅木色')
    await act(async () => click('发送并创作'))
    expect(editor().textContent).toBe('')

    await act(async () => accept())
    expect(editor().textContent).toBe('')
  })

  it('服务端没收下时草稿放回输入框；用户已经在打下一句就不冲掉', async () => {
    useAgentStore.setState({ send: async () => {} })
    render()
    type('重试这段内容')
    await act(async () => click('发送并创作'))
    expect(editor().textContent).toBe('重试这段内容')
    expect(useStore.getState().toast?.message).toContain('草稿已放回')

    let finish!: () => void
    useAgentStore.setState({
      send: async () => {
        await new Promise<void>((resolve) => {
          finish = resolve
        })
      },
    })
    await act(async () => click('发送并创作'))
    expect(editor().textContent).toBe('')
    type('下一句')
    await act(async () => finish())
    expect(editor().textContent).toBe('下一句')
  })

  it('`@` 从画布挑一张图，插成引用胶囊', () => {
    render()
    type('把@')

    expect(options().map((one) => one.textContent)).toContain('画布图1')
    pick('画布图1')

    expect(capsules()).toEqual(['@图1'])
  })

  // 选区带进来的引用有自己的一套规则（撤走、手动移除、批注的竞态），归
  // `lib/selectionReferences` 与它的用例管；这里只验输入框把画布接上去了。
  it('画布选区接到引用区上：选中的图连同压着的批注成为这一轮的参考图', async () => {
    const COMPOSITE = 'data:image/png;base64,bWFya2Vk'
    const toImage = vi.fn(async () => COMPOSITE)
    doc.restore(
      [
        imageElement('canvas-1', 'file-1'),
        {
          id: 'circle',
          type: 'freedraw',
          points: [2, 2, 6, 6, 2, 6],
          stroke: '#f00',
          strokeWidth: 2,
        },
      ],
      { 'file-1': PIXEL },
    )
    act(() => {
      root.render(<AgentComposer doc={doc} editor={{ toImage }} />)
    })

    act(() => doc.setSelection(['canvas-1', 'circle']))
    expect(await attached()).toEqual([COMPOSITE])
    expect(toImage).toHaveBeenCalledWith(['canvas-1', 'circle'], {
      bounds: expect.objectContaining({ x: 0, y: 0, w: 10, h: 10 }),
    })

    type('把圈出来的地方换成木纹')
    click('发送并创作')
    expect(send).toHaveBeenCalledWith('把圈出来的地方换成木纹', [
      { imageId: 'canvas-1', dataUrl: COMPOSITE },
    ])
  })

  it('发送时把胶囊转成按序号的引用，参考图一起带上', () => {
    render()
    type('把@')
    pick('画布图1')
    type('的背景换成浅木色')

    click('发送并创作')

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

    click('发送并创作')
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

    click('发送并创作')
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

    click('发送并创作')
    expect(send).toHaveBeenCalledWith('把[image 1]', [{ imageId: 'canvas-1', dataUrl: PREPARED }])
  })

  it('移掉参考图后引用降级为已移除，这一轮仍然发得出去', () => {
    render()
    type('把@')
    pick('画布图1')
    type('改成木色')

    click('移除参考图 @图1')

    expect(capsules()).toEqual([])
    click('发送并创作')
    expect(send).toHaveBeenCalledWith('把@已移除图片改成木色', [])
  })
})
