// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import ProjectGrid from '../../../../features/canvas/components/ProjectGrid'
import {
  type CanvasProject,
  UNTITLED_PROJECT,
} from '../../../../features/canvas/lib/projectRepository'
import { useCanvasProjectStore } from '../../../../features/canvas/projectStore'

const untitled = (id: string, experience: 'chat' | 'canvas'): CanvasProject => ({
  id,
  name: UNTITLED_PROJECT,
  experience,
  createdAt: 1,
  updatedAt: 1,
  kind: 'image',
  customName: false,
  conversationId: null,
  sceneKey: `scene-${id}`,
  hasContent: true,
})

it('names untitled cards by their entry, like the sidebar and project switcher', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  useCanvasProjectStore.setState({
    projects: [untitled('chat', 'chat'), untitled('canvas', 'canvas')],
    activeId: null,
    cloudCatalog: {},
    cloudLoading: false,
    cloudError: null,
  })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(<ProjectGrid recent />))
    const titles = [...host.querySelectorAll('[aria-label^="打开项目"]')].map((card) =>
      card.getAttribute('aria-label'),
    )
    expect(titles.some((title) => title?.includes('未命名对话'))).toBe(true)
    expect(titles.some((title) => title?.includes('未命名画布'))).toBe(true)
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})

it('filters the full grid by chat or canvas and labels each card with its type', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  useCanvasProjectStore.setState({
    projects: [untitled('chat', 'chat'), untitled('canvas', 'canvas')],
    activeId: null,
    cloudCatalog: {},
    cloudLoading: false,
    cloudError: null,
  })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const cards = () =>
    [...host.querySelectorAll('[aria-label^="打开项目"]')].map((card) =>
      card.getAttribute('aria-label'),
    )
  try {
    await act(async () => root.render(<ProjectGrid />))
    expect(cards()).toHaveLength(2)
    const chatFilter = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.startsWith('对话'),
    ) as HTMLButtonElement
    await act(async () => chatFilter.click())
    expect(chatFilter.getAttribute('aria-pressed')).toBe('true')
    expect(cards()).toEqual([expect.stringContaining('未命名对话 · 对话')])
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})

it('offers to duplicate a live cloud project and skips a local one', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const cloud: CanvasProject = {
    ...untitled('cloud', 'canvas'),
    name: '窗台',
    customName: true,
    cloud: { revision: 2 },
  }
  const local: CanvasProject = { ...untitled('local', 'canvas'), name: '本机', customName: true }
  useCanvasProjectStore.setState({
    projects: [cloud, local],
    activeId: null,
    cloudCatalog: {},
    cloudLoading: false,
    cloudError: null,
  })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const openMenu = async (name: string) => {
    const trigger = document.querySelector(
      `button[aria-label="项目 ${name} 的更多操作"]`,
    ) as HTMLButtonElement
    await act(async () => trigger.click())
  }
  const duplicateShown = () =>
    [...document.querySelectorAll('button')].some((button) =>
      button.textContent?.includes('复制项目'),
    )
  try {
    await act(async () => root.render(<ProjectGrid />))
    await openMenu('窗台')
    expect(duplicateShown()).toBe(true)
    await openMenu('本机')
    expect(duplicateShown()).toBe(false)
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})
