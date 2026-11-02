// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { TOOL_PREVIEW_IMAGES } from '../../../../features/toolbox/components/ToolPreview'
import { TOOLS } from '../../../../features/toolbox/lib/registry'
import { toolFromPath, toolPath } from '../../../../features/toolbox/lib/toolRoute'
import { useToolboxStore } from '../../../../features/toolbox/store'
import { pathAppMode } from '../../../../lib/appPaths'
import { installWorkbenchNavigation } from '../../../../lib/navigation/workbenchNavigation'
import { useStore } from '../../../../store'

let cleanup: (() => void) | undefined
afterEach(() => {
  cleanup?.()
  cleanup = undefined
  history.replaceState(null, '', '/')
  useToolboxStore.setState({ activeTool: null, items: [] })
  useStore.setState({ appMode: 'canvas' })
  vi.unstubAllGlobals()
})

it('gives every tool its own address and reads it back', () => {
  for (const tool of TOOLS) {
    const path = toolPath(tool.id)
    expect(path).toMatch(/^\/tools\/[a-z]+$/)
    expect(pathAppMode(path)).toBe('tools')
    expect(toolFromPath(path)).toBe(tool.id)
    expect(toolFromPath(`${path}/`)).toBe(tool.id)
  }
  expect(toolPath('export')).toBe('/tools/resize')
  expect(toolPath(null)).toBe('/tools')
  expect(toolFromPath('/tools')).toBeNull()
  expect(toolFromPath('/tools/unknown')).toBeNull()
  expect(toolFromPath('/tools/%E0%A4%A')).toBeNull()
  expect(pathAppMode('/tools/compress/extra')).toBeNull()
})

it('opens a tool from its address, writes history on switches, and keeps imported images', () => {
  history.replaceState(null, '', '/tools/compress')
  cleanup = installWorkbenchNavigation()
  expect(useStore.getState().appMode).toBe('tools')
  expect(useToolboxStore.getState().activeTool).toBe('compress')
  const items = [
    {
      id: 'a',
      name: 'a.png',
      url: 'blob:a',
      type: 'image/png',
      size: 10,
      width: 10,
      height: 10,
      decodable: true,
    },
  ]
  useToolboxStore.setState({ items })
  const before = history.length
  useToolboxStore.getState().openTool('export')
  expect(location.pathname).toBe('/tools/resize')
  expect(history.length).toBe(before + 1)
  expect(useToolboxStore.getState().items).toBe(items)
  useToolboxStore.getState().closeTool()
  expect(location.pathname).toBe('/tools')
  expect(useToolboxStore.getState().items).toBe(items)
  history.back()
})

it('restores the tool on back/forward and folds an unknown tool into the catalog', () => {
  history.replaceState(null, '', '/tools')
  cleanup = installWorkbenchNavigation()
  history.replaceState(null, '', '/tools/collage')
  window.dispatchEvent(new PopStateEvent('popstate'))
  expect(useToolboxStore.getState().activeTool).toBe('collage')
  history.replaceState(null, '', '/tools/nope')
  window.dispatchEvent(new PopStateEvent('popstate'))
  expect(useToolboxStore.getState().activeTool).toBeNull()
  expect(location.pathname).toBe('/tools')
})

it('draws catalog previews only from images bundled with the app', () => {
  expect(TOOL_PREVIEW_IMAGES.length).toBeGreaterThan(0)
  for (const src of TOOL_PREVIEW_IMAGES) {
    expect(src.startsWith('/website-assets/')).toBe(true)
    expect(existsSync(resolve(__dirname, '../../../../../public', `.${src}`))).toBe(true)
  }
})
