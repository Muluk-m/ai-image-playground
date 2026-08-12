// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SizePickerModal from '../../components/SizePickerModal'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
})

function renderPicker(props: Partial<React.ComponentProps<typeof SizePickerModal>> = {}) {
  const onSelect = vi.fn()
  const onClose = vi.fn()
  act(() => {
    root.render(
      <SizePickerModal currentSize="auto" onSelect={onSelect} onClose={onClose} {...props} />,
    )
  })
  return { onSelect, onClose }
}

function findButton(label: string) {
  return Array.from(document.body.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label,
  )
}

function button(label: string) {
  const match = findButton(label)
  if (!match) throw new Error(`button not found: ${label}`)
  return match
}

function click(element: Element) {
  act(() => element.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (!setter) throw new Error('input value setter unavailable')
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('SizePickerModal', () => {
  it('keeps the size workflow and limits only larger tiers in Codex mode', () => {
    renderPicker({ limitTo1K: true })

    expect(button('自动')).toBeTruthy()
    expect(button('按比例')).toBeTruthy()
    expect(button('自定义宽高')).toBeTruthy()

    click(button('按比例'))
    expect(button('1K').getAttribute('aria-disabled')).toBe('false')
    expect(button('2K').getAttribute('aria-disabled')).toBe('true')
    expect(button('4K').getAttribute('aria-disabled')).toBe('true')
  })

  it('shows only ratios and returns a normalized fallback size in ratio-only mode', () => {
    const { onSelect, onClose } = renderPicker({
      currentSize: '1024x1536',
      ratioOnly: true,
    })

    expect(document.body.querySelector('h3')?.textContent).toBe('设置画面比例')
    expect(findButton('自动')).toBeUndefined()
    expect(findButton('按比例')).toBeUndefined()
    expect(findButton('自定义宽高')).toBeUndefined()
    expect(findButton('1K')).toBeUndefined()
    expect(document.body.querySelectorAll('input[type="number"]')).toHaveLength(0)
    expect(document.body.textContent).toContain('最终像素数量由模型决定，仅保证所选宽高比例。')

    click(button('16:9'))
    click(button('确定'))

    expect(onSelect).toHaveBeenCalledWith('1280x720')
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('enables all resolution tiers when size is supported', () => {
    renderPicker()
    click(button('按比例'))

    expect(button('1K').getAttribute('aria-disabled')).toBe('false')
    expect(button('2K').getAttribute('aria-disabled')).toBe('false')
    expect(button('4K').getAttribute('aria-disabled')).toBe('false')
  })

  it('keeps limited-tier explanations focusable and semantically associated', () => {
    renderPicker({ limitTo1K: true })
    click(button('按比例'))

    const twoK = button('2K')
    const descriptionId = twoK.getAttribute('aria-describedby')
    expect(twoK.disabled).toBe(false)
    expect(twoK.getAttribute('aria-disabled')).toBe('true')
    expect(descriptionId).toBeTruthy()
    expect(document.getElementById(descriptionId!)?.classList.contains('sr-only')).toBe(true)
    expect(document.getElementById(descriptionId!)?.textContent).toBe(
      '当前模型不支持 1K 以上的分辨率',
    )

    act(() => twoK.focus())
    expect(document.activeElement).toBe(twoK)
  })

  it('normalizes custom resolutions back to 1K before selection in limited mode', () => {
    const { onSelect, onClose } = renderPicker({ limitTo1K: true })
    click(button('自定义宽高'))

    const [widthInput, heightInput] = Array.from(
      document.body.querySelectorAll<HTMLInputElement>('input[type="number"]'),
    )
    setInputValue(widthInput, '2560')
    setInputValue(heightInput, '1440')
    click(button('确定'))

    expect(onSelect).toHaveBeenCalledWith('1280x720')
    expect(onClose).toHaveBeenCalledOnce()
  })
})
