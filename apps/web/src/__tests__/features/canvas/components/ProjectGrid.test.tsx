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
