// @vitest-environment jsdom
import { IDBFactory } from 'fake-indexeddb'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** 每张图挂上后上传到了哪一步：键是 dataUrl。 */
const uploads = new Map<
  string,
  { state: 'failed' | 'ready' | 'uploading' | 'verifying'; error?: string; progress?: number }
>()
const oversized = new Set<string>()
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
    attachmentUploadProgress: (ref: { dataUrl: string }) => uploads.get(ref.dataUrl)?.progress,
    attachmentStackProgress: (refs: { dataUrl: string }[]) => {
      const values = refs.flatMap((ref) => {
        const upload = uploads.get(ref.dataUrl)
        return upload?.state === 'uploading' || upload?.state === 'verifying'
          ? [upload.progress]
          : []
      })
      return values.length && values.every((value) => value !== undefined)
        ? Math.floor(values.reduce((sum, value) => sum + value, 0) / values.length)
        : undefined
    },
    referenceSourceTooLarge: (source: string) => oversized.has(source),
    retryAttachmentUploads: vi.fn(async () => {}),
  }
})

import { REFERENCE_DISPLAY_KEY } from '../../components/creation/referenceDisplay'
import InputBar from '../../components/InputBar'
import { retryAttachmentUploads } from '../../features/agent/lib/attachmentUploads'
import { startCanvasFromComposer } from '../../features/agent/lib/heroHandoff'
import { useStore } from '../../store'
import { openReferenceStack } from '../helpers/radix'

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
  oversized.clear()
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

  it('坏文件：不加新的文字行；那叠缩略图上直接有 ×，点了只移走坏图', () => {
    uploads.set(GOOD, { state: 'ready' })
    uploads.set(BAD, { state: 'failed', error: 'media_unsupported_image' })
    mountWith([GOOD, BAD])
    expect(host.textContent).not.toContain('移除后可发送')
    const remove = host.querySelector<HTMLButtonElement>('button[aria-label="移除第 2 张图片"]')
    expect(remove).not.toBeNull()
    act(() => remove?.click())
    expect(useStore.getState().inputImages.map((image) => image.dataUrl)).toEqual([GOOD])
    expect(host.querySelector('[role=alert]')).toBeNull()
    expect(startButton().disabled).toBe(false)
  })

  it('上传中只在缩略图上转圈，输入框下不加文字', () => {
    uploads.set(GOOD, { state: 'uploading' })
    uploads.set(BAD, { state: 'ready' })
    mountWith([GOOD, BAD])
    const visible = Array.from(host.querySelectorAll('span')).filter(
      (el) => el.textContent?.includes('上传中') && !el.classList.contains('sr-only'),
    )
    expect(visible).toEqual([])
    expect(host.querySelector('.creation-stack-upload')).not.toBeNull()
  })

  it('还在上传时不建项目，等传完', () => {
    uploads.set(GOOD, { state: 'uploading' })
    mountWith([GOOD])
    expect(startButton().disabled).toBe(true)
    act(() => startButton().click())
    expect(startCanvasFromComposer).not.toHaveBeenCalled()
  })

  it('超时这类可重试的失败与坏图同样标出、拦住发送；缩略图上点「重试」只重传那一张（BUG-41）', () => {
    uploads.set(GOOD, { state: 'ready' })
    uploads.set(BAD, { state: 'failed', error: 'media_timeout' })
    mountWith([GOOD, BAD])
    expect(host.querySelector('[role=alert]')?.textContent).toContain('第 2 张图片：')
    expect(startButton().disabled).toBe(true)
    act(() => startButton().click())
    expect(retryAttachmentUploads).not.toHaveBeenCalled()
    expect(startCanvasFromComposer).not.toHaveBeenCalled()
    // 与坏图同一套：红框、「!」、× 常显；好图的 × 仍只在悬停时出现。
    const panel = openReferenceStack(host)
    const frames = panel.querySelectorAll('.creation-reference-frame')
    expect(frames[1]?.className).toContain('border-destructive')
    expect(frames[0]?.className).not.toContain('border-destructive')
    const removes = [...panel.querySelectorAll('.creation-reference-remove')]
    expect(removes.map((el) => el.className.includes('opacity-0'))).toEqual([true, false])
    const retries = panel.querySelectorAll<HTMLButtonElement>('.creation-reference-retry')
    expect(retries).toHaveLength(1)
    expect(retries[0]?.getAttribute('aria-label')).toContain('重试上传')
    act(() => retries[0]?.click())
    expect(retryAttachmentUploads).toHaveBeenCalledWith({ dataUrl: BAD })
    uploads.set(BAD, { state: 'ready' })
    act(() => root.render(<InputBar inline />))
    expect(host.querySelector('[role=alert]')).toBeNull()
    expect(document.querySelector('.creation-reference-retry')).toBeNull()
    expect(startButton().disabled).toBe(false)
    act(() => startButton().click())
    expect(startCanvasFromComposer).toHaveBeenCalledTimes(1)
  })

  it('坏图没有「重试」：重传也救不回来，只能移除', () => {
    uploads.set(BAD, { state: 'failed', error: 'media_unsupported_image' })
    mountWith([BAD])
    const panel = openReferenceStack(host)
    expect(panel.querySelector('.creation-reference-frame')?.className).toContain(
      'border-destructive',
    )
    expect(panel.querySelector('.creation-reference-retry')).toBeNull()
  })

  it('几张图各有各的问题时，每张的原因都列出来（BUG-44）', () => {
    const SLOW = 'data:image/png;base64,U0xPVw=='
    uploads.set(GOOD, { state: 'ready' })
    uploads.set(BAD, { state: 'failed', error: 'media_unsupported_image' })
    uploads.set(SLOW, { state: 'failed', error: 'media_timeout' })
    mountWith([GOOD, BAD, SLOW])
    const status = host.querySelector('[role=alert]')?.textContent ?? ''
    expect(status).toContain('第 2 张图片：请先转换为 PNG、JPEG 或 WebP 格式')
    expect(status).toContain('第 3 张图片：')
  })

  it('上传中缩略图和收起的那叠都显示百分比，字节交完等确认时停在 99%（BUG-42）', () => {
    uploads.set(GOOD, { state: 'uploading', progress: 42 })
    uploads.set(BAD, { state: 'verifying', progress: 99 })
    // 前面的用例展开过参考图；这里要看收起的那叠。
    localStorage.removeItem(REFERENCE_DISPLAY_KEY)
    mountWith([GOOD, BAD])
    expect(host.querySelector('.creation-stack-upload')?.textContent).toBe('70%')
    const panel = openReferenceStack(host)
    const frames = [...panel.querySelectorAll('.creation-reference-frame')]
    expect(frames.map((frame) => frame.textContent?.match(/\d+%/)?.[0])).toEqual(['42%', '99%'])
  })

  it('收起的那叠的总百分比只增不减：一张传完后不往回跳，全部传完才收掉（BUG-53）', () => {
    uploads.set(GOOD, { state: 'uploading', progress: 60 })
    uploads.set(BAD, { state: 'uploading', progress: 20 })
    localStorage.removeItem(REFERENCE_DISPLAY_KEY)
    mountWith([GOOD, BAD])
    const stack = () => host.querySelector('.creation-stack-upload')?.textContent
    expect(stack()).toBe('40%')
    uploads.set(GOOD, { state: 'ready' })
    act(() => root.render(<InputBar inline />))
    expect(stack()).toBe('40%')
    uploads.set(BAD, { state: 'uploading', progress: 70 })
    act(() => root.render(<InputBar inline />))
    expect(stack()).toBe('70%')
    uploads.set(BAD, { state: 'ready' })
    act(() => root.render(<InputBar inline />))
    expect(host.querySelector('.creation-stack-upload')).toBeNull()
  })

  it('超限的图和坏图一样：× 常显、一并移除，两处原因是同一句（BUG-49）', () => {
    const HUGE = 'data:image/png;base64,SFVHRQ=='
    oversized.add(HUGE)
    uploads.set(GOOD, { state: 'ready' })
    uploads.set(BAD, { state: 'failed', error: 'media_unsupported_image' })
    mountWith([GOOD, BAD, HUGE])
    const bottom = host.querySelector('[role=alert]')?.textContent ?? ''
    expect(bottom).toContain('第 3 张')
    expect(bottom).toContain('第 2 张图片：请先转换为 PNG、JPEG 或 WebP 格式')
    // 原因按图片顺序排：第 2 张在第 3 张前面，超限那句不总排第一。
    expect(bottom.indexOf('第 2 张')).toBeLessThan(bottom.indexOf('第 3 张'))
    const panel = openReferenceStack(host)
    expect(panel.querySelector('.creation-reference-status')?.textContent).toBe(bottom)
    const removes = [...panel.querySelectorAll('.creation-reference-remove')]
    expect(removes.map((el) => el.className.includes('opacity-0'))).toEqual([true, false, false])
  })

  it('参考区展开时原因句只在参考图上方出现一次，输入框下不再重复', () => {
    uploads.set(GOOD, { state: 'ready' })
    uploads.set(BAD, { state: 'failed', error: 'media_unsupported_image' })
    localStorage.setItem(REFERENCE_DISPLAY_KEY, 'true')
    mountWith([GOOD, BAD])
    const visible = [...host.querySelectorAll<HTMLElement>('*')].filter(
      (el) =>
        !el.closest('.sr-only') &&
        [...el.childNodes].some(
          (node) => node.nodeType === 3 && node.textContent?.includes('格式'),
        ),
    )
    expect(visible).toHaveLength(1)
    expect(visible[0]?.closest('.creation-reference-status')).not.toBeNull()
    localStorage.removeItem(REFERENCE_DISPLAY_KEY)
  })

  it('发送的是点击时的草稿', () => {
    uploads.set(GOOD, { state: 'ready' })
    mountWith([GOOD])
    act(() => startButton().click())
    expect(vi.mocked(startCanvasFromComposer).mock.calls[0]?.[0]).toMatchObject({
      references: [{ id: 'img-0', dataUrl: GOOD }],
    })
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
