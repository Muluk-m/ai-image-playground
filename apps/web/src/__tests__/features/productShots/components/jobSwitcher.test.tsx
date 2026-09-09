// @vitest-environment jsdom
import { IDBFactory } from 'fake-indexeddb'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import JobSwitcher from '../../../../features/productShots/components/JobSwitcher'
import { productShotJobStore } from '../../../../features/productShots/lib/jobStore'
import { useProductShotsStore } from '../../../../features/productShots/store'
import type { ProductShotJob } from '../../../../features/productShots/types'
import { useStore } from '../../../../store'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

function job(id: string, name: string, updatedAt: number, versions = 0): ProductShotJob {
  return {
    id,
    name,
    images: [
      {
        imageId: `image-${id}`,
        // 历史任务的蒙版已就绪；列表交互不应启动真实后台抠图。
        sourceMatte: {
          status: 'ready',
          backend: 'wasm-u2netp',
          alphaImageId: `alpha-${id}`,
          targetImageId: `image-${id}`,
          previewImageId: `preview-${id}`,
          edited: false,
        },
        versions: Array.from({ length: versions }, (_, index) => ({
          id: `${id}-v${index}`,
          taskId: `task-${id}-${index}`,
          plan: '换背景',
          prompt: '锁住产品',
          masked: true,
          createdAt: updatedAt,
        })),
      },
    ],
    preference: '',
    versionsPerImage: 1,
    createdAt: 1_700_000_000_000,
    updatedAt,
  }
}

async function seed(...jobs: ProductShotJob[]) {
  for (const record of jobs) await productShotJobStore.put(record)
  await act(async () => {
    await useProductShotsStore.getState().loadJobs()
  })
  act(() => useProductShotsStore.getState().selectJob(jobs[0].id))
}

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  useStore.setState({ showToast: vi.fn(), confirmDialog: null, tasks: [] })
  useProductShotsStore.setState({ jobs: [] })
  useProductShotsStore.getState().startNewJob()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

/** 落盘走 IndexedDB，微任务刷一轮不够。 */
async function settle() {
  for (let round = 0; round < 5; round++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

function render() {
  act(() => root.render(<JobSwitcher />))
}

function click(element: Element | null) {
  if (!element) throw new Error('nothing to click')
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function find(selector: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(selector)
  if (!element) throw new Error(`no ${selector}`)
  return element
}

function type(label: string, value: string) {
  const input = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
  if (!input) throw new Error(`no input labelled ${label}`)
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function press(input: HTMLElement, key: string) {
  act(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  })
}

function openList() {
  click(find('[data-job-switcher-trigger]'))
}

function optionNames(): string[] {
  return [...document.querySelectorAll('[data-job-option]')].map(
    (option) => option.querySelector('[data-job-option-name]')?.textContent ?? '',
  )
}

describe('the product shot job switcher', () => {
  it('lists the jobs newest first and switches to the one that is picked', async () => {
    await seed(job('a', '折叠浴缸', 200), job('b', '露营灯', 300))
    render()

    expect(find('[data-job-switcher-trigger]').textContent).toContain('折叠浴缸')
    openList()

    expect(optionNames()).toEqual(['露营灯', '折叠浴缸'])
    click(find('[data-job-option][data-job-id="b"]'))

    expect(useProductShotsStore.getState().activeJobId).toBe('b')
    expect(find('[data-job-switcher-trigger]').textContent).toContain('露营灯')
  })

  it('narrows the list down to what the search matches', async () => {
    await seed(job('a', '折叠浴缸', 200), job('b', '露营灯', 300))
    render()
    openList()

    type('搜索任务', '浴缸')

    expect(optionNames()).toEqual(['折叠浴缸'])
  })

  it('shows how many images and versions a job holds', async () => {
    await seed(job('a', '折叠浴缸', 200, 3))
    render()
    openList()

    expect(find('[data-job-option][data-job-id="a"]').textContent).toContain('1 图 · 3 版')
  })

  it('keeps the new name after a rename is entered', async () => {
    await seed(job('a', '折叠浴缸', 200))
    render()

    click(find('[aria-label="重命名任务"]'))
    type('任务名', '日式浴室主图')
    press(find('input[aria-label="任务名"]'), 'Enter')
    await settle()

    expect(useProductShotsStore.getState().draft.name).toBe('日式浴室主图')
    const saved = await productShotJobStore.list()
    expect(saved.find((record) => record.id === 'a')?.name).toBe('日式浴室主图')
  })

  it('drops the edit when escape ends it', async () => {
    await seed(job('a', '折叠浴缸', 200))
    render()

    act(() => {
      find('[data-job-name]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })
    type('任务名', '日式浴室主图')
    press(find('input[aria-label="任务名"]'), 'Escape')
    await settle()

    expect(useProductShotsStore.getState().draft.name).toBe('折叠浴缸')
    expect(find('[data-job-name]').textContent).toBe('折叠浴缸')
  })

  it('deletes a job only after the confirmation is taken, and leaves its images alone', async () => {
    await seed(job('a', '折叠浴缸', 200), job('b', '露营灯', 300))
    render()
    openList()

    click(find('[aria-label="删除任务 露营灯"]'))
    expect(useProductShotsStore.getState().jobs).toHaveLength(2)

    const dialog = useStore.getState().confirmDialog
    if (!dialog) throw new Error('no confirmation was asked for')
    act(() => dialog.action())
    await settle()

    expect(useProductShotsStore.getState().jobs.map((record) => record.id)).toEqual(['a'])
    expect(await productShotJobStore.list()).toHaveLength(1)
  })

  it('starts a fresh job from the button next to the name', async () => {
    await seed(job('a', '折叠浴缸', 200))
    render()

    click(find('[data-job-new]'))

    expect(useProductShotsStore.getState().activeJobId).toBeNull()
    expect(useProductShotsStore.getState().jobs).toHaveLength(1)
  })
})
