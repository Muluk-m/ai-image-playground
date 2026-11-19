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

/** 卡片里进入模型二级页的那一行。 */
function modelField(): HTMLButtonElement {
  const row = [...document.body.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
    (node) => node.textContent?.startsWith('模型'),
  )
  if (!row) throw new Error('Missing model row')
  return row
}

function button(text: string): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
    (node) => node.textContent === text,
  )
}

/** 进模型二级页并关掉「自动选模型」，列出具体模型。 */
function chooseModelManually(): void {
  act(() => modelField().click())
  const auto = document.body.querySelector<HTMLButtonElement>('[role="dialog"] [role="switch"]')!
  act(() => auto.click())
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

  it('选一格比例立即写回尺寸，卡片保持打开，没有「完成」，点关闭收起', () => {
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

    expect(button('完成')).toBeUndefined()
    act(() =>
      document.body.querySelector<HTMLButtonElement>('[aria-label="关闭生成设置"]')?.click(),
    )
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
  })

  it('GPT 直连换比例时保住 2K，不再收成 1K', () => {
    useProfile('openai-queue', 'gpt-image-2.5-flare')
    useStore.setState({ params: { ...DEFAULT_PARAMS, size: '2560x1440' } })
    render()
    toggle()

    act(() => option('画幅', '1:1').click())
    expect(useStore.getState().params.size).toBe('2048x2048')
  })

  it('「恢复默认」回到智能比例、均衡速度、自动模型与直接出图', () => {
    useStore.setState({ params: { ...DEFAULT_PARAMS, size: '2560x1440', quality: 'high' } })
    useAgentStore.setState({ thinkingDepth: 'deep', autoSubmit: false, modelAuto: false })
    render()
    toggle()

    act(() => button('恢复默认')?.click())
    expect(useStore.getState().params.size).toBe('auto')
    expect(useAgentStore.getState().thinkingDepth).toBe('medium')
    expect(useAgentStore.getState().modelAuto).toBe(true)
    expect(useAgentStore.getState().autoSubmit).toBe(true)
    // 恢复后按钮消失，焦点交给关闭按钮。
    expect(button('恢复默认')).toBeUndefined()
    expect(document.activeElement?.getAttribute('aria-label')).toBe('关闭生成设置')
  })

  it('全是默认时胶囊只有调参图标，也没有「恢复默认」', () => {
    useAgentStore.setState({ autoSubmit: true })
    render()
    expect(trigger().textContent).toBe('')
    expect(trigger().getAttribute('aria-label')).toBe('生成设置: 智能 · 均衡')
    toggle()
    expect(button('恢复默认')).toBeUndefined()
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
    expect(group('速度')).not.toBeNull()
  })

  // 同一个 Gemini profile 也能指到别的模型；分辨率与思考级别只有 Gemini 图像模型认。
  it('gemini 协议但不是 gemini 系模型时收起这两项', () => {
    useProfile('gemini-queue', 'imagen-4.0-generate')
    render()
    toggle()

    expect(group('画幅')).not.toBeNull()
    expect(group('分辨率')).toBeNull()
    expect(group('速度')).not.toBeNull()
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

it('速度三档只写文字，选了非默认档才写进胶囊', () => {
  render()
  toggle()
  const levels = [...(group('速度')?.querySelectorAll('button') ?? [])]
  expect(levels.map((node) => node.textContent)).toEqual(['快速', '均衡', '深度'])
  expect(group('速度')?.querySelector('[data-thinking-depth]')).toBeNull()
  expect(trigger().textContent).not.toContain('均衡')

  act(() => option('速度', '深度').click())
  expect(option('速度', '深度').getAttribute('aria-pressed')).toBe('true')
  expect(useAgentStore.getState().thinkingDepth).toBe('deep')
  expect(localStorage.getItem('image-playground-agent-thinking-depth')).toBe('deep')
  expect(trigger().textContent).toContain('深度')
  expect(trigger().getAttribute('aria-label')).toContain('深度')
})

it('制作模式仅调整思考深度，不显示图片摘要或修改全局图片参数', () => {
  const initialParams = useStore.getState().params
  act(() => root.render(<AgentParamsChip generationControls={false} />))
  // 没有模型 chip，摘要只写思考深度。
  const buttons = host.querySelectorAll<HTMLButtonElement>('button')
  expect(buttons).toHaveLength(1)
  expect(buttons[0]!.getAttribute('aria-label')).toContain('速度：')
  expect(depthPath(buttons[0]!, 'medium')).toBe(glyphPath(ICONS.gaugeMid.line))
  expect(buttons[0]!.textContent).not.toContain('自动尺寸')
  act(() => buttons[0]!.click())
  expect(group('速度')).not.toBeNull()
  expect(group('画幅')).toBeNull()
  act(() => option('速度', '深度').click())
  expect(useAgentStore.getState().thinkingDepth).toBe('deep')
  expect(useStore.getState().params).toEqual(initialParams)
})

it('模型默认交给智能体；在二级页关掉自动并点选模型后，胶囊写出模型名', () => {
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
  const sections = [...document.body.querySelectorAll('section h3')].map((node) => node.textContent)
  expect(sections).toEqual(['画幅', '速度'])
  expect(modelField().textContent).toBe('模型自动')
  act(() => modelField().click())
  // 自动开着时不列模型，不在弹层里再套一层下拉。
  expect(document.body.querySelector('[role="option"]')).toBeNull()
  const auto = document.body.querySelector<HTMLButtonElement>('[role="dialog"] [role="switch"]')!
  expect(auto.getAttribute('aria-checked')).toBe('true')
  act(() => auto.click())
  const flare = [...document.body.querySelectorAll('[role="option"]')].find((node) =>
    node.textContent?.includes('Image 2.5 Flare'),
  ) as HTMLButtonElement
  act(() => flare.click())
  const profile = useStore.getState().settings.profiles[0] as { selectedModelId?: string }
  expect(profile.selectedModelId).toBe('gpt-image-2.5-flare')
  expect(useAgentStore.getState().modelAuto).toBe(false)
  expect(trigger().getAttribute('aria-label')).toContain('Image 2.5 Flare')
  expect(trigger().textContent).toContain('Image 2.5 Flare')
  // 选完回到主页。
  expect(group('画幅')).not.toBeNull()
})

it('二级页的返回回到主页，关掉卡片再打开也从主页开始', () => {
  render()
  toggle()
  act(() => modelField().click())
  expect(group('画幅')).toBeNull()
  act(() => document.body.querySelector<HTMLButtonElement>('[aria-label="返回模型"]')?.click())
  expect(group('画幅')).not.toBeNull()

  act(() => modelField().click())
  toggle()
  toggle()
  expect(group('画幅')).not.toBeNull()
})

it('「出图前确认」默认关，打开后智能体先给计划，胶囊写「先确认」', () => {
  useAgentStore.setState({ autoSubmit: true })
  render()
  toggle()
  const toggleSwitch = document.body.querySelector<HTMLButtonElement>('[role="switch"]')!
  expect(toggleSwitch.getAttribute('aria-checked')).toBe('false')
  expect(document.body.textContent).toContain('出图前确认')
  expect(document.body.textContent).not.toContain('拟好提示词后直接生成')
  act(() => toggleSwitch.click())
  expect(useAgentStore.getState().autoSubmit).toBe(false)
  expect(toggleSwitch.getAttribute('aria-checked')).toBe('true')
  expect(trigger().textContent).toContain('先确认')
  expect(trigger().getAttribute('aria-label')).toContain('先确认')

  act(() => toggleSwitch.click())
  expect(useAgentStore.getState().autoSubmit).toBe(true)
  expect(trigger().textContent).not.toContain('先确认')
})

it('图片生成模式在胶囊里写张数，面板只有 1、2、3、4、6、8', () => {
  act(() => root.render(<AgentParamsChip imageMode />))
  toggle()
  expect(group('速度')).toBeNull()
  expect(document.body.textContent).not.toContain('出图前确认')
  expect(document.body.textContent).not.toContain('张数由 Agent 按需求决定')
  const counts = [...(group('张数')?.querySelectorAll('button') ?? [])].map(
    (node) => node.textContent,
  )
  expect(counts).toEqual(['1', '2', '3', '4', '6', '8'])
  act(() => option('张数', '6').click())
  expect(useStore.getState().params.n).toBe(6)
  expect(trigger().getAttribute('aria-label')).toContain('6 张')
  expect(trigger().textContent).toContain('6 张')
})

it('图片生成模式选 Lite：只给 1、2、3、4，已选的 8 张落到 4 张（BUG-91）', () => {
  setChannels([
    {
      id: 'vx',
      kind: 'gemini-queue',
      label: 'Vertex',
      models: [
        { id: 'gemini-nano-banana-2.1', label: 'Nano Banana 2', capabilities: ['generate'] },
        {
          id: 'gemini-3.1-flash-lite-image',
          label: 'Nano Banana 2 Lite',
          capabilities: ['generate'],
        },
      ],
      defaults: { apiMode: 'images', timeout: 600 },
    },
  ])
  useStore.setState({
    params: { ...DEFAULT_PARAMS, n: 8 },
    settings: {
      ...useStore.getState().settings,
      activeProfileId: 'vx-profile',
      profiles: [
        {
          id: 'vx-profile',
          source: 'builtin-edge',
          channelId: 'vx',
          selectedModelId: 'gemini-nano-banana-2.1',
        },
      ],
    },
  })
  act(() => root.render(<AgentParamsChip imageMode />))
  expect(trigger().getAttribute('aria-label')).toContain('8 张')
  toggle()
  act(() => modelField().click())
  const lite = [...document.body.querySelectorAll('[role="option"]')].find((node) =>
    node.textContent?.includes('Lite'),
  ) as HTMLElement
  act(() => lite.click())
  const counts = [...(group('张数')?.querySelectorAll('button') ?? [])].map(
    (node) => node.textContent,
  )
  expect(counts).toEqual(['1', '2', '3', '4'])
  expect(useStore.getState().params.n).toBe(4)
  expect(trigger().getAttribute('aria-label')).toContain('4 张')
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
  chooseModelManually()
  const options = [...document.body.querySelectorAll<HTMLButtonElement>('[role="option"]')]
  expect(options.map((node) => node.tabIndex)).toEqual([0, -1])
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
