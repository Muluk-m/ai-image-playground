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

/** 换一个 BYOK profile：kind 决定协议，selectedModelId 决定模型。 */
function useProfile(kind: 'gemini' | 'openai-compat', model: string): void {
  act(() => {
    useStore.setState({
      settings: {
        ...useStore.getState().settings,
        activeProfileId: 'probe',
        profiles: [
          {
            id: 'probe',
            source: 'user-byok',
            name: 'probe',
            kind,
            baseUrl: 'https://example.com/v1',
            apiKey: 'k',
            models: [model],
            selectedModelId: model,
            preferences: { apiMode: 'images', timeout: 600, codexCli: false, apiProxy: false },
          },
        ],
      },
    })
  })
}

describe('gemini 专属参数跟着当前模型走', () => {
  it('gemini 系模型才给分辨率与思考级别', () => {
    useProfile('gemini', 'gemini-3.1-flash-image')
    render()
    toggle()

    expect(host.textContent).toContain('比例')
    expect(host.textContent).toContain('分辨率')
    expect(host.textContent).toContain('思考')
  })

  // 同一个 Gemini profile 也能指到别的模型；分辨率与思考级别只有 Gemini 图像模型认。
  it('gemini 协议但不是 gemini 系模型时收起这两项', () => {
    useProfile('gemini', 'imagen-4.0-generate')
    render()
    toggle()

    expect(host.textContent).toContain('比例')
    expect(host.textContent).not.toContain('分辨率')
    expect(host.textContent).not.toContain('思考')
  })

  it('不走 gemini 协议时一项都不给', () => {
    useProfile('openai-compat', 'gpt-image-2.5-flare')
    render()
    toggle()

    expect(host.textContent).not.toContain('分辨率')
    expect(host.textContent).not.toContain('思考')
  })
})
