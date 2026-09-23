// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AgentCreations from '../../../../features/agent/components/AgentCreations'
import { setAgentCanvasSink } from '../../../../features/agent/lib/canvasSink'
import { CanvasDoc, type CanvasEl, type ImageEl } from '../../../../features/canvas/lib/canvasDoc'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const { exportCanvasSelection } = vi.hoisted(() => ({
  exportCanvasSelection: vi.fn(async () => ({ exported: 1, failed: 0 })),
}))

vi.mock('../../../../features/canvas/lib/exportImages', () => ({
  exportCanvasSelection,
  exportableElements: () => [],
}))

const PIXEL = 'data:image/png;base64,aGk='

function image(id: string, patch: Partial<ImageEl> = {}): ImageEl {
  return {
    id,
    type: 'image',
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    rotation: 0,
    fileId: 'file-1',
    ...patch,
  }
}

let host: HTMLDivElement
let root: Root
let doc: CanvasDoc

function put(elements: CanvasEl[]): void {
  doc.restore(elements, { 'file-1': PIXEL })
}

function render(): void {
  act(() => {
    root.render(<AgentCreations doc={doc} />)
  })
}

function button(pattern: RegExp): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find((one) =>
    pattern.test(one.textContent ?? ''),
  )
  if (!found) throw new Error(`没有找到按钮 ${pattern}`)
  return found
}

function cards(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button[aria-pressed]')]
}

function card(name: string): HTMLButtonElement {
  const found = cards().find((one) => one.textContent?.includes(name))
  if (!found) throw new Error(`没有找到作品卡 ${name}`)
  return found
}

/** 这次导出实际拿到的产物 id（顺序由导出自己按画布顺序定，断言只看集合）。 */
function exportedIds(): string[] {
  const calls = exportCanvasSelection.mock.calls as unknown as Array<[unknown, string[]]>
  const last = calls[calls.length - 1]
  return [...(last?.[1] ?? [])].sort()
}

beforeEach(() => {
  doc = new CanvasDoc()
  setAgentCanvasSink(null)
  exportCanvasSelection.mockClear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('全部产物弹窗', () => {
  it('默认全选，导出的就是画布上的每一件产物', async () => {
    put([image('a', { name: '猫' }), image('b', { name: '狗' })])
    render()

    act(() => button(/查看全部产物/).click())
    expect(cards()).toHaveLength(2)
    expect(button(/导出 2 项/)).toBeTruthy()

    await act(async () => button(/导出 2 项/).click())

    expect(exportedIds()).toEqual(['a', 'b'])
  })

  it('取消勾选的那件不进这次导出', async () => {
    put([image('a', { name: '猫' }), image('b', { name: '狗' })])
    render()
    act(() => button(/查看全部产物/).click())

    act(() => card('猫').click())
    expect(card('猫').getAttribute('aria-pressed')).toBe('false')
    await act(async () => button(/导出 1 项/).click())

    expect(exportedIds()).toEqual(['b'])
  })

  it('一件都没勾时导不出去，按钮自己禁着', () => {
    put([image('a', { name: '猫' })])
    render()
    act(() => button(/查看全部产物/).click())

    act(() => cards()[0]!.click())

    expect(button(/导出 0 项/).disabled).toBe(true)
  })

  it('画布上只有标注时不给这个入口：没有产物可看', () => {
    put([
      {
        id: 'note',
        type: 'text',
        x: 0,
        y: 0,
        text: '写在画布上的字',
        fontSize: 12,
        fill: '#000',
        width: 10,
        height: 10,
      },
    ])
    render()

    expect(host.textContent).not.toContain('查看全部产物')
  })
})
