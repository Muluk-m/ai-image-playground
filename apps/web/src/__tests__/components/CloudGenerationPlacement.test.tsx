// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import type { GenerationDetail } from '@image-playground/shared'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import CloudGenerationDetail from '../../components/CloudGenerationDetail'
import { currentCanvasWorkspace, selectCanvasWorkspace } from '../../features/canvas/lib/workspaces'
import { useCanvasProjectStore } from '../../features/canvas/projectStore'
import { setClientStorageScope } from '../../lib/authScope'
import { _setRuntimeConfigForTesting } from '../../lib/runtimeConfig'
import { useStore } from '../../store'

let root: Root
let host: HTMLDivElement
const urls: string[] = []
let holdDecode = false
let releaseDecode: (() => void) | undefined
const detail: GenerationDetail = {
  id: '11111111-1111-4111-8111-111111111111',
  provider: 'openai-compat',
  model: 'image-model',
  status: 'completed',
  archiveStatus: 'ready',
  errorType: null,
  cover: null,
  source: {
    kind: 'agent',
    conversationId: 'conversation',
    turnId: 'turn',
    projectId: 'original-project',
  },
  createdAt: 1,
  startedAt: 2,
  completedAt: 3,
  revision: '3',
  prompt: '绿色的小树',
  parameters: {},
  actualParameters: {},
  inputs: [],
  mask: null,
  outputs: [
    {
      index: 0,
      artifactId: 'agent_11111111-1111-4111-8111-111111111111_0',
      mediaId: '22222222-2222-4222-8222-222222222222',
      width: 32,
      height: 24,
      contentType: 'image/png',
    },
  ],
}
beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  history.replaceState(null, '', '/')
  setClientStorageScope(crypto.randomUUID())
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'http://bff.test' } })
  urls.length = 0
  holdDecode = false
  releaseDecode = undefined
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      urls.push(input)
      if (input.includes('/access'))
        return Response.json({
          originalUrl: 'https://media.example/original',
          previewUrl: 'https://media.example/preview',
          expiresAt: Date.now() + 600000,
        })
      if (input.startsWith('https://media.example/'))
        return {
          ok: true,
          status: 200,
          blob: async () => new Blob(['image'], { type: 'image/png' }),
        } as Response
      return Response.json({ conversations: [] })
    }),
  )
  vi.stubGlobal(
    'Image',
    class {
      naturalWidth = 32
      naturalHeight = 24
      onload: (() => void) | null = null
      set src(_value: string) {
        if (holdDecode) releaseDecode = () => this.onload?.()
        else queueMicrotask(() => this.onload?.())
      }
    },
  )
  useCanvasProjectStore.setState({ projects: [], activeId: null, loaded: false, error: null })
  await useCanvasProjectStore.getState().load()
  selectCanvasWorkspace(null)
  await currentCanvasWorkspace().ready
  useStore.setState({ appMode: 'browse' })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  act(() => root.unmount())
  host.remove()
  await currentCanvasWorkspace().flush()
  setClientStorageScope(null)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
async function clickPlace() {
  const button = [...host.querySelectorAll('button')].find((node) =>
    node.textContent?.includes('放入当前项目'),
  )
  expect(button).toBeDefined()
  await act(async () => button!.click())
  await vi.waitFor(async () => {
    await act(async () => {})
    expect(button!.disabled).toBe(false)
  })
}
it('从云端历史显式放入当前项目，重复点击不复制，也不覆盖已经移动的对象', async () => {
  await act(async () => root.render(<CloudGenerationDetail detail={detail} />))
  expect(host.textContent).toContain('智能体生成')
  await clickPlace()
  const workspace = currentCanvasWorkspace()
  expect(workspace.doc.elements).toHaveLength(1)
  expect(workspace.doc.elements[0]).toMatchObject({
    id: detail.outputs[0].artifactId,
    type: 'image',
  })
  expect(Object.values(workspace.doc.files)).toContain(
    'aip-media:22222222-2222-4222-8222-222222222222',
  )
  expect(useStore.getState().appMode).toBe('create')
  const placed = workspace.doc.elements[0]!
  workspace.doc.updateElements([{ id: placed.id, patch: { x: 617, y: 391 } }])
  await clickPlace()
  expect(workspace.doc.elements).toHaveLength(1)
  expect(workspace.doc.elements[0]).toMatchObject({ x: 617, y: 391 })
  workspace.editor.deleteElement(placed.id)
  await clickPlace()
  expect(workspace.doc.elements).toHaveLength(1)
  expect(urls.some((url) => url.includes('/submit') || url.includes('/upload'))).toBe(false)
})

it('读取原图期间切换项目，迟到的手动放置不污染任何项目', async () => {
  holdDecode = true
  const original = currentCanvasWorkspace()
  await act(async () => root.render(<CloudGenerationDetail detail={detail} />))
  const button = [...host.querySelectorAll('button')].find((node) =>
    node.textContent?.includes('放入当前项目'),
  )!
  await act(async () => button.click())
  await vi.waitFor(() => expect(releaseDecode).toBeDefined())
  await useCanvasProjectStore.getState().create()
  selectCanvasWorkspace(null)
  const next = currentCanvasWorkspace()
  await next.ready
  expect(next).not.toBe(original)
  await act(async () => releaseDecode!())
  await vi.waitFor(async () => {
    await act(async () => {})
    expect(button.disabled).toBe(false)
  })
  expect(original.doc.elements).toHaveLength(0)
  expect(next.doc.elements).toHaveLength(0)
  expect(useStore.getState().appMode).toBe('browse')
})
it('原图加载期间同步已经送达产物，手动放置保留同步对象的位置且不重复插入', async () => {
  holdDecode = true
  const workspace = currentCanvasWorkspace()
  await act(async () => root.render(<CloudGenerationDetail detail={detail} />))
  const button = [...host.querySelectorAll('button')].find((node) =>
    node.textContent?.includes('放入当前项目'),
  )!
  await act(async () => button.click())
  await vi.waitFor(() => expect(releaseDecode).toBeDefined())
  workspace.editor.placeImages([
    {
      id: detail.outputs[0].artifactId,
      dataUrl: 'aip-media:22222222-2222-4222-8222-222222222222',
      x: 617,
      y: 391,
      width: 32,
      height: 24,
    },
  ])
  await act(async () => releaseDecode!())
  await vi.waitFor(async () => {
    await act(async () => {})
    expect(button.disabled).toBe(false)
  })
  expect(workspace.doc.elements).toHaveLength(1)
  expect(workspace.doc.elements[0]).toMatchObject({ x: 617, y: 391 })
})

it('原项目仍有同身份的生成占位时提示等待同步，不谎报放置成功或覆盖占位', async () => {
  const workspace = currentCanvasWorkspace()
  const id = workspace.editor.createPlaceholder(
    { x: 40, y: 50, w: 360, h: 240 },
    {
      taskId: detail.id,
      clientRequestId: detail.id,
      source: 'builtin-edge',
      prompt: detail.prompt,
    },
  )
  workspace.doc.updateElements([{ id, patch: { id: detail.outputs[0]!.artifactId! } }])
  await act(async () => root.render(<CloudGenerationDetail detail={detail} />))
  await clickPlace()
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('同步')
  expect(workspace.doc.elements).toHaveLength(1)
  expect(workspace.doc.elements[0]).toMatchObject({ type: 'placeholder', x: 40, y: 50 })
  expect(useStore.getState().appMode).toBe('browse')
})
