// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { readCanvasDocument } from '@image-playground/shared'
import { afterEach, expect, it, vi } from 'vitest'
import { createArtifactDelivery } from '../../../../features/agent/lib/artifactDelivery'
import { artifactBitmap } from '../../../../features/agent/lib/artifactSource'
import { setAgentCanvasSink } from '../../../../features/agent/lib/canvasSink'
import type { AgentToolMessage } from '../../../../features/agent/types'
import { createAgentCanvasSink } from '../../../../features/canvas/lib/agentCanvasSink'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import { CanvasEditor } from '../../../../features/canvas/lib/editor'
import { openLocalNodeCanvas } from '../../../../features/canvas/lib/localNodeCanvas'
import type { NodeCanvasDocument } from '../../../../features/canvas/lib/nodeCanvasDocument'
import { registerNodeCanvasFocus } from '../../../../features/canvas/lib/nodeCanvasFocus'

vi.mock('../../../../features/agent/lib/artifactSource', () => ({
  artifactBitmap: vi.fn(async () => 'data:image/png;base64,AQID'),
}))

const message: AgentToolMessage = {
  kind: 'tool',
  id: 'historical-tool',
  turnId: 'historical-turn',
  toolCallId: 'historical-call',
  toolName: 'generateImage',
  title: '小狗',
  status: 'succeeded',
  artifacts: [
    {
      artifactId: 'agent_historical-task_0',
      taskId: 'historical-task',
      media: 'image',
      outputIndex: 0,
      mime: 'image/png',
    },
  ],
}
const sessions: Array<{
  controller: AbortController
  canvas: NodeCanvasDocument
}> = []
const unregisterFocus: Array<() => void> = []

afterEach(async () => {
  setAgentCanvasSink(null)
  for (const unregister of unregisterFocus.splice(0)) unregister()
  for (const { controller, canvas } of sessions.splice(0)) {
    controller.abort()
    await vi.waitFor(() => expect(canvas.doc.isDestroyed).toBe(true))
  }
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

it('places a missing historical result in the real local Y.Doc once and reuses its artifact ID', async () => {
  vi.stubGlobal('requestAnimationFrame', () => 0)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.stubGlobal(
    'Image',
    class {
      naturalWidth = 64
      naturalHeight = 64
      onload: (() => void) | null = null
      set src(_value: string) {
        queueMicrotask(() => this.onload?.())
      }
    },
  )
  const editor = new CanvasEditor(new CanvasDoc())
  editor.doc.setViewport(800, 600)
  const controller = new AbortController()
  const ready = openLocalNodeCanvas(crypto.randomUUID(), editor, controller.signal)
  const canvas = (await ready)!
  sessions.push({ controller, canvas })
  const sink = createAgentCanvasSink(editor, ready)
  setAgentCanvasSink(sink)
  const focused: string[][] = []
  unregisterFocus.push(
    registerNodeCanvasFocus(editor, (ids) => {
      const present = ids.filter((id) => canvas.doc.getMap('nodes').has(id))
      if (!present.length) return false
      focused.push(present)
      return true
    }),
  )
  const changed = vi.fn()
  const delivery = createArtifactDelivery(changed)

  // Loading the conversation must not download or resurrect any historical result.
  await delivery.restore([message])
  expect(artifactBitmap).not.toHaveBeenCalled()
  expect(readCanvasDocument(canvas.doc).nodes).toEqual([])

  await delivery.placeOnCanvas(message)
  expect(changed).toHaveBeenLastCalledWith(message.id, 'placed')
  const nodes = readCanvasDocument(canvas.doc).nodes
  expect(nodes).toHaveLength(1)
  expect(nodes[0]).toMatchObject({ id: 'agent_historical-task_0', type: 'image' })
  expect(editor.getElement(nodes[0]!.id)).toMatchObject({ type: 'image' })
  expect(sink.has(nodes[0]!.id)).toBe(true)
  expect(artifactBitmap).toHaveBeenCalledTimes(1)
  expect(focused).toEqual([['agent_historical-task_0']])

  await delivery.placeOnCanvas(message)
  expect(readCanvasDocument(canvas.doc).nodes).toEqual(nodes)
  expect(artifactBitmap).toHaveBeenCalledTimes(1)
  expect(focused).toEqual([['agent_historical-task_0'], ['agent_historical-task_0']])
})
