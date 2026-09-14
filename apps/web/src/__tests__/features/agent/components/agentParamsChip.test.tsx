// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import AgentParamsChip from '../../../../features/agent/components/AgentParamsChip'
import { useStore } from '../../../../store'
import { DEFAULT_PARAMS } from '../../../../types'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

function render(): void {
  act(() => root.render(<AgentParamsChip />))
}

function trigger(): HTMLButtonElement {
  return host.querySelector<HTMLButtonElement>('button[aria-label="生成参数"]')!
}

function toggle(): void {
  act(() => trigger().dispatchEvent(new MouseEvent('click', { bubbles: true })))
}

beforeEach(() => {
  useStore.setState({ params: { ...DEFAULT_PARAMS } })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('智能体输入框的生成参数', () => {
  it('收起时只给一行摘要，没选尺寸就说自动尺寸', () => {
    render()
    expect(trigger().textContent).toContain('自动尺寸')
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
  })

  it('摘要跟着当前参数走', () => {
    act(() => {
      useStore.setState({ params: { ...DEFAULT_PARAMS, size: '1024x1536', n: 3 } })
    })
    render()

    expect(trigger().textContent).toContain('1024x1536')
    expect(trigger().textContent).toContain('3 张')
  })

  it('点开才出现参数面板，再点收起', () => {
    render()
    expect(host.textContent).not.toContain('生成参数改完')

    toggle()
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
    expect(host.textContent).toContain('改完下一轮生效')

    toggle()
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
  })

  it('面板里没有「透明」和「防改写」：智能体那条路做不到，显示了就是骗人', () => {
    render()
    toggle()

    expect(host.textContent).not.toContain('透明')
    expect(host.textContent).not.toContain('防改写')
  })

  it('按 Esc 收起面板', () => {
    render()
    toggle()
    expect(trigger().getAttribute('aria-expanded')).toBe('true')

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
  })
})
