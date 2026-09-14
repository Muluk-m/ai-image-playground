// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AgentLayers from '../../../../features/agent/components/AgentLayers'
import { CanvasDoc, type CanvasEl, type ImageEl } from '../../../../features/canvas/lib/canvasDoc'
import { CanvasEditor } from '../../../../features/canvas/lib/editor'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

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
let editor: CanvasEditor
/** 相机动画在 jsdom 里没有意义，只看它被要求把哪个元素带到眼前。 */
let scrollToElements: ReturnType<typeof vi.spyOn>

function render(): void {
  act(() => {
    root.render(<AgentLayers doc={doc} editor={editor} />)
  })
}

function rows(): HTMLButtonElement[] {
  return [...host.querySelectorAll<HTMLButtonElement>('li button')]
}

function names(): string[] {
  return rows().map((one) => one.querySelector('[data-layer-name]')?.textContent ?? '')
}

function put(elements: CanvasEl[], files: Record<string, string> = { 'file-1': PIXEL }): void {
  doc.restore(elements, files)
}

beforeEach(() => {
  doc = new CanvasDoc()
  editor = new CanvasEditor(doc)
  scrollToElements = vi.spyOn(editor, 'scrollToElements').mockImplementation(() => {})
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

describe('智能体图层面板', () => {
  it('画布为空时说画布是空的', () => {
    render()
    expect(host.textContent).toContain('画布还是空的')
    expect(rows()).toHaveLength(0)
  })

  it('图片行用生成提示词当名字，不是恒定的「图片」', () => {
    put([image('a', { meta: { prompt: '一只戴眼镜的橘猫' } })])
    render()

    expect(names()).toEqual(['一只戴眼镜的橘猫'])
  })

  it('没有生成溯源的图片退回「图片」', () => {
    put([image('a')])
    render()

    expect(names()).toEqual(['图片'])
  })

  it('图片行显示缩略图，取自画布自己的位图表', () => {
    put([image('a', { meta: { prompt: '橘猫' } })])
    render()

    const thumb = host.querySelector<HTMLImageElement>('li img')
    expect(thumb?.getAttribute('src')).toBe(PIXEL)
  })

  it('视频行与静态图片行可区分', () => {
    put([
      image('still', { meta: { prompt: '静态图' } }),
      image('clip', { meta: { prompt: '一段视频' }, video: { taskId: 't', outputIndex: 0 } }),
    ])
    render()

    const [clip, still] = rows()
    expect(clip.textContent).toContain('视频')
    expect(still.textContent).not.toContain('视频')
  })

  it('最上层的元素排在最前', () => {
    put([image('bottom', { meta: { prompt: '底' } }), image('top', { meta: { prompt: '顶' } })])
    render()

    expect(names()).toEqual(['顶', '底'])
  })

  it('点击一行选中画布上的元素并把它带到眼前', () => {
    put([image('a', { meta: { prompt: '猫' } }), image('b', { meta: { prompt: '狗' } })])
    render()

    act(() => {
      rows()[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect([...doc.selection]).toEqual(['b'])
    expect(scrollToElements).toHaveBeenCalledWith(['b'])
  })

  it('画布上改变选中时，对应行跟着高亮', () => {
    put([image('a', { meta: { prompt: '猫' } }), image('b', { meta: { prompt: '狗' } })])
    render()

    act(() => doc.setSelection(['a']))

    const current = rows().filter((one) => one.getAttribute('aria-current') === 'true')
    expect(current).toHaveLength(1)
    expect(current[0].textContent).toContain('猫')
  })

  it('文字、画笔、箭头各有自己的名字', () => {
    put([
      { id: 'p', type: 'freedraw', points: [0, 0, 1, 1], stroke: '#f00', strokeWidth: 2 },
      { id: 'r', type: 'arrow', points: [0, 0, 1, 1], stroke: '#f00', strokeWidth: 2 },
      {
        id: 't',
        type: 'text',
        x: 0,
        y: 0,
        text: '标题写在这里',
        fontSize: 12,
        fill: '#fff',
        width: 10,
        height: 10,
      },
    ])
    render()

    expect(names()).toEqual(['标题写在这里', '箭头', '画笔'])
  })
})
