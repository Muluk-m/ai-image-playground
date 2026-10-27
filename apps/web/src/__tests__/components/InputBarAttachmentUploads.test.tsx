// @vitest-environment jsdom
import { IDBFactory } from 'fake-indexeddb'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** 每张图挂上后上传到了哪一步：键是 dataUrl。 */
const uploads = new Map<string, { state: 'failed' | 'ready'; error?: string }>()
const primed: string[][] = []

vi.mock('../../features/agent/lib/useAgentSkills', () => ({ useAgentSkills: () => [] }))
vi.mock('../../features/agent/lib/heroHandoff', () => ({
  startCanvasFromComposer: vi.fn(async () => {}),
}))
vi.mock('../../features/agent/lib/attachmentUploads', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../features/agent/lib/attachmentUploads')>()
  return {
    ...actual,
    primeAttachmentUploads: vi.fn((refs: { dataUrl: string }[]) => {
      primed.push(refs.map((ref) => ref.dataUrl))
      return () => {}
    }),
    attachmentUploadState: (ref: { dataUrl: string }) => uploads.get(ref.dataUrl)?.state,
    attachmentUploadError: (ref: { dataUrl: string }) => uploads.get(ref.dataUrl)?.error,
    retryAttachmentUploads: vi.fn(async () => {}),
  }
})

import InputBar from '../../components/InputBar'
import { retryAttachmentUploads } from '../../features/agent/lib/attachmentUploads'
import { startCanvasFromComposer } from '../../features/agent/lib/heroHandoff'
import { useStore } from '../../store'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
const GOOD = 'data:image/png;base64,R09PRA=='
const BAD = 'data:image/png;base64,QkFE'

function mountWith(images: string[]) {
  useStore.setState({
    prompt: '只回复收到',
    createTarget: 'chat',
    inputImages: images.map((dataUrl, index) => ({ id: `img-${index}`, dataUrl })),
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(<InputBar inline />))
}

const startButton = () =>
  Array.from(host.querySelectorAll('button')).find((b) =>
    (b.getAttribute('aria-label') ?? b.textContent ?? '').includes('开始创作'),
  ) as HTMLButtonElement

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  uploads.clear()
  primed.length = 0
  vi.mocked(startCanvasFromComposer).mockClear()
  vi.mocked(retryAttachmentUploads).mockClear()
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  useStore.setState({ inputImages: [], prompt: '', createTarget: 'generate' })
  vi.unstubAllGlobals()
})

describe('首页交给智能体的参考图（BUG-27）', () => {
  it('挂上就开始上传，与对话页输入框同一套', () => {
    mountWith([GOOD])
    expect(primed.at(-1)).toEqual([GOOD])
  })

  it('坏文件当场标出并拦住发送：不建项目、不留空对话', () => {
    uploads.set(GOOD, { state: 'ready' })
    uploads.set(BAD, { state: 'failed', error: 'media_unsupported_image' })
    mountWith([GOOD, BAD])
    expect(host.querySelector('[role=alert]')?.textContent).toContain(
      '请先转换为 PNG、JPEG 或 WebP 格式',
    )
    expect(startButton().disabled).toBe(true)
    act(() => startButton().click())
    expect(startCanvasFromComposer).not.toHaveBeenCalled()
  })

  it('网络这类可重试的失败照旧能发，发送前重传一次', () => {
    uploads.set(BAD, { state: 'failed', error: 'media_network_error' })
    mountWith([BAD])
    expect(host.querySelector('[role=alert]')).toBeNull()
    expect(startButton().disabled).toBe(false)
    act(() => startButton().click())
    expect(retryAttachmentUploads).toHaveBeenCalledWith({ dataUrl: BAD })
    expect(startCanvasFromComposer).toHaveBeenCalledTimes(1)
  })

  it('全部就绪时照常发送', () => {
    uploads.set(GOOD, { state: 'ready' })
    mountWith([GOOD])
    expect(startButton().disabled).toBe(false)
    act(() => startButton().click())
    expect(retryAttachmentUploads).not.toHaveBeenCalled()
    expect(startCanvasFromComposer).toHaveBeenCalledTimes(1)
  })
})
