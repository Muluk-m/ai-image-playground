// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import AgentParamsChip from '../../../../features/agent/components/AgentParamsChip'
import { useAgentStore } from '../../../../features/agent/store'
import { setChannels } from '../../../../lib/channels/channelStore'
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
  return host.querySelector<HTMLButtonElement>('button[aria-label^="生成设置: "]')!
}

function toggle(): void {
  act(() => trigger().click())
}

/** 卡片挂在 body 上；按分组名找。 */
function group(label: string): Element | null {
  return document.body.querySelector(`[role="group"][aria-label="${label}"]`)
}

function option(groupLabel: string, text: string): HTMLButtonElement {
  const button = [...(group(groupLabel)?.querySelectorAll('button') ?? [])].find((node) =>
    node.textContent?.includes(text),
  )
  if (!button) throw new Error(`Missing ${groupLabel} option: ${text}`)
  return button
}

beforeEach(() => {
  useAgentStore.setState({ thinkingDepth: 'medium' })
  setChannels([])
  useStore.setState({ params: { ...DEFAULT_PARAMS } })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
})

describe('智能体输入框的生成设置', () => {
  it('点开才出现设置卡片，再点收起', () => {
    render()

    toggle()
    expect(trigger().getAttribute('aria-expanded')).toBe('true')

    toggle()
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
  })

  it('卡片里没有「透明」和「防改写」，也没有张数：智能体那条路做不到或自己决定', () => {
    render()
    toggle()

    expect(document.body.textContent).not.toContain('透明')
    expect(document.body.textContent).not.toContain('防改写')
    expect(group('数量')).toBeNull()
  })

  it('按 Esc 收起卡片', () => {
    render()
    toggle()
    expect(trigger().getAttribute('aria-expanded')).toBe('true')

    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      )
    })
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
  })

  it('选一格比例立即写回尺寸，卡片保持打开，点「完成」才收起', () => {
    useProfile('openai-compat', 'gpt-image-2.5-flare')
    render()
    toggle()

    act(() => option('比例', '16:9').click())
    expect(useStore.getState().params.size).toBe('1280x720')
    expect(option('比例', '16:9').getAttribute('aria-pressed')).toBe('true')
    expect(trigger().getAttribute('aria-label')).toContain('16:9 · 1K')

    act(() => option('分辨率', '2K').click())
    expect(useStore.getState().params.size).toBe('2560x1440')
    expect(trigger().getAttribute('aria-expanded')).toBe('true')

    const done = [...document.body.querySelectorAll('button')].find(
      (node) => node.textContent === '完成',
    )
    act(() => done?.click())
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
  })

  it('「恢复默认」回到智能比例与中等思考', () => {
    useStore.setState({ params: { ...DEFAULT_PARAMS, size: '2560x1440', quality: 'high' } })
    useAgentStore.setState({ thinkingDepth: 'deep' })
    render()
    toggle()

    const reset = [...document.body.querySelectorAll('button')].find(
      (node) => node.textContent === '恢复默认',
    )
    act(() => reset?.click())
    expect(useStore.getState().params.size).toBe('auto')
    expect(useStore.getState().params.quality).toBe('auto')
    expect(useAgentStore.getState().thinkingDepth).toBe('medium')
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

/**
 * 自带 Key 的配置在智能体这条路上不生效：服务端没有 BYOK 分支，模型一律从内置渠道挑。
 * 模型 chip 写 profile 的模型名就是「界面写 A、实际花钱跑 B」，所以那个名字不能出现，
 * 卡片里得说清楚为什么。
 */
it('自带 Key 时模型 chip 不摆本地模型名，卡片说明智能体只能用内置渠道', () => {
  useProfile('openai-compat', 'my-private-image-model')
  render()

  expect(host.textContent).not.toContain('my-private-image-model')
  expect(host.textContent).toContain('内置渠道模型')

  toggle()
  expect(document.body.textContent).toContain('智能体只能用内置渠道的模型')
})

describe('gemini 专属参数跟着当前模型走', () => {
  it('摘要展示实际的 Gemini 比例，不读取另一种协议的尺寸', () => {
    useProfile('gemini', 'gemini-3.1-flash-image')
    useStore.setState({
      params: { ...DEFAULT_PARAMS, size: '1536x1024', gemini_aspect_ratio: '9:16' },
    })
    render()
    expect(trigger().getAttribute('aria-label')).toContain('9:16')
    expect(trigger().getAttribute('aria-label')).not.toContain('1536')
  })

  it('gemini 系模型才给分辨率与思考级别', () => {
    useProfile('gemini', 'gemini-3.1-flash-image')
    render()
    toggle()

    expect(group('比例')).not.toBeNull()
    expect(group('分辨率')).not.toBeNull()
    expect(group('思考')).not.toBeNull()
  })

  // 同一个 Gemini profile 也能指到别的模型；分辨率与思考级别只有 Gemini 图像模型认。
  it('gemini 协议但不是 gemini 系模型时收起这两项', () => {
    useProfile('gemini', 'imagen-4.0-generate')
    render()
    toggle()

    expect(group('比例')).not.toBeNull()
    expect(group('分辨率')).toBeNull()
    expect(group('思考')).toBeNull()
  })

  it('不走 gemini 协议时一项都不给', () => {
    useProfile('openai-compat', 'gpt-image-2.5-flare')
    render()
    toggle()

    expect(group('思考')).toBeNull()
  })
})

it('仅支持比例的模型在摘要和卡片中都显示比例，不给分辨率', () => {
  setChannels([
    {
      id: 'ratio',
      kind: 'openai-queue',
      label: 'Ratio',
      models: [{ id: 'flare', label: 'Flare', capabilities: ['quality'] }],
      defaults: { apiMode: 'images', timeout: 600 },
    },
  ])
  useStore.setState({
    settings: {
      ...useStore.getState().settings,
      activeProfileId: 'ratio-profile',
      profiles: [
        {
          id: 'ratio-profile',
          source: 'builtin-edge',
          channelId: 'ratio',
          selectedModelId: 'flare',
        },
      ],
    },
    params: { ...DEFAULT_PARAMS, size: '1536x1024' },
  })
  render()
  expect(trigger().getAttribute('aria-label')).toContain('3:2')
  expect(trigger().getAttribute('aria-label')).not.toContain('1536')
  toggle()
  expect(option('比例', '3:2').getAttribute('aria-pressed')).toBe('true')
  expect(group('分辨率')).toBeNull()
})

it('仅支持比例的模型在自定义里填预设比例：仍回显实际比例', () => {
  setChannels([
    {
      id: 'ratio',
      kind: 'openai-queue',
      label: 'Ratio',
      models: [{ id: 'flare', label: 'Flare', capabilities: ['quality'] }],
      defaults: { apiMode: 'images', timeout: 600 },
    },
  ])
  useStore.setState({
    settings: {
      ...useStore.getState().settings,
      activeProfileId: 'ratio-profile',
      profiles: [
        {
          id: 'ratio-profile',
          source: 'builtin-edge',
          channelId: 'ratio',
          selectedModelId: 'flare',
        },
      ],
    },
  })
  render()
  toggle()
  act(() => option('比例', '自定义').click())
  const input = () =>
    document.body.querySelector<HTMLInputElement>('input[aria-label="输入自定义比例"]')
  act(() => {
    const el = input()!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(el, '16:9')
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.focus()
  })
  act(() => input()?.blur())
  expect(useStore.getState().params.size).toBe('1280x720')
  expect(input()?.value).toBe('16:9')
})

it('selects and remembers thinking depth independently of the image model', () => {
  render()
  toggle()
  act(() => option('思考深度', '深度').click())
  expect(option('思考深度', '深度').getAttribute('aria-pressed')).toBe('true')
  expect(useAgentStore.getState().thinkingDepth).toBe('deep')
  expect(localStorage.getItem('image-playground-agent-thinking-depth')).toBe('deep')
  // 思考深度不进摘要（对话面板放不下），偏离默认时 chip 上亮点提示。
  expect(trigger().hasAttribute('data-dirty')).toBe(true)
})
