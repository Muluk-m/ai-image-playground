// @vitest-environment jsdom
import { IDBFactory } from 'fake-indexeddb'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import RemixBriefStep from '../../../../features/remix/components/RemixBriefStep'
import { useRemixStore } from '../../../../features/remix/store'
import type { RemixShot } from '../../../../features/remix/types'
import { useStore } from '../../../../store'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

function shot(overrides: Partial<RemixShot> = {}): RemixShot {
  return {
    id: 's1',
    type: 'scene',
    competitorImageId: 'i1',
    brief: {
      composition: '浴缸居中偏左',
      camera: 'eye level',
      lighting: '窗口侧逆光',
      background: '奶油色微水泥浴室',
      props: ['地毯'],
      textZones: [],
      palette: ['#e8e0d4'],
      productBox: null,
    },
    copy: { title: '', subtitle: '' },
    prompt: '图1是我方产品',
    promptEdited: false,
    enabled: true,
    referenceImageId: 'r1',
    productImageId: 'p-front',
    status: 'pending',
    ...overrides,
  }
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  useStore.setState({ showToast: vi.fn() })
  useRemixStore.getState().startNewSet()
  useRemixStore.setState((s) => ({ draft: { ...s.draft, id: 'set1', competitorImageIds: ['i1'] } }))
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
  act(() => root.render(<RemixBriefStep />))
}

function setShots(shots: RemixShot[]) {
  useRemixStore.setState((s) => ({ draft: { ...s.draft, shots } }))
}

/** React 只信任由原生 setter 改过的值，直接赋值它会当成没变。 */
function typeInto(field: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const prototype =
    field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(field, value)
  field.dispatchEvent(new Event('input', { bubbles: true }))
}

function checkbox(label: string): HTMLInputElement {
  const element = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
  if (!element) throw new Error(`no checkbox labelled ${label}`)
  return element
}

describe('the shot list', () => {
  it('renders one card per shot with its brief and prompt', () => {
    setShots([shot(), shot({ id: 's2', type: 'main', competitorImageId: 'i2' })])
    render()

    expect(document.querySelectorAll('li')).toHaveLength(2)
    expect(document.querySelector<HTMLInputElement>('input[aria-label="构图"]')?.value).toBe(
      '浴缸居中偏左',
    )
    expect(document.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('图1是我方产品')
    expect(document.body.textContent).toContain('2 镜')
  })

  it('unchecks a shot the operator does not want', () => {
    setShots([shot()])
    render()

    const box = checkbox('第 1 镜')
    expect(box.checked).toBe(true)
    act(() => box.click())

    expect(useRemixStore.getState().draft.shots[0]?.enabled).toBe(false)
  })

  it('locks a shot that has no base image at that angle', () => {
    setShots([shot({ productImageId: undefined, enabled: false })])
    render()

    expect(document.body.textContent).toContain('缺底图')
    expect(checkbox('第 1 镜').disabled).toBe(true)
  })

  it('marks a spec diagram as not generated and hides its prompt', () => {
    setShots([shot({ type: 'spec-diagram', prompt: '', enabled: false })])
    render()

    expect(document.body.textContent).toContain('不生图')
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('flags a prompt that was edited by hand', () => {
    setShots([shot()])
    render()

    const prompt = document.querySelector<HTMLTextAreaElement>('textarea')
    if (!prompt) throw new Error('no prompt field')
    act(() => typeInto(prompt, '我自己写的提示词'))

    expect(useRemixStore.getState().draft.shots[0]?.promptEdited).toBe(true)
    expect(document.body.textContent).toContain('已手动编辑')
  })

  it('explains the fallback when the analysis capability is off', () => {
    useRemixStore.setState({ analyzeNotice: '竞品图分析未开启，可以手写简报与提示词' })
    setShots([shot({ prompt: '' })])
    render()

    expect(document.body.textContent).toContain('竞品图分析未开启')
    expect(document.querySelector('textarea')).toBeTruthy()
  })

  it('asks for a set before anything can be analysed', () => {
    useRemixStore.setState((s) => ({ draft: { ...s.draft, id: null } }))
    render()

    expect(document.body.textContent).toContain('先在步骤①保存一个套')
  })
})
