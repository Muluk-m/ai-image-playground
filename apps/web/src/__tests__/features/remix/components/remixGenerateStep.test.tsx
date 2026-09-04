// @vitest-environment jsdom
import { IDBFactory } from 'fake-indexeddb'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import RemixGenerateStep from '../../../../features/remix/components/RemixGenerateStep'
import { useRemixStore } from '../../../../features/remix/store'
import type { RemixShot } from '../../../../features/remix/types'
import { useStore } from '../../../../store'
import type { TaskRecord } from '../../../../types'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

function shot(overrides: Partial<RemixShot> = {}): RemixShot {
  return {
    id: 's1',
    type: 'scene',
    sourceImageId: 'i1',
    brief: {
      composition: '',
      camera: '',
      lighting: '',
      background: '',
      props: [],
      textZones: [],
      palette: [],
      productBox: null,
    },
    copy: { title: '', subtitle: '' },
    prompt: '图1是我方产品',
    promptEdited: false,
    enabled: true,
    productImageId: 'p-front',
    taskIds: [],
    ...overrides,
  }
}

function task(id: string, patch: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id,
    prompt: 'p',
    params: {} as TaskRecord['params'],
    inputImageIds: [],
    outputImages: [],
    status: 'running',
    error: null,
    createdAt: 1,
    finishedAt: null,
    elapsed: null,
    ...patch,
  }
}

let host: HTMLDivElement
let root: Root

function seedDraft(shots: RemixShot[]) {
  useRemixStore.setState({
    draft: {
      ...useRemixStore.getState().draft,
      id: 'set-1',
      name: '奶油浴缸',
      shots,
    },
  })
}

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  useStore.setState({ showToast: vi.fn(), tasks: [] })
  useRemixStore.getState().startNewSet()
  useRemixStore.setState({ generating: false })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function render() {
  act(() => root.render(<RemixGenerateStep />))
}

function findByText(text: string): HTMLElement {
  const element = [...document.querySelectorAll('button, span, p, option')].find(
    (node) => node.textContent === text,
  )
  if (!element) throw new Error(`no element with text ${text}`)
  return element as HTMLElement
}

function click(element: Element) {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('the remix generation step', () => {
  it('asks for a saved set first', () => {
    render()

    expect(document.body.textContent).toContain('先在步骤①保存一个套')
  })

  it('counts the images this run will cost', () => {
    seedDraft([shot(), shot({ id: 's2' }), shot({ id: 's3', enabled: false })])
    useRemixStore.getState().setPerShotCount(3)
    render()

    expect(document.body.textContent).toContain('本套 6 张')
    expect(document.body.textContent).toContain('完成 0/2')
  })

  it('shows every shot with the state its task is in', () => {
    seedDraft([
      shot({ id: 's1', taskIds: ['t1'] }),
      shot({ id: 's2', taskIds: ['t2'] }),
      shot({ id: 's3' }),
    ])
    useStore.setState({
      tasks: [
        task('t1', { status: 'done', outputImages: ['o1'] }),
        task('t2', { status: 'error', error: '上游 429' }),
      ],
    })
    render()

    expect(document.body.textContent).toContain('完成')
    expect(document.body.textContent).toContain('失败')
    expect(document.body.textContent).toContain('上游 429')
    expect(document.body.textContent).toContain('未开始')
    expect(document.body.textContent).toContain('完成 1/3')
  })

  it('counts up on a running shot and shows the total once it is done', () => {
    seedDraft([shot({ id: 's1', taskIds: ['t1'] }), shot({ id: 's2', taskIds: ['t2'] })])
    useStore.setState({
      tasks: [
        task('t1', { createdAt: Date.now() - 65_000 }),
        task('t2', {
          status: 'done',
          createdAt: 1_000,
          finishedAt: 43_000,
          elapsed: 42_000,
          outputImages: ['o1'],
        }),
      ],
    })
    render()

    expect(document.body.textContent).toContain('生成中 1:05')
    expect(document.body.textContent).toContain('完成 · 42s')
  })

  it('hides the spinner but keeps the words when motion is reduced', () => {
    seedDraft([shot({ taskIds: ['t1'] })])
    useStore.setState({ tasks: [task('t1')] })
    render()

    const spinner = document.querySelector('svg.animate-spin')
    expect(spinner?.getAttribute('class')).toContain('motion-reduce:hidden')
  })

  it('shows the run is going while the whole set is submitted', () => {
    seedDraft([shot()])
    useRemixStore.setState({ generating: true })
    render()

    const button = findByText('生成中')
    expect(button.hasAttribute('disabled')).toBe(true)
    expect(button.querySelector('svg.animate-spin')).not.toBeNull()
  })

  it('regenerates just one shot', () => {
    const regenerateShot = vi.fn().mockResolvedValue(undefined)
    seedDraft([shot()])
    useRemixStore.setState({ regenerateShot })
    render()

    click(findByText('重新生成'))

    expect(regenerateShot).toHaveBeenCalledWith('s1')
  })

  it('starts the whole set from one button', () => {
    const generateSet = vi.fn().mockResolvedValue(undefined)
    seedDraft([shot()])
    useRemixStore.setState({ generateSet })
    render()

    click(findByText('开始生成'))

    expect(generateSet).toHaveBeenCalled()
  })

  it('pads the selling point shot on export and crops the rest', () => {
    seedDraft([shot({ id: 's1', type: 'selling-point' }), shot({ id: 's2', type: 'scene' })])
    render()

    const fits = [
      ...document.querySelectorAll<HTMLSelectElement>('select[aria-label$="镜导出方式"]'),
    ]

    expect(fits.map((select) => select.value)).toEqual(['letterbox', 'crop'])
  })

  it('offers the platform sizes for the export', () => {
    seedDraft([shot()])
    render()

    expect(findByText('打包下载')).toBeTruthy()
    expect(document.body.textContent).toContain('亚马逊 2000×2000')
    expect(document.body.textContent).toContain('拼多多 750×1000')
  })
})
