// @vitest-environment jsdom

vi.mock('../../../../lib/imagePreprocessing', async () => ({
  IMAGE_PREPROCESSING: { maxPixels: 4194304 },
  preprocessImageFile: (await import('../../../helpers/preparedImageFile')).preparedImageFile,
}))

import 'fake-indexeddb/auto'
import { Blob as NodeBlob } from 'node:buffer'
import { webcrypto } from 'node:crypto'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import AgentComposer from '../../../../features/agent/components/AgentComposer'
import { prepareAttachmentReferences } from '../../../../features/agent/lib/attachmentUploads'
import { currentProjectDraft } from '../../../../features/agent/lib/projectLifecycle'
import { useAgentStore } from '../../../../features/agent/store'
import { currentCanvasWorkspace } from '../../../../features/canvas/lib/activeProject'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import { projectRepository } from '../../../../features/canvas/lib/projectRepository'
import { useCanvasProjectStore } from '../../../../features/canvas/projectStore'
import { useLibraryStore } from '../../../../features/library/store'
import { setClientStorageScope } from '../../../../lib/authScope'
import { bootstrapClientCapabilities } from '../../../../lib/clientCapabilities'
import { loadRuntimeConfig } from '../../../../lib/runtimeConfig'
import { useStore } from '../../../../store'

// JSDOM has no image rasterizer. Project sync still exercises its real upload and binding path.
vi.mock('../../../../lib/canvasImage', async (original) => ({
  ...(await original<typeof import('../../../../lib/canvasImage')>()),
  imageDataUrlToPngBlob: async () =>
    new NodeBlob([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])], { type: 'image/png' }),
}))

const png = (index: number) =>
  `data:image/png;base64,${btoa(String.fromCharCode(137, 80, 78, 71, 13, 10, 26, 10, index))}`

async function setup(bulk = false) {
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  setClientStorageScope(crypto.randomUUID())
  const uploads: { sha256: string; purpose?: string }[] = []
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/api/capabilities'))
      return Response.json({
        'agent:attachments': true,
        'agent:bulk-attachments': true,
        'accounts:sync': true,
        ...(bulk
          ? {
              attachmentLimits: {
                logicalReferences: 100,
                imageBytes: 10 * 1024 * 1024,
                imagePixels: 40_000_000,
                uploadConcurrency: 4,
              },
            }
          : {}),
      })
    if (url.startsWith('data:image/'))
      return new Response(Uint8Array.from(atob(url.split(',')[1]!), (char) => char.charCodeAt(0)))
    if (url.endsWith('/api/media/uploads')) {
      const body = JSON.parse(String(init?.body))
      uploads.push(body)
      return Response.json({
        id: `${body.sha256.slice(0, 8)}-aaaa-4aaa-8aaa-${body.sha256.slice(8, 20)}`,
        status: 'ready',
        leaseExpiresAt: Date.now() + 1200_000,
      })
    }
    if (url.includes('/api/projects/') && init?.method === 'PUT') {
      const body = JSON.parse(String(init.body))
      return Response.json({
        id: url.split('/').slice(-1)[0],
        name: body.name,
        revision: body.baseRevision + 1,
        createdAt: 1,
        updatedAt: 2,
        elementCount: body.document.elements.length,
      })
    }
    return Response.json([])
  })
  await loadRuntimeConfig(async () =>
    Response.json({ bff: { enabled: true, baseUrl: 'http://bff.test' } }),
  )
  await bootstrapClientCapabilities(true, 'http://bff.test')
  useCanvasProjectStore.setState({ projects: [], activeId: null, loaded: true })
  useAgentStore.setState({
    conversationId: null,
    historyLoading: false,
    historyFailed: false,
    turn: 'idle',
    send: vi.fn(async () => {}),
  })
  useLibraryStore.setState({ assets: [], loadAssets: async () => {} })
  return uploads
}

async function mount(doc = new CanvasDoc()) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(<AgentComposer doc={doc} />))
  return {
    host,
    dispose: () => {
      act(() => root.unmount())
      host.remove()
    },
  }
}

afterEach(async () => {
  setClientStorageScope(null)
  await bootstrapClientCapabilities(false, '')
  vi.unstubAllGlobals()
})

it('keeps an active old attachment ready when a full upload cache admits another image', async () => {
  const uploads = await setup()
  for (let index = 0; index < 64; index++)
    await prepareAttachmentReferences([{ imageId: `warm-${index}`, dataUrl: png(index) }])
  expect(uploads).toHaveLength(64)
  const session = currentProjectDraft(null)
  await session.ready
  const first = { id: 'active-old', dataUrl: png(0) }
  session.update({ prompt: '检查这组', references: [first] })
  const ui = await mount()
  try {
    await act(async () => {
      session.update({ prompt: '检查这组', references: [first, { id: 'new', dataUrl: png(64) }] })
      await vi.waitFor(() => expect(uploads).toHaveLength(65))
      await vi.waitFor(() =>
        expect(
          ui.host.querySelector<HTMLButtonElement>('[data-slot="composer-send"]')!.disabled,
        ).toBe(false),
      )
    })
    expect(uploads).toHaveLength(65)
  } finally {
    ui.dispose()
  }
}, 10_000)

it('admits nine local files when attachments send media identities', async () => {
  const uploads = await setup()
  const session = currentProjectDraft(null)
  await session.ready
  session.update({ prompt: '检查9张', references: [] })
  const ui = await mount()
  try {
    await act(async () => {
      const input = ui.host.querySelector<HTMLInputElement>('input[type="file"]')!
      Object.defineProperty(input, 'files', {
        value: Array.from(
          { length: 9 },
          (_, index) =>
            new File([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, index])], `${index}.png`, {
              type: 'image/png',
            }),
        ),
      })
      input.dispatchEvent(new Event('change', { bubbles: true }))
      useStore.getState().confirmDialog?.action()
      useStore.getState().setConfirmDialog(null)
      await vi.waitFor(() => expect(session.getSnapshot().draft.references).toHaveLength(9))
      await vi.waitFor(() => expect(uploads).toHaveLength(9))
      await vi.waitFor(() =>
        expect(
          ui.host.querySelector<HTMLButtonElement>('[data-slot="composer-send"]')!.disabled,
        ).toBe(false),
      )
    })
  } finally {
    ui.dispose()
  }
})

it.each([
  false,
  true,
])('uses an existing cloud canvas binding for ICO pixels without uploading a conversation original (bulk=%s)', async (bulk) => {
  const uploads = await setup(bulk)
  const project = await projectRepository.create(
    '图标项目',
    undefined,
    true,
    true,
    'image',
    'canvas',
  )
  useCanvasProjectStore.setState({ projects: [project], activeId: project.id, loaded: true })
  const workspace = currentCanvasWorkspace()
  const icon = 'data:image/x-icon;base64,AAABAA=='
  let ui: Awaited<ReturnType<typeof mount>> | undefined
  try {
    await workspace.ready
    workspace.doc.addElements(
      [
        {
          id: 'icon',
          type: 'image',
          fileId: 'icon-file',
          x: 0,
          y: 0,
          width: 32,
          height: 32,
          rotation: 0,
        },
      ],
      { files: { 'icon-file': icon } },
    )
    await workspace.cloud!.sync()
    expect(workspace.cloud!.knownMediaId('icon-file', icon)).toBeDefined()
    expect(uploads.filter((upload) => upload.purpose === 'conversation-attachment')).toHaveLength(0)
    const session = currentProjectDraft(null)
    await session.ready
    session.update({ prompt: '检查图标', references: [{ id: 'icon', dataUrl: icon }] })
    ui = await mount(workspace.doc)
    await act(async () => {
      await vi.waitFor(() =>
        expect(
          ui!.host.querySelector<HTMLButtonElement>('[data-slot="composer-send"]')!.disabled,
        ).toBe(false),
      )
    })
    expect(ui.host.textContent).not.toContain('请先转换')
    expect(uploads.filter((upload) => upload.purpose === 'conversation-attachment')).toHaveLength(0)
  } finally {
    ui?.dispose()
    workspace.dispose()
  }
})
