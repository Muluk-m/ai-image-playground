// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import DetailModal from '../../components/DetailModal'
import { useStore } from '../../store'
import { DEFAULT_PARAMS, type TaskRecord } from '../../types'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const THUMBNAIL = 'data:image/webp;base64,dGh1bWI='
const ORIGINAL = 'data:image/png;base64,b3JpZ2luYWw='

const { loadImageOriginal, loadImagePreview } = vi.hoisted(() => ({
  loadImageOriginal: vi.fn(),
  loadImagePreview: vi.fn(),
}))

vi.mock('../../lib/imageSource', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/imageSource')>()),
  loadImageOriginal,
  loadImagePreview,
}))

let host: HTMLDivElement
let root: Root
let releaseOriginal: (url: string) => void

const task: TaskRecord = {
  id: 'task-1',
  prompt: '一张很大的图',
  params: { ...DEFAULT_PARAMS },
  inputImageIds: [],
  maskTargetImageId: null,
  maskImageId: null,
  outputImages: ['image-1'],
  status: 'done',
  error: null,
  createdAt: 1_000,
  finishedAt: 61_000,
  elapsed: 60_000,
}

beforeEach(() => {
  loadImagePreview.mockResolvedValue({ url: THUMBNAIL, width: 4000, height: 3000 })
  // 原图读多久由测试自己决定：这段时间就是用户盯着面板的那段时间。
  loadImageOriginal.mockImplementation(
    () =>
      new Promise<string>((resolve) => {
        releaseOriginal = resolve
      }),
  )
  useStore.setState({ tasks: [task], detailTaskId: task.id })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

function mainImage(): HTMLImageElement | null {
  return document.body.querySelector<HTMLImageElement>('img.saveable-image')
}

it('原图还在读时先铺缩略图，尺寸角标按缩略图记的原始宽高出', async () => {
  await act(async () => root.render(<DetailModal />))

  expect(mainImage()?.src).toBe(THUMBNAIL)
  expect(document.body.textContent).toContain('4000×3000')

  await act(async () => {
    releaseOriginal(ORIGINAL)
  })

  expect(mainImage()?.src).toBe(ORIGINAL)
})

it('内容安全拒绝：卡上写可行动的那句、给改提示词的出路，不给原样重试', async () => {
  const upstream =
    'Your request was rejected by the safety system. If you believe this is an error, contact us at help.openai.com and include the request ID 2b502fc3.'
  useStore.setState({
    tasks: [
      { ...task, status: 'error', error: upstream, errorCode: 'content_policy', outputImages: [] },
    ],
    detailTaskId: task.id,
  })

  await act(async () => root.render(<DetailModal />))

  const text = document.body.textContent ?? ''
  expect(text).toContain('没通过内容审核')
  // 上游英文原文只留给「复制完整错误」，不糊在卡面上。
  expect(text).not.toContain('safety system')
  const labels = Array.from(document.body.querySelectorAll('button')).map((b) =>
    (b.textContent ?? b.getAttribute('aria-label') ?? '').trim(),
  )
  expect(labels).toContain('改一下提示词')
  // 原样重试稳定复现同一个拒绝，这条出路撤掉。
  expect(labels.some((label) => label.includes('重试'))).toBe(false)
})

it('认不出分类的失败照旧显示上游原文', async () => {
  useStore.setState({
    tasks: [{ ...task, status: 'error', error: 'HTTP 502 bad gateway', outputImages: [] }],
    detailTaskId: task.id,
  })

  await act(async () => root.render(<DetailModal />))

  expect(document.body.textContent).toContain('HTTP 502 bad gateway')
})
