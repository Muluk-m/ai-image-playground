// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest'
import AgentCreations from '../../../../features/agent/components/AgentCreations'
import { type AgentCanvasSink, setAgentCanvasSink } from '../../../../features/agent/lib/canvasSink'
import { CanvasDoc, type CanvasEl, type ImageEl } from '../../../../features/canvas/lib/canvasDoc'

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
/** 定位与缩略图是同一条出口上的两个方法，测的是「有没有走那条出口」。 */
let focus: Mock<(objectIds: readonly string[]) => void>
let thumbnail: Mock<(objectId: string) => Promise<string | null>>

/** 画布只在创作模式挂着时才注册 sink；这里造一个不动真画布的替身。 */
function stubSink(partial: Partial<AgentCanvasSink> = {}): AgentCanvasSink {
  const sink: AgentCanvasSink = {
    has: (id) => doc.elements.some((one) => one.id === id),
    async place() {
      return 'placed'
    },
    async reserve() {
      return []
    },
    discard() {},
    markFailed() {},
    focus,
    thumbnail,
    ...partial,
  }
  setAgentCanvasSink(sink)
  return sink
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((one) => {
    resolve = one
  })
  return { promise, resolve }
}

function render(): void {
  act(() => {
    root.render(<AgentCreations doc={doc} />)
  })
}

/** 缩略图是逐件取的，每件至少要放过一轮微任务。 */
async function settle(ticks = 8): Promise<void> {
  for (let i = 0; i < ticks; i += 1) await act(async () => {})
}

function rows(): HTMLButtonElement[] {
  return [...host.querySelectorAll<HTMLButtonElement>('section button, details button')]
}

function names(): string[] {
  return rows().map((one) => one.querySelector('span[title]')?.textContent ?? one.textContent ?? '')
}

function sources(): (string | null)[] {
  return [...host.querySelectorAll<HTMLImageElement>('section img')].map((one) =>
    one.getAttribute('src'),
  )
}

function put(elements: CanvasEl[], files: Record<string, string> = { 'file-1': PIXEL }): void {
  doc.restore(elements, files)
}

beforeEach(() => {
  doc = new CanvasDoc()
  focus = vi.fn<(objectIds: readonly string[]) => void>()
  thumbnail = vi.fn<(objectId: string) => Promise<string | null>>(async (id) => `thumb:${id}`)
  stubSink()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  setAgentCanvasSink(null)
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

  it('图片行的缩略图取自画布出口，不是画布里的全尺寸位图', async () => {
    put([image('a', { meta: { prompt: '橘猫' } })])
    render()
    await settle()

    expect(thumbnail).toHaveBeenCalledWith('a')
    expect(sources()).toEqual(['thumb:a'])
  })

  it('缩略图还没到时先占住位，不说「预览不可用」', async () => {
    const pending = deferred<string | null>()
    thumbnail.mockReturnValue(pending.promise)
    put([image('a', { meta: { prompt: '橘猫' } })])
    render()
    await settle(2)

    expect(sources()).toEqual([])
    expect(host.textContent).not.toContain('预览不可用')

    pending.resolve(PIXEL)
    await settle()
    expect(sources()).toEqual([PIXEL])
  })

  it('画布取不出缩略图时说预览不可用', async () => {
    thumbnail.mockResolvedValue(null)
    put([image('a', { meta: { prompt: '橘猫' } })])
    render()
    await settle()

    expect(sources()).toEqual([])
    expect(host.textContent).toContain('预览不可用')
  })

  it('视频行与静态图片行可区分', async () => {
    put([
      image('still', { meta: { prompt: '静态图' } }),
      image('clip', { meta: { prompt: '一段视频' }, video: { taskId: 't', outputIndex: 0 } }),
    ])
    render()
    await settle()

    const [clip, still] = rows()
    expect(clip.querySelector('svg')).not.toBeNull()
    expect(still.textContent).not.toContain('视频')
  })

  it('最上层的元素排在最前', () => {
    put([image('bottom', { meta: { prompt: '底' } }), image('top', { meta: { prompt: '顶' } })])
    render()

    expect(names()).toEqual(['顶', '底'])
  })

  it('点击一行交给画布出口定位，自己不碰选中与镜头', async () => {
    put([image('a', { meta: { prompt: '猫' } }), image('b', { meta: { prompt: '狗' } })])
    render()
    await settle()

    act(() => {
      rows()[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(focus).toHaveBeenCalledWith(['b'])
    expect([...doc.selection]).toEqual([])
  })

  it('对象已经不在画布上时点选不报错，跳过与否由画布出口决定', async () => {
    // 列表读的是文档快照，画布上那个对象可能已经没了。真实 sink 会把它滤掉，替身照做。
    stubSink({
      has: () => false,
      focus: (ids) => focus(ids.filter(() => false)),
      async thumbnail() {
        return null
      },
    })
    put([image('a', { meta: { prompt: '猫' } })])
    render()
    await settle()

    expect(() => {
      act(() => {
        rows()[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
    }).not.toThrow()
    expect(focus).toHaveBeenCalledWith([])
    expect([...doc.selection]).toEqual([])
  })

  it('画布上改变选中时，对应行跟着高亮', () => {
    put([image('a', { meta: { prompt: '猫' } }), image('b', { meta: { prompt: '狗' } })])
    render()

    act(() => doc.setSelection(['a']))

    const current = rows().filter((one) => one.getAttribute('aria-current') === 'true')
    expect(current).toHaveLength(1)
    expect(current[0].textContent).toContain('猫')
  })

  it('文档版本每帧都在变，位图没换就不重取缩略图', async () => {
    put([image('a', { meta: { prompt: '猫' } })])
    render()
    await settle()
    expect(thumbnail).toHaveBeenCalledTimes(1)

    act(() => doc.notifyAssetLoaded())
    act(() => doc.setSelection(['a']))
    await settle()

    expect(thumbnail).toHaveBeenCalledTimes(1)
    expect(sources()).toEqual(['thumb:a'])
  })

  it('对象换了位图才重取缩略图', async () => {
    put([image('a', { meta: { prompt: '猫' } })])
    render()
    await settle()

    thumbnail.mockResolvedValue('thumb:next')
    act(() => put([image('a', { fileId: 'file-2', meta: { prompt: '猫' } })], { 'file-2': PIXEL }))
    await settle()

    expect(thumbnail).toHaveBeenCalledTimes(2)
    expect(sources()).toEqual(['thumb:next'])
  })

  it('画布换掉之后迟到的缩略图被丢弃', async () => {
    const stale = deferred<string | null>()
    thumbnail.mockReturnValue(stale.promise)
    put([image('a', { meta: { prompt: '猫' } })])
    render()
    await settle(2)

    const next = vi.fn<(objectId: string) => Promise<string | null>>(async () => 'thumb:next')
    act(() => {
      stubSink({ thumbnail: next })
    })
    await settle()
    stale.resolve('thumb:stale')
    await settle()

    expect(sources()).toEqual(['thumb:next'])
  })

  it('画布没挂上时仍然列出作品，缩略图退回文档里的位图', async () => {
    put([image('a', { meta: { prompt: '猫' } })])
    setAgentCanvasSink(null)
    render()
    await settle()

    expect(names()).toEqual(['猫'])
    // 出口不在，图源只剩画布文档：宁可是全尺寸位图，也好过永远的骨架屏。
    expect(sources()).toEqual([PIXEL])
    expect(thumbnail).not.toHaveBeenCalled()
    expect(() => {
      act(() => {
        rows()[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
    }).not.toThrow()
  })

  it('画布没挂上、文档里也没有位图时说预览不可用', async () => {
    put([image('a', { meta: { prompt: '猫' }, fileId: 'missing' })])
    setAgentCanvasSink(null)
    render()
    await settle()

    expect(sources()).toEqual([])
    expect(host.textContent).toContain('预览不可用')
  })

  it('画布挂上之后缩略图换成出口给的那张', async () => {
    put([image('a', { meta: { prompt: '猫' } })])
    setAgentCanvasSink(null)
    render()
    await settle()
    expect(sources()).toEqual([PIXEL])

    act(() => {
      stubSink()
    })
    await settle()

    expect(thumbnail).toHaveBeenCalledWith('a')
    expect(sources()).toEqual(['thumb:a'])
  })

  it('画布没挂上时点选先记下，画布挂上后补一次定位', async () => {
    put([image('a', { meta: { prompt: '猫' } }), image('b', { meta: { prompt: '狗' } })])
    setAgentCanvasSink(null)
    render()
    await settle()

    act(() => {
      rows()[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(focus).not.toHaveBeenCalled()

    act(() => {
      stubSink()
    })
    await settle()

    expect(focus.mock.calls).toEqual([[['b']]])
  })

  it('画布没挂上时连点两件，只定位最后点的那件', async () => {
    put([image('a', { meta: { prompt: '猫' } }), image('b', { meta: { prompt: '狗' } })])
    setAgentCanvasSink(null)
    render()
    await settle()

    act(() => {
      rows()[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
      rows()[1].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    act(() => {
      stubSink()
    })
    await settle()

    expect(focus.mock.calls).toEqual([[['a']]])
  })

  it('作品从画布上删掉后，缩略图缓存不替它留着位置', async () => {
    put([image('a', { meta: { prompt: '猫' } })])
    render()
    await settle()
    expect(thumbnail).toHaveBeenCalledTimes(1)

    act(() => put([]))
    await settle()
    act(() => put([image('a', { meta: { prompt: '猫' } })]))
    await settle()

    expect(thumbnail).toHaveBeenCalledTimes(2)
    expect(sources()).toEqual(['thumb:a'])
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

it('任务按时间倒序分组，同批图片放在一起，预览不裁切', async () => {
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
  await settle()
  const groups = [...host.querySelectorAll('section')]
  expect(groups).toHaveLength(2)
  expect(groups[0].textContent).toContain('新版 A')
  expect(groups[0].textContent).toContain('新版 B')
  expect(groups[1].textContent).toContain('旧版')
  expect(groups[0].querySelector('img')?.className).toContain('h-auto')
  expect(groups[0].textContent).toContain('1500 × 1000')
})
