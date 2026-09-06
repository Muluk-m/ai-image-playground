// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import BgSwapGallery from '../../../../features/bgswap/components/BgSwapGallery'
import { useBgSwapStore } from '../../../../features/bgswap/store'
import { useStore } from '../../../../store'
import type { TaskRecord } from '../../../../types'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../../features/library/components/AssetThumb', () => ({
  default: ({ alt }: { alt: string }) => <span>{alt}</span>,
}))

function task(id: string, patch: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id,
    prompt: 'p',
    params: {} as TaskRecord['params'],
    inputImageIds: [],
    outputImages: [],
    status: 'done',
    error: null,
    createdAt: 1,
    finishedAt: 2,
    elapsed: 1,
    ...patch,
  }
}

function version(id: string) {
  return { id, taskId: `task-${id}`, plan: '木质浴室', prompt: 'p', masked: true, createdAt: 1 }
}

const showToast = vi.fn<(message: string, type?: 'info' | 'success' | 'error') => void>()
const retryVersion = vi.fn<(versionId: string) => Promise<void>>()

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  retryVersion.mockResolvedValue(undefined)
  useStore.setState({
    showToast,
    tasks: [
      task('task-v1', { outputImages: ['out-1'] }),
      task('task-v2', { status: 'error', error: '上游报错', outputImages: [] }),
    ],
  })
  useBgSwapStore.setState({
    retryVersion,
    draft: {
      id: 'job-1',
      name: '折叠浴缸',
      preference: '',
      versionsPerImage: 1,
      createdAt: 1,
      images: [
        { imageId: 'src-1', versions: [version('v1'), version('v2')], chosenVersionId: 'v1' },
      ],
    },
  })
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

function render() {
  act(() => root.render(<BgSwapGallery />))
}

function click(element: Element) {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function buttonLabelled(text: string, scope: ParentNode = document): HTMLButtonElement {
  const found = [...scope.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)
  if (!found) throw new Error(`no button labelled ${text}`)
  return found
}

describe('the results overview', () => {
  it('reruns a failed version in place', () => {
    render()
    const failed = [...document.querySelectorAll('[data-bgswap-gallery-item]')].find((item) =>
      item.textContent?.includes('失败'),
    )
    if (!failed) throw new Error('no failed version card')

    click(buttonLabelled('重跑', failed))

    expect(retryVersion).toHaveBeenCalledWith('v2')
  })
})
