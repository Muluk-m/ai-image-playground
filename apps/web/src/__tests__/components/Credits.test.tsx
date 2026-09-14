// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Credits, { formatCredits } from '../../components/Credits'

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
})

function render(credits: number): void {
  act(() => root.render(<Credits credits={credits} />))
}

describe('积分的写法', () => {
  it('带千分位，小数按整数收', () => {
    expect(formatCredits(1_234)).toBe('1,234')
    expect(formatCredits(127)).toBe('127')
    expect(formatCredits(126.6)).toBe('127')
  })

  it('数字旁边是闪电，不是「积分」两个字', () => {
    render(1_234)

    expect(host.textContent).toBe('1,234')
    expect(host.querySelector('svg')).not.toBeNull()
  })

  it('闪电不是唯一信息来源：读屏读到的是「积分」', () => {
    render(1_234)

    const label = host.querySelector('[role="img"]')
    expect(label?.getAttribute('aria-label')).toBe('1,234 积分')
  })
})
