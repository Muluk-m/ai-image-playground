// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ICONS } from '../../../../components/ui/icon'
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

function modelField(): HTMLButtonElement {
  return document.body.querySelector<HTMLButtonElement>('button[aria-label="模型"]')!
}

function toggle(): void {
  act(() => trigger().click())
}

/** 卡片挂在 body 上；按分组名找。 */
function group(label: string): Element | null {
  return document.body.querySelector(`[role="group"][aria-label="${label}"]`)
}

function depthPath(root: ParentNode, depth: string): string {
  return root.querySelector(`[data-thinking-depth="${depth}"] path`)?.getAttribute('d') ?? ''
}

function glyphPath(line: string): string {
  return line.match(/d="([^"]+)"/)?.[1] ?? ''
}

function option(groupLabel: string, text: string): HTMLButtonElement {
  const button = [...(group(groupLabel)?.querySelectorAll('button') ?? [])].find((node) =>
    node.textContent?.includes(text),
  )
  if (!button) throw new Error(`Missing ${groupLabel} option: ${text}`)
  return button
}

beforeEach(() => {
  useAgentStore.setState({ thinkingDepth: 'medium', modelAuto: true })
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
    useProfile('openai-queue', 'gpt-image-2.5-flare')
    render()
    toggle()

    act(() => option('画幅', '16:9').click())
    expect(useStore.getState().params.size).toBe('1280x720')
    expect(option('画幅', '16:9').getAttribute('aria-pressed')).toBe('true')
    expect(trigger().getAttribute('aria-label')).toContain('16:9')
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
    expect(group('张数')).toBeNull()
    expect(document.body.textContent).not.toContain('张数由 Agent 按需求决定')

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
    expect(useAgentStore.getState().thinkingDepth).toBe('medium')
    expect(useAgentStore.getState().modelAuto).toBe(true)
  })
})

/** 换一条平台渠道：kind 决定协议，selectedModelId 决定模型。 */
function useProfile(kind: 'gemini-queue' | 'openai-queue', model: string): void {
  act(() => {
    setChannels([
      {
        id: 'probe',
        kind,
        label: 'probe',
        models: [
          { id: model, label: model, capabilities: ['generate', 'edit', 'quality', 'size'] },
        ],
        defaults: { apiMode: 'images', timeout: 600 },
      },
    ])
    useStore.setState({
      settings: {
        ...useStore.getState().settings,
        activeProfileId: 'probe',
        profiles: [
          {
            id: 'probe',
            source: 'builtin-edge',
            channelId: 'probe',
            selectedModelId: model,
          },
        ],
      },
    })
  })
}

describe('gemini 专属参数跟着当前模型走', () => {
  it('摘要展示实际的 Gemini 比例，不读取另一种协议的尺寸', () => {
    useProfile('gemini-queue', 'gemini-3.1-flash-image')
    useStore.setState({
      params: { ...DEFAULT_PARAMS, size: '1536x1024', gemini_aspect_ratio: '9:16' },
    })
    render()
    expect(trigger().getAttribute('aria-label')).toContain('9:16')
    expect(trigger().getAttribute('aria-label')).not.toContain('1536')
  })

  it('gemini 系模型才给分辨率与思考级别', () => {
    useProfile('gemini-queue', 'gemini-3.1-flash-image')
    render()
    toggle()

    expect(group('画幅')).not.toBeNull()
    expect(group('分辨率')).toBeNull()
    expect(group('思考深度')).not.toBeNull()
  })

  // 同一个 Gemini profile 也能指到别的模型；分辨率与思考级别只有 Gemini 图像模型认。
  it('gemini 协议但不是 gemini 系模型时收起这两项', () => {
    useProfile('gemini-queue', 'imagen-4.0-generate')
    render()
    toggle()

    expect(group('画幅')).not.toBeNull()
    expect(group('分辨率')).toBeNull()
    expect(group('思考深度')).not.toBeNull()
  })

  it('不走 gemini 协议时一项都不给', () => {
    useProfile('openai-queue', 'gpt-image-2.5-flare')
    render()
    toggle()

    expect(group('分辨率')).toBeNull()
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
  expect(option('画幅', '3:2').getAttribute('aria-pressed')).toBe('true')
  expect(group('分辨率')).toBeNull()
})

it('画幅只提供固定几档，选中后写回尺寸并显示在胶囊上', () => {
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
  expect(group('画幅')?.textContent).not.toContain('自定义')
  act(() => option('画幅', '16:9').click())
  expect(useStore.getState().params.size).toBe('1280x720')
  expect(trigger().getAttribute('aria-label')).toContain('16:9')
})

it('selects and remembers thinking depth independently of the image model', () => {
  render()
  toggle()
  expect(depthPath(trigger(), 'medium')).toBe(glyphPath(ICONS.gaugeMid.line))
  expect(depthPath(option('思考深度', '快速'), 'fast')).toBe(glyphPath(ICONS.gaugeLow.line))
  expect(depthPath(option('思考深度', '中等'), 'medium')).toBe(glyphPath(ICONS.gaugeMid.line))
  expect(depthPath(option('思考深度', '深度'), 'deep')).toBe(glyphPath(ICONS.gaugeHigh.line))

  act(() => option('思考深度', '深度').click())
  expect(option('思考深度', '深度').getAttribute('aria-pressed')).toBe('true')
  expect(useAgentStore.getState().thinkingDepth).toBe('deep')
  expect(localStorage.getItem('image-playground-agent-thinking-depth')).toBe('deep')
  // 侧栏放不下「思考：深度」，收起后用仪表指针标在画幅后面；读屏名仍带上这一档。
  expect(depthPath(trigger(), 'deep')).toBe(glyphPath(ICONS.gaugeHigh.line))
  expect(trigger().textContent).toContain('深度')
  expect(trigger().getAttribute('aria-label')).toContain('深度')
  expect(trigger().hasAttribute('data-dirty')).toBe(false)
})

it('制作模式仅调整思考深度，不显示图片摘要或修改全局图片参数', () => {
  const initialParams = useStore.getState().params
  act(() => root.render(<AgentParamsChip generationControls={false} />))
  // 没有模型 chip，摘要只写思考深度。
  const buttons = host.querySelectorAll<HTMLButtonElement>('button')
  expect(buttons).toHaveLength(1)
  expect(buttons[0]!.textContent).toContain('思考：')
  expect(depthPath(buttons[0]!, 'medium')).toBe(glyphPath(ICONS.gaugeMid.line))
  expect(buttons[0]!.textContent).not.toContain('自动尺寸')
  act(() => buttons[0]!.click())
  expect(group('思考深度')).not.toBeNull()
  expect(group('画幅')).toBeNull()
  act(() => option('思考深度', '深度').click())
  expect(useAgentStore.getState().thinkingDepth).toBe('deep')
  expect(useStore.getState().params).toEqual(initialParams)
})

it('模型和画幅收在同一颗胶囊里，点选具体模型后摘要改用模型名', () => {
  setChannels([
    {
      id: 'duo',
      kind: 'openai-queue',
      label: 'Duo',
      models: [
        { id: 'gpt-image-2', label: 'GPT Image 2', capabilities: ['quality'] },
        { id: 'gpt-image-2.5-flare', label: 'Flare', capabilities: ['quality'] },
      ],
      defaults: { apiMode: 'images', timeout: 600 },
    },
  ])
  useStore.setState({
    settings: {
      ...useStore.getState().settings,
      activeProfileId: 'duo-profile',
      profiles: [
        {
          id: 'duo-profile',
          source: 'builtin-edge',
          channelId: 'duo',
          selectedModelId: 'gpt-image-2',
        },
      ],
    },
  })
  render()
  expect(host.querySelector('[role="combobox"]')).toBeNull()
  expect(trigger().getAttribute('aria-label')).toContain('智能')
  expect(trigger().getAttribute('aria-label')).not.toContain('Image 2')
  toggle()
  act(() => modelField().click())
  const flare = [...document.body.querySelectorAll('[role="option"]')].find((node) =>
    node.textContent?.includes('Image 2.5 Flare'),
  ) as HTMLButtonElement
  act(() => flare.click())
  const profile = useStore.getState().settings.profiles[0] as { selectedModelId?: string }
  expect(profile.selectedModelId).toBe('gpt-image-2.5-flare')
  expect(useAgentStore.getState().modelAuto).toBe(false)
  expect(trigger().getAttribute('aria-label')).toContain('Image 2.5 Flare')
  const sections = [...document.body.querySelectorAll('section h3')].map((node) => node.textContent)
  expect(sections.indexOf('模型')).toBeLessThan(sections.indexOf('画幅'))
  expect(sections.indexOf('画幅')).toBeLessThan(sections.indexOf('思考深度'))
})

it('直接出图只在卡片里切换，胶囊上不再单独挂闪电', () => {
  useAgentStore.setState({ autoSubmit: false })
  render()
  expect(trigger().querySelector('[aria-label="直接出图"]')).toBeNull()
  toggle()
  const toggleSwitch = document.body.querySelector<HTMLButtonElement>('[role="switch"]')!
  act(() => toggleSwitch.click())
  expect(useAgentStore.getState().autoSubmit).toBe(true)
  expect(trigger().querySelector('[aria-label="直接出图"]')).toBeNull()
  expect(document.body.querySelector('[role="switch"]')).not.toBeNull()
})

it('图片生成模式在胶囊里写张数，面板只有 1、2、3、4、6、8', () => {
  act(() => root.render(<AgentParamsChip imageMode />))
  toggle()
  expect(group('思考深度')).toBeNull()
  expect(document.body.textContent).not.toContain('张数由 Agent 按需求决定')
  const counts = [...(group('张数')?.querySelectorAll('button') ?? [])].map(
    (node) => node.textContent,
  )
  expect(counts).toEqual(['1', '2', '3', '4', '6', '8'])
  act(() => option('张数', '6').click())
  expect(useStore.getState().params.n).toBe(6)
  expect(trigger().getAttribute('aria-label')).toContain('6 张')
})

it('模型列表可用方向键在选项间移动焦点', () => {
  setChannels([
    {
      id: 'trio',
      kind: 'openai-queue',
      label: 'Trio',
      models: [
        { id: 'gpt-image-2', label: 'GPT Image 2', capabilities: ['quality'] },
        { id: 'gpt-image-2.5-flare', label: 'Flare', capabilities: ['quality'] },
      ],
      defaults: { apiMode: 'images', timeout: 600 },
    },
  ])
  useStore.setState({
    settings: {
      ...useStore.getState().settings,
      activeProfileId: 'trio-profile',
      profiles: [
        {
          id: 'trio-profile',
          source: 'builtin-edge',
          channelId: 'trio',
          selectedModelId: 'gpt-image-2',
        },
      ],
    },
  })
  render()
  toggle()
  act(() => modelField().click())
  const options = [...document.body.querySelectorAll<HTMLButtonElement>('[role="option"]')]
  expect(options.map((node) => node.tabIndex)).toEqual([0, -1, -1])
  options[0]!.focus()
  act(() => {
    options[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  })
  expect(document.activeElement).toBe(options[1])
  act(() => {
    options[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
  })
  expect(document.activeElement).toBe(options[0])
})
