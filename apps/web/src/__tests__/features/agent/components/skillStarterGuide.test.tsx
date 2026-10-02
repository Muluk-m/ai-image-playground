// @vitest-environment jsdom
import type { AgentSkillSummary } from '@image-playground/shared'
import { IDBFactory } from 'fake-indexeddb'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fetchAgentSkills = vi.hoisted(() => vi.fn<(mode: string) => Promise<AgentSkillSummary[]>>())

vi.mock('../../../../features/agent/lib/agentClient', async (original) => ({
  ...(await original<typeof import('../../../../features/agent/lib/agentClient')>()),
  fetchAgentSkills,
}))

import InputBar from '../../../../components/InputBar'
import SkillStarterGuide from '../../../../features/agent/components/SkillStarterGuide'
import { resetAgentSkillsCache } from '../../../../features/agent/lib/useAgentSkills'
import { setLocale } from '../../../../i18n'
import { useStore } from '../../../../store'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const PRODUCT = {
  key: 'product',
  label: { 'zh-CN': '商品素材', en: 'Product' },
  required: true,
  multiple: true,
}

function skill(overrides: Partial<AgentSkillSummary>): AgentSkillSummary {
  return {
    name: 'product-main-image',
    title: '电商主图',
    description: '何时用：主图。',
    icon: 'shopping-bag',
    summary: '商品主图',
    inputs: [PRODUCT],
    starters: [],
    verified: true,
    ...overrides,
  }
}

const MAIN_IMAGE = skill({
  scene: 'ecommerce',
  starters: [
    {
      text: { 'zh-CN': '为 {product} 出一张白底主图', en: 'Make a white main image for {product}' },
      highlight: { 'zh-CN': '白底', en: 'white' },
    },
    { text: { 'zh-CN': '给 {product} 换个角度' } },
    // 示例词「素材」也出现在位名「商品素材」里：要选中的是句子自己的那个。
    { text: { 'zh-CN': '把 {product} 存成素材' }, highlight: { 'zh-CN': '素材' } },
  ],
})

/** 没验证过的技能：起手句写了也不露出。 */
const UNVERIFIED_POSTER = skill({
  name: 'poster',
  title: '海报',
  icon: 'image-plus',
  scene: 'poster',
  verified: false,
  starters: [{ text: { 'zh-CN': '做一张活动海报' } }],
})

/** 验证过但没归场景：不进场景引导。 */
const NO_SCENE = skill({
  name: 'reverse-prompt',
  title: '反推提示词',
  icon: 'scan-search',
  starters: [{ text: { 'zh-CN': '拆解这张图' } }],
})

let host: HTMLDivElement
let root: Root

async function mount(): Promise<void> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root.render(
      <>
        <InputBar inline />
        <SkillStarterGuide />
      </>,
    )
  })
}

function buttons(): HTMLButtonElement[] {
  return [...host.querySelectorAll<HTMLButtonElement>('nav button')]
}

function button(text: string): HTMLButtonElement {
  const found = buttons().find((one) => one.textContent?.includes(text))
  if (!found) throw new Error(`no button with "${text}"`)
  return found
}

function click(target: HTMLElement): void {
  act(() => target.click())
}

function editor(): HTMLElement {
  const el = host.querySelector<HTMLElement>('[contenteditable]')
  if (!el) throw new Error('no contenteditable editor')
  return el
}

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  resetAgentSkillsCache()
  fetchAgentSkills.mockReset()
  fetchAgentSkills.mockResolvedValue([MAIN_IMAGE, UNVERIFIED_POSTER, NO_SCENE])
  useStore.setState({ prompt: '', createTarget: 'chat', toast: null })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('首页对话创作的场景引导', () => {
  it('只为有已验证起手句的场景摆按钮', async () => {
    await mount()
    expect(host.querySelector('nav')?.textContent).toContain('帮你做：')
    expect(buttons().map((one) => one.textContent)).toEqual(['电商'])
  })

  it('点开场景是带技能胶囊与素材位的起手句，返回回到场景行', async () => {
    await mount()
    click(button('电商'))
    const rows = buttons().slice(0, -1)
    expect(rows).toHaveLength(3)
    expect(rows[0]?.querySelector('[data-skill-name="product-main-image"]')?.textContent).toBe(
      '电商主图',
    )
    expect(rows[0]?.querySelector('[data-starter-input="product"]')?.textContent).toBe('商品素材')
    expect(rows[0]?.textContent).toContain('出一张白底主图')

    click(button('返回'))
    expect(buttons().map((one) => one.textContent)).toEqual(['电商'])
  })

  it('点一条起手句：输入框得到技能胶囊与句子，示例词被选中', async () => {
    await mount()
    click(button('电商'))
    click(button('白底主图'))
    expect(useStore.getState().prompt).toBe('/product-main-image 为 商品素材 出一张白底主图')
    expect(editor().querySelector('[data-skill-name="product-main-image"]')).not.toBeNull()
    expect(window.getSelection()?.toString()).toBe('白底')
  })

  it('示例词落在句子自己的文字上，不落在位名上', async () => {
    await mount()
    click(button('电商'))
    click(button('存成素材'))
    expect(useStore.getState().prompt).toBe('/product-main-image 把 商品素材 存成素材')
    const selection = window.getSelection()!
    expect(selection.toString()).toBe('素材')
    // 选区在句末那个「素材」上，不在前面的「商品素材」里。
    const anchor = selection.anchorNode?.textContent ?? ''
    expect(selection.anchorOffset).toBe(anchor.length - 2)
  })

  it('输入框里已有用户自己的话时不覆盖，提示一声', async () => {
    useStore.setState({ prompt: '我自己写的' })
    await mount()
    click(button('电商'))
    click(button('白底主图'))
    expect(useStore.getState().prompt).toBe('我自己写的')
    expect(useStore.getState().toast?.message).toBe('输入框里已有内容，清空后再选示例')
  })

  it('上一条起手句原样未动时，换一条直接替换', async () => {
    await mount()
    click(button('电商'))
    click(button('白底主图'))
    click(button('换个角度'))
    expect(useStore.getState().prompt).toBe('/product-main-image 给 商品素材 换个角度')
  })

  it('英文界面用英文句子，缺英文的那条回退中文', async () => {
    await act(async () => {
      await setLocale('en')
    })
    await mount()
    click(button('E-commerce'))
    expect(buttons()[0]?.textContent).toContain('Make a white main image for')
    expect(buttons()[0]?.querySelector('[data-starter-input]')?.textContent).toBe('Product')
    expect(buttons()[1]?.textContent).toContain('换个角度')
    click(buttons()[0]!)
    expect(useStore.getState().prompt).toBe(
      '/product-main-image Make a white main image for Product',
    )
    expect(window.getSelection()?.toString()).toBe('white')
  })

  it('目录拉取失败时整块不出现，输入框照常在', async () => {
    fetchAgentSkills.mockRejectedValue(new Error('offline'))
    await mount()
    expect(host.querySelector('nav')).toBeNull()
    expect(host.querySelector('[contenteditable]')).not.toBeNull()
  })

  it('一条已验证的技能都没有时整块不出现', async () => {
    fetchAgentSkills.mockResolvedValue([UNVERIFIED_POSTER, NO_SCENE])
    await mount()
    expect(host.querySelector('nav')).toBeNull()
  })
})
