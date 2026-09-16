// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AgentCreations from '../../../../features/agent/components/AgentCreations'
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
    root.render(<AgentCreations doc={doc} editor={editor} />)
  })
}

function rows(): HTMLButtonElement[] {
  return [...host.querySelectorAll<HTMLButtonElement>('section button, details button')]
}

function names(): string[] {
  return rows().map((one) => one.querySelector('span[title]')?.textContent ?? one.textContent ?? '')
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

describe('创作记录', () => {
  it('画布为空时说画布是空的', () => {
    render()
    expect(host.textContent).toContain('还没有创作记录')
    expect(rows()).toHaveLength(0)
  })

  it('图片行用生成提示词当名字，不是恒定的「图片」', () => {
    put([image('a', { meta: { prompt: '一只戴眼镜的橘猫' } })])
    render()

    expect(names()).toEqual(['一只戴眼镜的橘猫'])
  })

  it('历史图片缺少名称时使用稳定的文件标识', () => {
    put([image('a')])
    render()

    expect(names()).toEqual(['图片-file-1'])
  })

  it('图片行显示缩略图，取自画布自己的位图表', () => {
    put([image('a', { meta: { prompt: '橘猫' } })])
    render()

    const thumb = host.querySelector<HTMLImageElement>('section img')
    expect(thumb?.getAttribute('src')).toBe(PIXEL)
  })

  it('视频行与静态图片行可区分', () => {
    put([
      image('still', { meta: { prompt: '静态图' } }),
      image('clip', { meta: { prompt: '一段视频' }, video: { taskId: 't', outputIndex: 0 } }),
    ])
    render()

    const [clip, still] = rows()
    expect(clip.querySelector('svg')).not.toBeNull()
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

    expect(names()).toEqual(['画笔', '箭头', '标题写在这里'])
  })
})

it('任务按时间倒序分组，同批图片放在一起，预览不裁切', () => {
  put([
    image('new-a', {
      name: '新版 A',
      groupId: 'new',
      createdAt: 200,
      naturalWidth: 1500,
      naturalHeight: 1000,
    }),
    image('old', { name: '旧版', groupId: 'old', createdAt: 100 }),
    image('new-b', { name: '新版 B', groupId: 'new', createdAt: 200 }),
  ])
  render()
  const groups = [...host.querySelectorAll('section')]
  expect(groups).toHaveLength(2)
  expect(groups[0].textContent).toContain('新版 A')
  expect(groups[0].textContent).toContain('新版 B')
  expect(groups[1].textContent).toContain('旧版')
  expect(groups[0].querySelector('img')?.className).toContain('h-auto')
  expect(groups[0].textContent).toContain('1500 × 1000')
})
