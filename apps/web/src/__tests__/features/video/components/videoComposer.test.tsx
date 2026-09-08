// @vitest-environment jsdom
import { IDBFactory } from 'fake-indexeddb'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useLibraryStore } from '../../../../features/library/store'
import VideoComposer from '../../../../features/video/components/VideoComposer'
import { INITIAL_VIDEO_DRAFT, useVideoStore } from '../../../../features/video/store'
import { setChannels } from '../../../../lib/channels/channelStore'
import { useStore } from '../../../../store'
import { AGNES_CHANNEL, GROK_CHANNEL } from '../fixtures'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const PRICE_PER_SECOND: Record<string, number> = {
  'grok-imagine-video': 60,
  'agnes-video-2.5-flash': 80,
}

/** 计费 overlay 在场时的门禁：ceil(单价 × 秒数 × 倍率)。 */
const usePrivateSubmissionGuard = vi.hoisted(() =>
  vi.fn((input: { model: string; quantity: number; unitMultiplier?: number }) => {
    const price = PRICE_PER_SECOND[input.model]
    if (price === undefined) return { blocked: false }
    return {
      blocked: false,
      estimatedCredits: Math.ceil(price * input.quantity * (input.unitMultiplier ?? 1)),
    }
  }),
)

vi.mock('../../../../lib/privateOverlay', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/privateOverlay')>()),
  usePrivateSubmissionGuard,
}))

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  setChannels([GROK_CHANNEL, AGNES_CHANNEL])
  useStore.setState({ showToast: vi.fn(), tasks: [] })
  useLibraryStore.setState({ assets: [] })
  useVideoStore.setState({
    tasks: [],
    loaded: false,
    draft: { ...INITIAL_VIDEO_DRAFT, source: 'image' },
  })
  useVideoStore.getState().syncModelOptions()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  setChannels([])
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

function render() {
  act(() => root.render(<VideoComposer />))
}

function click(element: Element | null) {
  if (!element) throw new Error('nothing to click')
  act(() => element.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}

function chip(group: string, text: string): HTMLElement {
  const buttons = document.querySelectorAll<HTMLElement>(`[aria-label="${group}"] button`)
  const found = [...buttons].find((button) => button.textContent?.trim() === text)
  if (!found) throw new Error(`no ${group} chip ${text}`)
  return found
}

function stripButtons(): string[] {
  const strip = document.querySelector('ul.hide-scrollbar')
  return [...(strip?.querySelectorAll('button') ?? [])].map((button) => button.textContent ?? '')
}

function submitButton(): HTMLElement {
  const buttons = [...document.querySelectorAll<HTMLElement>('button')]
  const found = buttons.find((button) => button.textContent?.startsWith('生成'))
  if (!found) throw new Error('no submit button')
  return found
}

describe('VideoComposer', () => {
  it('Grok 下尾帧槽置灰并写明原因', () => {
    render()

    const slot = [...document.querySelectorAll<HTMLElement>('[aria-disabled]')].find((node) =>
      node.textContent?.includes('尾帧'),
    )
    expect(slot?.getAttribute('aria-disabled')).toBe('true')
    expect(slot?.textContent).toContain('Grok 不支持尾帧')
    expect(slot?.querySelector('button')).toBeNull()
  })

  it('Grok 下留住的尾帧图仍在，槽里写着原因', () => {
    act(() => useVideoStore.getState().setFrame('last', 'img-last'))
    render()

    const slot = document.querySelector<HTMLElement>('[aria-disabled="true"]')
    expect(slot?.textContent).toContain('尾帧')
    expect(slot?.textContent).toContain('Grok 不支持尾帧')
    // 上传 / 选图 都不在：这一槽此刻不接新图，但已有的那张没被丢掉。
    expect(slot?.querySelector('button')).toBeNull()
    expect(useVideoStore.getState().draft.lastFrameImageId).toBe('img-last')
  })

  it('换到 Agnes 后尾帧槽可用', () => {
    render()
    click(
      [...document.querySelectorAll('button')].find((button) =>
        button.textContent?.startsWith('Agnes 2.5 Flash'),
      ) ?? null,
    )

    const slot = [...document.querySelectorAll<HTMLElement>('[aria-disabled]')].find((node) =>
      node.textContent?.includes('尾帧'),
    )
    expect(slot?.getAttribute('aria-disabled')).toBe('false')
    expect(slot?.textContent).toContain('可选')
  })

  it('模型卡片标每秒积分', () => {
    render()
    const cards = [...document.querySelectorAll('button')].filter((button) =>
      button.textContent?.includes('积分 / 秒'),
    )
    expect(cards.map((card) => card.textContent)).toEqual([
      'Grok高清 · 60 积分 / 秒',
      'Agnes 2.5 Flash首尾帧 · 80 积分 / 秒',
    ])
  })

  it('估算随时长与清晰度变化', () => {
    render()
    expect(submitButton().textContent).toBe('生成 · 300 积分')

    click(chip('时长', '8 秒'))
    expect(submitButton().textContent).toBe('生成 · 480 积分')

    click(chip('清晰度', '1080p ×1.6'))
    expect(submitButton().textContent).toBe('生成 · 768 积分')
  })

  it('没有计费时按钮只写生成', () => {
    usePrivateSubmissionGuard.mockReturnValue({ blocked: false } as never)
    render()

    expect(submitButton().textContent).toBe('生成')
    expect(document.body.textContent).not.toContain('积分')
  })

  it('运镜片段把文字追加到描述', () => {
    render()
    click(
      [...document.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === '+ 缓慢推进',
      ) ?? null,
    )

    expect(useVideoStore.getState().draft.prompt).toBe('缓慢推进')
  })

  it('图生下比例 chip 禁用并写明随首帧', () => {
    render()

    const chips = [...document.querySelectorAll<HTMLButtonElement>('[aria-label="比例"] button')]
    expect(chips.length).toBeGreaterThan(0)
    expect(chips.every((button) => button.disabled)).toBe(true)
    expect(chips.every((button) => button.getAttribute('aria-pressed') === 'false')).toBe(true)
    expect(document.body.textContent).toContain('随首帧')
  })

  it('文生下比例 chip 可选，不写随首帧', () => {
    act(() => useVideoStore.getState().setSource('text'))
    render()

    const chips = [...document.querySelectorAll<HTMLButtonElement>('[aria-label="比例"] button')]
    expect(chips.some((button) => button.disabled)).toBe(false)
    expect(chip('比例', '16:9').getAttribute('aria-pressed')).toBe('true')
    expect(document.body.textContent).not.toContain('随首帧')
  })

  it('素材条一点就填首帧', () => {
    useLibraryStore.setState({
      assets: [
        { id: 'a1', name: '白底图', imageId: 'img-a', createdAt: 1, updatedAt: 1, lastUsedAt: 1 },
      ],
    })
    render()

    click(
      [...document.querySelectorAll('button')].find((button) => button.title === '白底图') ?? null,
    )

    expect(useVideoStore.getState().draft.firstFrameImageId).toBe('img-a')
  })

  it('没有素材也没有出图时素材条不出现', () => {
    render()

    expect(document.body.textContent).not.toContain('素材库 · 最近出图')
  })

  it('素材条上的尾帧按钮跟着模型走', () => {
    useLibraryStore.setState({
      assets: [
        { id: 'a1', name: '白底图', imageId: 'img-a', createdAt: 1, updatedAt: 1, lastUsedAt: 1 },
      ],
    })
    render()
    expect(stripButtons()).toEqual(['白底图'])

    click(
      [...document.querySelectorAll('button')].find((button) =>
        button.textContent?.startsWith('Agnes 2.5 Flash'),
      ) ?? null,
    )

    expect(stripButtons()).toEqual(['白底图', '尾帧'])
  })

  it('文生标签下不显示首尾帧槽', () => {
    render()
    expect(document.body.textContent).toContain('首帧 · 尾帧')

    act(() => useVideoStore.getState().setSource('text'))

    expect(document.body.textContent).not.toContain('首帧 · 尾帧')
  })
})
