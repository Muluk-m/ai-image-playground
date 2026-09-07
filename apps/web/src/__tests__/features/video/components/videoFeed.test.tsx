// @vitest-environment jsdom
import { IDBFactory } from 'fake-indexeddb'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import VideoFeed from '../../../../features/video/components/VideoFeed'
import { useVideoStore } from '../../../../features/video/store'
import { useStore } from '../../../../store'
import { videoTask } from '../fixtures'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const TASKS = [
  videoTask({ id: 'a', prompt: '浴缸注水', createdAt: 100 }),
  videoTask({ id: 'b', prompt: '霓虹街道', createdAt: 300 }),
  videoTask({
    id: 'c',
    prompt: '沙漠日出',
    createdAt: 200,
    status: 'running',
    completedAt: null,
    source: 'image',
    firstFrameImageId: 'img-1',
    model: 'agnes-video-2.5',
  }),
]

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  useStore.setState({ showToast: vi.fn() })
  useVideoStore.setState({ tasks: TASKS, loaded: true })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(<VideoFeed />))
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

function prompts(): string[] {
  return [...host.querySelectorAll('[data-video-card-prompt]')].map(
    (node) => node.textContent ?? '',
  )
}

function filterChip(label: string): HTMLButtonElement {
  const chips = host.querySelectorAll<HTMLButtonElement>('[aria-label="结果筛选"] button')
  const found = [...chips].find((chip) => chip.textContent?.startsWith(label))
  if (!found) throw new Error(`no filter ${label}`)
  return found
}

function search(value: string) {
  const input = host.querySelector<HTMLInputElement>('input[type="search"]')
  if (!input) throw new Error('no search box')
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('reading the video feed', () => {
  it('puts what is still generating first, then newest', () => {
    expect(prompts()).toEqual(['沙漠日出', '霓虹街道', '浴缸注水'])
  })

  it('keeps only the running ones behind the 生成中 filter', () => {
    act(() => filterChip('生成中').click())

    expect(prompts()).toEqual(['沙漠日出'])
  })

  it('splits text from image sources', () => {
    act(() => filterChip('图生').click())

    expect(prompts()).toEqual(['沙漠日出'])
  })

  it('filters by model', () => {
    act(() => filterChip('Grok').click())

    expect(prompts()).toEqual(['霓虹街道', '浴缸注水'])
  })

  it('searches the description', () => {
    search('霓虹')

    expect(prompts()).toEqual(['霓虹街道'])
  })

  it('says so when nothing matches', () => {
    search('不存在的描述')

    expect(prompts()).toEqual([])
    expect(host.textContent).toContain('没有匹配的结果')
  })
})
