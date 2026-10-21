import {
  canvasOrigin,
  connectCanvasNodes,
  createCanvasGroup,
  insertCanvasNode,
  moveCanvasNodes,
  readCanvasDocument,
  stageExecutionBinding,
  updateCanvasNode,
  VIDEO_MODEL_SUPPORT,
} from '@image-playground/shared'
import { expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import {
  buildNodeBatch,
  executeNodeBatch,
  type NodeBatchInput,
  stageAuthorizedImageInputs,
} from '../../../../features/canvas/lib/nodeBatch'
import { INITIAL_VIDEO_DRAFT } from '../../../../features/video/store'
import { useStore } from '../../../../store'

const origin = canvasOrigin('user', 'test')
function setup() {
  const doc = new Y.Doc()
  for (const id of ['b', 'a'])
    insertCanvasNode(
      doc,
      {
        id,
        type: 'image',
        x: 0,
        y: 0,
        width: 300,
        height: 200,
        data: { meta: { nodeKind: 'image', nodePrompt: `prompt ${id}` } },
      },
      origin,
    )
  connectCanvasNodes(doc, { source: 'a', target: 'b' }, origin)
  const input = (): NodeBatchInput => ({
    snapshot: readCanvasDocument(doc),
    ids: ['a', 'b'],
    document: doc,
    files: {},
    settings: useStore.getState().settings,
    params: { ...useStore.getState().params, n: 2 },
    videoDraft: INITIAL_VIDEO_DRAFT,
    options: [],
    guard: ({ quantity }) => ({
      blocked: false,
      availableCredits: 1000,
      estimatedCredits: quantity * 3,
    }),
  })
  return { doc, input }
}
it('quotes exactly the executable group members and sorts downstream after its input', () => {
  const { doc, input } = setup()
  insertCanvasNode(
    doc,
    {
      id: 'note',
      type: 'text',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      data: { text: 'context', fontSize: 16, fill: '#fff' },
    },
    origin,
  )
  createCanvasGroup(doc, 'group', ['a', 'b', 'note'], 'story', origin)
  const plan = buildNodeBatch({ ...input(), ids: ['group'] })
  expect(plan.error).toBeUndefined()
  expect(plan.jobs.map((job) => job.id)).toEqual(['a', 'b'])
  expect(plan.jobs.map((job) => job.quantity)).toEqual([2, 2])
  expect(plan.credits).toBe(12)
  expect(plan.jobs[1]!.dependencies).toEqual(['a'])
})
it('keeps geometry and generated cache changes out of confirmation identity, but invalidates edited prompts and prices', () => {
  const { doc, input } = setup(),
    before = buildNodeBatch(input())
  moveCanvasNodes(doc, [{ id: 'a', x: 200, y: 100 }], origin)
  const node = readCanvasDocument(doc).nodes.find((node) => node.id === 'a')!
  updateCanvasNode(
    doc,
    'a',
    { data: { ...node.data, name: 'a generated name', fileId: 'new-cache' } },
    origin,
  )
  expect(buildNodeBatch(input()).signature).toBe(before.signature)
  expect(
    buildNodeBatch({
      ...input(),
      guard: () => ({ blocked: false, availableCredits: 1000, estimatedCredits: 99 }),
    }).signature,
  ).not.toBe(before.signature)
  updateCanvasNode(doc, 'a', { data: { meta: { nodePrompt: 'changed' } } }, origin)
  expect(buildNodeBatch(input()).signature).not.toBe(before.signature)
})
it('rejects cycles and unavailable external references before creating any jobs', () => {
  const { doc, input } = setup()
  expect(buildNodeBatch({ ...input(), ids: ['b'] }).error).toBe('media')
  connectCanvasNodes(doc, { source: 'b', target: 'a' }, origin)
  expect(buildNodeBatch(input()).error).toBe('cycle')
})
it('quotes videos from the same mode and clamped draft as the node composer', () => {
  const { doc, input } = setup(),
    support = VIDEO_MODEL_SUPPORT['grok-imagine-video']!
  updateCanvasNode(
    doc,
    'b',
    {
      data: {
        meta: {
          nodeKind: 'video',
          nodePrompt: 'walk',
          nodeVideoMode: 'first',
          nodeVideoDraft: JSON.stringify({
            model: 'grok-imagine-video',
            duration: 5,
            resolution: '720p',
            aspectRatio: '16:9',
          }),
        },
      },
    },
    origin,
  )
  const plan = buildNodeBatch({
    ...input(),
    options: [{ modelId: 'grok-imagine-video', channelId: 'test', label: 'Grok', support }],
  })
  expect(plan.error).toBeUndefined()
  expect(plan.jobs[1]).toMatchObject({
    kind: 'video',
    quantity: 5,
    draft: { duration: 5 },
    roles: { a: 'first' },
    dependencies: ['a'],
  })
})
it('ignores an incomplete video draft and narrows quality to the node mode', () => {
  const { doc, input } = setup()
  const support = VIDEO_MODEL_SUPPORT['grok-imagine-video']!
  const options = [{ modelId: 'grok-imagine-video', channelId: 'test', label: 'Grok', support }]
  const workbench = {
    model: 'grok-imagine-video',
    duration: 8 as const,
    resolution: '1080p' as const,
    aspectRatio: '16:9' as const,
  }
  updateCanvasNode(
    doc,
    'b',
    {
      data: {
        meta: {
          nodeKind: 'video',
          nodePrompt: 'walk',
          nodeVideoDraft: JSON.stringify({ model: 'grok-imagine-video', duration: 15 }),
        },
      },
    },
    origin,
  )
  const fallback = buildNodeBatch({ ...input(), videoDraft: workbench, options })
  expect(fallback.jobs.find((job) => job.id === 'b')).toMatchObject({
    model: 'grok-imagine-video',
    quantity: 8,
    unitMultiplier: 1,
    draft: { duration: 8, resolution: '720p', aspectRatio: '16:9' },
  })
  updateCanvasNode(
    doc,
    'b',
    {
      data: {
        meta: {
          nodeKind: 'video',
          nodePrompt: 'walk',
          nodeVideoMode: 'text',
          nodeVideoDraft: JSON.stringify({ ...workbench }),
        },
      },
    },
    origin,
  )
  expect(
    buildNodeBatch({ ...input(), videoDraft: workbench, options }).jobs.find(
      (job) => job.id === 'b',
    ),
  ).toMatchObject({
    quantity: 8,
    unitMultiplier: 1.6,
    draft: { resolution: '1080p' },
  })
})
it('waits for the dependency result and does not recheck full-batch balance after spending part of it', async () => {
  const { input } = setup(),
    plan = buildNodeBatch(input()),
    started: string[] = []
  let release!: () => void
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  const promise = executeNodeBatch(plan, {
    signal: new AbortController().signal,
    current: () => ({ ...plan, blocked: started.length > 0 }),
    progress: () => {},
    submit: async (job) => {
      started.push(job.id)
      if (job.id === 'a') await wait
    },
  })
  expect(started).toEqual(['a'])
  release()
  await promise
  expect(started).toEqual(['a', 'b'])
})
it('cancelled or stale confirmation submits nothing, and a failed dependency stops downstream', async () => {
  const { input } = setup(),
    plan = buildNodeBatch(input()),
    submit = vi.fn(async () => {}),
    controller = new AbortController()
  controller.abort()
  const control = { signal: controller.signal, current: () => plan, progress: () => {}, submit }
  await expect(executeNodeBatch(plan, control)).rejects.toMatchObject({ code: 'cancelled' })
  expect(submit).not.toHaveBeenCalled()
  await expect(
    executeNodeBatch(plan, {
      ...control,
      signal: new AbortController().signal,
      current: () => ({ ...plan, signature: 'changed' }),
    }),
  ).rejects.toMatchObject({ code: 'changed' })
  expect(submit).not.toHaveBeenCalled()
  submit.mockRejectedValueOnce(new Error('upstream failed'))
  await expect(
    executeNodeBatch(plan, { ...control, signal: new AbortController().signal }),
  ).rejects.toThrow('upstream failed')
  expect(submit).toHaveBeenCalledTimes(1)
})

it('sums per-request rounded quotes and rejects an insufficient aggregate balance', () => {
  const { input } = setup()
  const rounded = buildNodeBatch({
    ...input(),
    guard: ({ quantity }) => ({
      blocked: false,
      estimatedCredits: Math.ceil(quantity * 1.6),
      availableCredits: 100,
    }),
  })
  expect(rounded.credits).toBe(8)
  const insufficient = buildNodeBatch({
    ...input(),
    guard: () => ({
      blocked: false,
      estimatedCredits: 60,
      availableCredits: 100,
    }),
  })
  expect(insufficient.credits).toBe(120)
  expect(insufficient.error).toBe('balance')
  expect(
    buildNodeBatch({ ...input(), guard: () => ({ blocked: false, estimatedCredits: 1 }) }).error,
  ).toBe('balance')
})
it('does not turn a static imported video into a generation request', () => {
  const { doc, input } = setup()
  insertCanvasNode(
    doc,
    {
      id: 'imported',
      type: 'video',
      x: 0,
      y: 0,
      width: 300,
      height: 200,
      data: { video: { taskId: 'original', outputIndex: 0 }, meta: { nodeKind: 'video' } },
    },
    origin,
  )
  expect(
    buildNodeBatch({ ...input(), ids: ['a', 'b', 'imported'] }).jobs.map((job) => job.id),
  ).toEqual(['a', 'b'])
})
it('deduplicates existing image files while keeping each generated dependency as its own slot', () => {
  const { doc, input } = setup()
  for (let i = 0; i < 20; i++) {
    const id = `same-${i}`
    insertCanvasNode(
      doc,
      { id, type: 'image', x: 0, y: 0, width: 100, height: 100, data: { fileId: 'same' } },
      origin,
    )
    connectCanvasNodes(doc, { source: id, target: 'b' }, origin)
  }
  expect(
    buildNodeBatch({ ...input(), files: { same: 'data:image/png;base64,AA==' } }).error,
  ).toBeUndefined()
})

it('keeps both generating copies as video references even when their old files match', () => {
  const { doc, input } = setup()
  for (const id of ['a', 'b'])
    updateCanvasNode(
      doc,
      id,
      { data: { fileId: 'old', meta: { nodeKind: 'image', nodePrompt: id } } },
      origin,
    )
  insertCanvasNode(
    doc,
    {
      id: 'video',
      type: 'video',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      data: { meta: { nodeKind: 'video', nodePrompt: 'move', nodeVideoMode: 'reference' } },
    },
    origin,
  )
  connectCanvasNodes(doc, { source: 'a', target: 'video' }, origin)
  connectCanvasNodes(doc, { source: 'b', target: 'video' }, origin)
  const args = () => ({
    ...input(),
    ids: ['a', 'b', 'video'],
    files: { old: 'data:image/png;base64,AA==' },
    options: [
      {
        modelId: 'grok-imagine-video',
        channelId: 'fixture',
        label: 'Grok',
        support: VIDEO_MODEL_SUPPORT['grok-imagine-video']!,
      },
    ],
  })
  const before = buildNodeBatch(args())
  expect(before.jobs.find((job) => job.id === 'video')?.dependencies).toEqual(['a', 'b'])
  updateCanvasNode(
    doc,
    'a',
    { data: { fileId: 'new', meta: { nodeKind: 'image', nodePrompt: 'a' } } },
    origin,
  )
  expect(buildNodeBatch(args()).signature).toBe(before.signature)
})

it('runs a promptless asset with its description as the prompt, the same prompt the stage binding froze', () => {
  const { doc, input } = setup()
  updateCanvasNode(
    doc,
    'a',
    {
      data: {
        name: '林夏',
        meta: { nodeKind: 'asset', assetKind: 'person', assetDescription: '插画师' },
      },
    },
    origin,
  )
  updateCanvasNode(
    doc,
    'b',
    {
      data: {
        name: '窗台',
        meta: { nodeKind: 'asset', assetKind: 'location', assetDescription: ' ' },
      },
    },
    origin,
  )
  const plan = buildNodeBatch(input())
  expect(plan.error).toBeUndefined()
  // 没有描述的素材仍然不单独生成。
  expect(plan.jobs.map((job) => job.id)).toEqual(['a'])
  const snapshot = readCanvasDocument(doc)
  const binding = stageExecutionBinding({
    node: snapshot.nodes.find((node) => node.id === 'a')!,
    nodes: snapshot.nodes,
    edges: snapshot.edges,
    authorizedIds: new Set(['a']),
  })
  expect(plan.jobs[0]!.prompt).toBe('林夏：插画师')
  expect(plan.jobs[0]!.prompt).toBe(binding.prompt)
})

it('keeps a generating asset as an image input for a downstream reference video', () => {
  const { doc, input } = setup()
  updateCanvasNode(
    doc,
    'a',
    {
      data: {
        fileId: 'old',
        name: '芽芽',
        meta: { nodeKind: 'asset', assetKind: 'person', nodePrompt: 'portrait' },
      },
    },
    origin,
  )
  updateCanvasNode(
    doc,
    'b',
    { data: { meta: { nodeKind: 'video', nodeVideoMode: 'reference', nodePrompt: 'walk' } } },
    origin,
  )
  const plan = buildNodeBatch({
    ...input(),
    files: { old: 'data:image/png;base64,AA==' },
    options: [
      {
        modelId: 'grok-imagine-video',
        channelId: 'fixture',
        label: 'Grok',
        support: VIDEO_MODEL_SUPPORT['grok-imagine-video']!,
      },
    ],
  })
  expect(plan.error).toBeUndefined()
  expect(plan.jobs[1]?.refs.find((ref) => ref.id === 'a')).toMatchObject({
    kind: 'image',
    fileId: 'old',
  })
  expect(plan.jobs[1]?.roles).toEqual({ a: 'reference' })
})
it('quotes one image for each storyboard frame or contact sheet regardless of the workbench batch size', () => {
  const { doc, input } = setup()
  for (const [id, storyboardRole] of [
    ['a', 'grid'],
    ['b', 'frame'],
  ]) {
    const node = readCanvasDocument(doc).nodes.find((node) => node.id === id)!
    if (node.type === 'image')
      updateCanvasNode(
        doc,
        node.id,
        { data: { ...node.data, meta: { ...node.data.meta, storyboardRole } } },
        origin,
      )
  }
  const plan = buildNodeBatch(input())
  expect(plan.jobs.map((job) => job.quantity)).toEqual([1, 1])
  expect(plan.credits).toBe(6)
})

it('counts each in-stage image, dedupes external files, and leaves browser-only uploads out', () => {
  const refs = [
    { id: 'a', kind: 'image' as const, label: 'a', fileId: 'same' },
    { id: 'b', kind: 'image' as const, label: 'b', fileId: 'same' },
    { id: 'upload', kind: 'image' as const, label: 'upload', fileId: 'temp-upload' },
  ]
  const files = { same: 'data:a', 'temp-upload': 'data:upload', draft: 'data:draft' }
  expect(stageAuthorizedImageInputs(refs, files, new Set(['a', 'b']), {})).toEqual([
    'data:a',
    'data:a',
    'data:upload',
  ])
  expect(stageAuthorizedImageInputs(refs, files, new Set(), {})).toEqual(['data:a', 'data:upload'])
  expect(
    stageAuthorizedImageInputs(
      [...refs, { id: 'draft', kind: 'image', label: 'draft', fileId: 'draft' }],
      files,
      new Set(['a', 'b']),
      { draft: 'data:draft' },
    ),
  ).toEqual(['data:a', 'data:a', 'data:upload'])
})
