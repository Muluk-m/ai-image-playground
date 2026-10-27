// @vitest-environment jsdom
import { IDBFactory } from 'fake-indexeddb'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** 每张图挂上后上传到了哪一步：键是 dataUrl。 */
const uploads = new Map<string, { state: 'failed' | 'ready' | 'uploading'; error?: string }>()
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
    expect(primed[primed.length - 1]).toEqual([GOOD])
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

  it('坏文件：输入框下说清哪张、移除后可发；那叠缩略图上直接有 ×，点了只移走坏图', () => {
    uploads.set(GOOD, { state: 'ready' })
    uploads.set(BAD, { state: 'failed', error: 'media_unsupported_image' })
    mountWith([GOOD, BAD])
    const alerts = Array.from(host.querySelectorAll('[role=alert]')).map((el) => el.textContent)
    expect(alerts).toContain('第 2 张图片无法使用，移除后可发送')
    const remove = host.querySelector<HTMLButtonElement>('button[aria-label="移除第 2 张图片"]')
    expect(remove).not.toBeNull()
    act(() => remove?.click())
    expect(useStore.getState().inputImages.map((image) => image.dataUrl)).toEqual([GOOD])
    expect(host.querySelector('[role=alert]')).toBeNull()
    expect(startButton().disabled).toBe(false)
  })

  it('上传进度写在输入框下，不只给读屏', () => {
    uploads.set(GOOD, { state: 'uploading' })
    uploads.set(BAD, { state: 'ready' })
    mountWith([GOOD, BAD])
    const visible = Array.from(host.querySelectorAll('span')).filter(
      (el) => el.textContent === '上传中 1/2' && !el.classList.contains('sr-only'),
    )
    expect(visible.length).toBeGreaterThan(0)
  })

  it('还在上传时不建项目，等传完', () => {
    uploads.set(GOOD, { state: 'uploading' })
    mountWith([GOOD])
    expect(startButton().disabled).toBe(true)
    act(() => startButton().click())
    expect(startCanvasFromComposer).not.toHaveBeenCalled()
  })

  it('网络这类可重试的失败显示原因、仍可点：先重传，成功后才建项目', async () => {
    uploads.set(BAD, { state: 'failed', error: 'media_network_error' })
    mountWith([BAD])
    expect(host.querySelector('[role=alert]')?.textContent).toBeTruthy()
    expect(startButton().disabled).toBe(false)
    let finish!: () => void
    vi.mocked(retryAttachmentUploads).mockImplementationOnce(
      () =>
        new Promise<void>(
          (resolve) =>
            (finish = () => {
              uploads.set(BAD, { state: 'ready' })
              resolve()
            }),
        ),
    )
    act(() => startButton().click())
    expect(retryAttachmentUploads).toHaveBeenCalledWith({ dataUrl: BAD })
    expect(startCanvasFromComposer).not.toHaveBeenCalled()
    expect(startButton().disabled).toBe(true)
    await act(async () => finish())
    expect(startCanvasFromComposer).toHaveBeenCalledTimes(1)
  })

  it('重传期间改了草稿就作罢，不把没确认过的内容发出去', async () => {
    uploads.set(BAD, { state: 'failed', error: 'media_network_error' })
    mountWith([BAD])
    let finish!: () => void
    vi.mocked(retryAttachmentUploads).mockImplementationOnce(
      () => new Promise<void>((resolve) => (finish = resolve)),
    )
    act(() => startButton().click())
    act(() => startButton().click())
    expect(retryAttachmentUploads).toHaveBeenCalledTimes(1)
    act(() => useStore.getState().setPrompt('改过的文字'))
    await act(async () => finish())
    expect(startCanvasFromComposer).not.toHaveBeenCalled()
  })

  it('发送的是点击时的草稿', () => {
    uploads.set(GOOD, { state: 'ready' })
    mountWith([GOOD])
    act(() => startButton().click())
    expect(vi.mocked(startCanvasFromComposer).mock.calls[0]?.[0]).toMatchObject({
      references: [{ id: 'img-0', dataUrl: GOOD }],
    })
  })

  it('重传仍失败就留在首页，不建项目', async () => {
    uploads.set(BAD, { state: 'failed', error: 'media_network_error' })
    mountWith([BAD])
    vi.mocked(retryAttachmentUploads).mockRejectedValueOnce(new Error('media_network_error'))
    await act(async () => startButton().click())
    expect(startCanvasFromComposer).not.toHaveBeenCalled()
    expect(startButton().disabled).toBe(false)
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
