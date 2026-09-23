// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('../../../lib/channels/videoChannels', () => ({ isVideoModeAvailable: () => true }))

import { useAgentStore } from '../../../features/agent/store'
import ProjectsTab from '../../../features/canvas/components/ProjectsTab'
import { CanvasDoc } from '../../../features/canvas/lib/canvasDoc'
import { CloudProjectSession } from '../../../features/canvas/lib/cloudProjects'
import { CanvasEditor } from '../../../features/canvas/lib/editor'
import { openCanvasDatabase } from '../../../features/canvas/lib/persistence'
import { projectRepository } from '../../../features/canvas/lib/projectRepository'
import {
  currentCanvasWorkspace,
  selectCanvasWorkspace,
} from '../../../features/canvas/lib/workspaces'
import { useCanvasProjectStore } from '../../../features/canvas/projectStore'
import { scopedStorageName, setClientStorageScope } from '../../../lib/authScope'
import { openSceneRecord } from '../../helpers/sceneRecord'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(async () => {
  history.replaceState(null, '', '/')
  setClientStorageScope(crypto.randomUUID())
  useCanvasProjectStore.setState({
    projects: [],
    activeId: null,
    loaded: false,
    error: null,
    cloudCatalog: {},
  })
  await useCanvasProjectStore.getState().load()
  selectCanvasWorkspace(null)
  await currentCanvasWorkspace().ready
  useAgentStore.setState({ loaded: true, conversationId: null, messages: [], turn: 'idle' })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  act(() => root.unmount())
  host.remove()
  await currentCanvasWorkspace().flush()
  vi.unstubAllGlobals()
  setClientStorageScope(null)
})

function clickEntry(label: string): void {
  const button = [...host.querySelectorAll('button')].find(
    (one) => one.textContent?.trim() === label,
  )!
  act(() => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function active() {
  const state = useCanvasProjectStore.getState()
  return state.projects.find((one) => one.id === state.activeId)
}

it('项目页选「视频」建出来的是视频画布，选「图片」建的是图片画布', async () => {
  act(() => {
    root.render(<ProjectsTab search="" />)
  })
  clickEntry('视频')
  await vi.waitFor(() => expect(active()?.kind).toBe('video'))

  act(() => {
    root.render(<ProjectsTab search="" />)
  })
  clickEntry('图片')
  await vi.waitFor(() => expect(active()?.kind).toBe('image'))
})

it('画布类型建出来就定死，后来的写入改不动它', async () => {
  const project = await projectRepository.create('片子', undefined, false, false, 'video')
  expect(project.kind).toBe('video')

  await useCanvasProjectStore.getState().update(project.id, { name: '改名', customName: true })
  // 补丁类型里没有 kind，混进来的那份也不算数。
  await projectRepository.update(project.id, { kind: 'image' } as never)
  // 云端文档若与本机不一致，也以本机认领过的那份为准。
  await projectRepository.adoptKind(project.id, 'image')

  expect((await projectRepository.list())[0]).toMatchObject({ name: '改名', kind: 'video' })
})

it('这个字段之前不存在，缺它的老记录一律读作图片画布', async () => {
  const id = crypto.randomUUID()
  const db = await openCanvasDatabase()
  const storageKey = `${scopedStorageName('canvas-project')}:project:${id}`
  const legacy = {
    id,
    name: '旧画布',
    customName: true,
    conversationId: null,
    sceneKey: `${scopedStorageName('canvas')}:project:${id}`,
    createdAt: 1,
    updatedAt: 2,
    hasContent: true,
  }
  await new Promise((resolve, reject) => {
    const tx = db.transaction('scene', 'readwrite')
    tx.objectStore('scene').put(legacy, storageKey)
    tx.oncomplete = resolve
    tx.onerror = () => reject(tx.error)
  })

  expect((await projectRepository.list())[0]?.kind).toBe('image')
  expect((await projectRepository.update(id, { hasContent: false })).kind).toBe('image')
})

it('云端文档带着画布类型往返：推上去带，另一台设备读回来认领一次', async () => {
  const local = await projectRepository.create('跨设备片子', undefined, true, false, 'video')
  const editor = new CanvasEditor(new CanvasDoc())
  editor.doc.addElements([
    {
      id: 'note',
      type: 'text',
      x: 0,
      y: 0,
      width: 120,
      height: 40,
      text: '分镜',
      fontSize: 32,
      fill: '#111111',
    },
  ])
  const writes: { document: { kind?: string; elements: unknown[] }; name: string }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      writes.push(body)
      return Response.json({
        id: local.id,
        name: body.name,
        revision: body.baseRevision + 1,
        elementCount: body.document.elements.length,
        createdAt: 1,
        updatedAt: 2,
      })
    }),
  )
  const session = new CloudProjectSession(local, await openSceneRecord(local.sceneKey, editor))
  await session.load()
  expect(writes).toHaveLength(1)
  expect(writes[0]?.document.kind).toBe('video')

  // 另一台设备：目录摘要里没有画布类型，文档读回来才知道。
  setClientStorageScope(crypto.randomUUID())
  const summary = {
    id: local.id,
    name: '跨设备片子',
    revision: 1,
    createdAt: 1,
    updatedAt: 2,
    elementCount: 1,
    coverMediaId: null,
  }
  const imported = await projectRepository.importCloud(summary)
  expect(imported.kind).toBe('image')
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ ...summary, document: writes[0]!.document })),
  )
  const other = new CloudProjectSession(imported, await openSceneRecord(imported.sceneKey))
  await other.load()
  expect((await projectRepository.list())[0]?.kind).toBe('video')
})
