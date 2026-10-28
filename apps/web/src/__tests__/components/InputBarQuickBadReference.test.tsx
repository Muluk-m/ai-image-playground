// @vitest-environment jsdom
import { IDBFactory } from 'fake-indexeddb'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** 浏览器解不出来的那几张：键是 dataUrl。jsdom 不真解图，按这张表答。 */
const undecodable = new Set<string>()

vi.mock('../../features/agent/lib/useAgentSkills', () => ({ useAgentSkills: () => [] }))
vi.mock('../../lib/canvasImage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/canvasImage')>()
  return {
    ...actual,
    loadImage: vi.fn(async (source: string) => {
      if (undecodable.has(source)) throw new Error('decode failed')
      return {} as HTMLImageElement
    }),
  }
})

import InputBar from '../../components/InputBar'
import { loadImage } from '../../lib/canvasImage'
import * as storeModule from '../../store'
import { useStore } from '../../store'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
/** 文件头是 PNG、解得出。 */
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB'
/** 文件头认不出、浏览器解得出（GIF 之类，发送前会转码）。 */
const GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACw='
/** QA 的 corrupt-random.jpg：一堆随机字节，扩展名是 jpg。 */
const CORRUPT = 'data:image/jpeg;base64,q83vEjRWeJq83vEjRWeJq83vEjRWeJq8'
/** 文件头是 PNG，后面截断了：浏览器解不出。 */
const TRUNCATED = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAC'

async function mountQuick(images: string[]) {
  useStore.setState({
    prompt: '一只橘猫',
    createTarget: 'generate',
    inputImages: images.map((dataUrl, index) => ({ id: `img-${index}`, dataUrl })),
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => root.render(<InputBar inline />))
  // 等本机解图的结论回来再看。
  await act(async () => {
    await Promise.resolve()
  })
}

const send = () =>
  [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (one) => one.getAttribute('aria-label') === '生成',
  )!

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  undecodable.clear()
  undecodable.add(CORRUPT)
  undecodable.add(TRUNCATED)
  vi.mocked(loadImage).mockClear()
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  useStore.setState({ inputImages: [], prompt: '', createTarget: 'generate' })
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('快速生成的坏参考图（BUG-59）', () => {
  it('与智能创作同一句原因、标红，拦住发送', async () => {
    const submitTask = vi.spyOn(storeModule, 'submitTask').mockResolvedValue(undefined)
    await mountQuick([PNG, GIF, CORRUPT])
    expect(host.querySelector('[role=alert]')?.textContent).toBe(
      '第 3 张图片：请先转换为 PNG、JPEG 或 WebP 格式。',
    )
    expect(host.querySelector('button[aria-label="移除第 3 张图片"]')).not.toBeNull()
    expect(host.querySelector('button[aria-label="移除第 1 张图片"]')).toBeNull()
    expect(send().disabled).toBe(true)
    act(() => send().click())
    expect(submitTask).not.toHaveBeenCalled()
  })

  it('GIF 之类文件头认不出、但解得出的照常能发', async () => {
    const submitTask = vi.spyOn(storeModule, 'submitTask').mockResolvedValue(undefined)
    await mountQuick([PNG, GIF])
    expect(host.querySelector('[role=alert]')).toBeNull()
    expect(send().disabled).toBe(false)
    act(() => send().click())
    expect(submitTask).toHaveBeenCalledTimes(1)
  })

  it('文件头对、内容坏了的也标出来，按「无法解析」说', async () => {
    await mountQuick([TRUNCATED])
    expect(host.querySelector('[role=alert]')?.textContent).toContain(
      '第 1 张图片：无法解析这张图片',
    )
    expect(send().disabled).toBe(true)
  })

  it('还没解完时先拦着，解完才放行', async () => {
    const submitTask = vi.spyOn(storeModule, 'submitTask').mockResolvedValue(undefined)
    let finish: () => void = () => {}
    const SLOW = 'data:image/webp;base64,UklGRiQAAABXRUJQVlA4IBgAAAAw'
    vi.mocked(loadImage).mockImplementationOnce(async (source) => {
      if (source === SLOW) await new Promise<void>((resolve) => (finish = resolve))
      return {} as HTMLImageElement
    })
    await mountQuick([SLOW])
    expect(send().disabled).toBe(true)
    act(() => send().click())
    expect(submitTask).not.toHaveBeenCalled()
    await act(async () => finish())
    expect(send().disabled).toBe(false)
  })

  it('移走坏图后原因消失、可以发送', async () => {
    await mountQuick([PNG, CORRUPT])
    const remove = host.querySelector<HTMLButtonElement>('button[aria-label="移除第 2 张图片"]')
    act(() => remove?.click())
    expect(useStore.getState().inputImages.map((image) => image.dataUrl)).toEqual([PNG])
    expect(host.querySelector('[role=alert]')).toBeNull()
    expect(send().disabled).toBe(false)
  })
})
