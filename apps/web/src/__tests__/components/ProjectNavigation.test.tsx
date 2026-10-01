// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import ProjectNavigation from '../../components/ProjectNavigation'
import type { CanvasProject } from '../../features/canvas/lib/projectRepository'
import { useCanvasProjectStore } from '../../features/canvas/projectStore'
import { stubPointerApis } from '../helpers/radix'

it.each([
  'chat',
  'canvas',
] as const)('shows five per group with active %s first and independent expansion', async (experience) => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  stubPointerApis()
  const projects: CanvasProject[] = Array.from({ length: 24 }, (_, index) => ({
    id: String(index),
    name: `Project ${index}`,
    experience: index % 2 === 0 ? 'chat' : 'canvas',
    createdAt: index + 1,
    updatedAt: index + 1,
    kind: 'image',
    customName: true,
    conversationId: null,
    sceneKey: `scene-${index}`,
    hasContent: true,
  }))
  const activeId = experience === 'chat' ? '0' : '1'
  useCanvasProjectStore.setState({
    projects,
    activeId,
    cloudCatalog: {},
    cloudLoading: false,
    cloudError: null,
  })
  const refresh = vi
    .spyOn(useCanvasProjectStore.getState(), 'refreshCloud')
    .mockResolvedValue(undefined)
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(<ProjectNavigation />))
    const trigger = host.querySelector<HTMLButtonElement>('[aria-label^="切换项目"]')!
    await act(async () => trigger.click())
    const sections = () => [...document.querySelectorAll('section')]
    const rows = (section: Element) => section.querySelectorAll('button:has(time)')
    expect(sections().map((section) => section.getAttribute('aria-label'))).toEqual(
      experience === 'chat' ? ['对话', '画布'] : ['画布', '对话'],
    )
    expect(sections().map((section) => rows(section).length)).toEqual([5, 5])
    expect(rows(sections()[0])[0].getAttribute('aria-current')).toBe('true')
    const groupButton = (text: string) =>
      [...sections()[0].querySelectorAll('button')].find((button) => button.textContent === text)!
    await act(async () => groupButton('再显示 5 个').click())
    expect(sections().map((section) => rows(section).length)).toEqual([10, 5])
    await act(async () => groupButton('再显示 2 个').click())
    expect(sections().map((section) => rows(section).length)).toEqual([12, 5])
    await act(async () => groupButton('收起').click())
    expect(sections().map((section) => rows(section).length)).toEqual([5, 5])
    await act(async () => groupButton('再显示 5 个').click())
    await act(async () => trigger.click())
    await act(async () => trigger.click())
    expect(sections().map((section) => rows(section).length)).toEqual([5, 5])
  } finally {
    await act(async () => root.unmount())
    host.remove()
    refresh.mockRestore()
  }
})
