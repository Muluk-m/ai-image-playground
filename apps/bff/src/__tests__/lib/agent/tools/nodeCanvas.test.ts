import { afterAll, beforeAll, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import {
  canvasNodeSourceData,
  canvasOrigin,
  chooseCanvasResult,
  finishCanvasNodeJob,
  insertCanvasNode,
  readCanvasDocument,
  recordCanvasResult,
  setCanvasNodeJob,
} from '@image-playground/shared'
import * as Y from 'yjs'

process.env.DATABASE_URL = await resetTestDatabase('agent_node_canvas_commands')
process.env.OPERATOR_CONFIG_FILE = resolve(
  import.meta.dir,
  '../../../canvas-sync-operator-config.json',
)
const { db, schema, close } = await import('../../../../db/client')
const {
  createNodes,
  updateNodes,
  connectNodes,
  deleteNodes,
  applyScriptPlan,
  arrangeNodes,
  runNodes,
  patchAgentCanvasNode,
} = await import('../../../../lib/agent/tools/nodeCanvas')
const { createAgentImageSource } = await import('../../../../lib/agent/images')
const { accessCanvasDocument } = await import('../../../../lib/canvasSyncStore')
const { agentTurnTools } = await import('../../../../lib/agent/tools')
const { planImageBatch } = await import('../../../../lib/agent/tools/planImageBatch')
const userId = 'node-command-owner'
beforeAll(async () => {
  await db.insert(schema.users).values({
    id: userId,
    username: userId,
    password_hash: 'unused',
    status: 'active',
    created_at: Date.now(),
    updated_at: Date.now(),
  })
})
afterAll(close)
async function fixture() {
  const conversationId = crypto.randomUUID(),
    projectId = crypto.randomUUID()
  const now = Date.now()
  await db.insert(schema.agent_conversations).values({
    id: conversationId,
    user_id: userId,
    title: '命令验收',
    created_at: now,
    updated_at: now,
  })
  await db.insert(schema.canvas_projects).values({
    id: projectId,
    user_id: userId,
    conversation_id: conversationId,
    name: '命令验收',
    document: { version: 1, elements: [] },
    revision: 1,
    receipts: [],
    element_count: 0,
    created_at: now,
    updated_at: now,
  })
  const context = {
    mode: 'image' as const,
    experience: 'canvas' as const,
    conversationId,
    turnId: 'turn',
    deviceId: 'device-test',
    userId,
    canvas: { selectedNodeIds: [], elements: [] },
    images: createAgentImageSource({ references: [], history: [], conversationId, userId }),
  }
  const run = (tool: typeof createNodes, args: unknown) =>
    tool.create(context).execute(crypto.randomUUID(), args, undefined, undefined)
  const graph = async () => {
    const doc = new Y.Doc()
    try {
      Y.applyUpdate(doc, await accessCanvasDocument(userId, projectId))
      return readCanvasDocument(doc)
    } finally {
      doc.destroy()
    }
  }
  return { context, run, graph }
}
it('exposes new tools only for authenticated node canvas and keeps legacy writes out of that turn', async () => {
  const { context } = await fixture()
  const names = agentTurnTools(context).map((tool) => tool.name)
  for (const name of [
    'createNodes',
    'updateNodes',
    'connectNodes',
    'deleteNodes',
    'arrangeNodes',
    'runNodes',
    'applyScriptPlan',
  ])
    expect(names).toContain(name)
  for (const name of ['editCanvasObject', 'arrangeCanvas', 'arrangeTimeline', 'planImageBatch'])
    expect(names).not.toContain(name)
  // 非节点画布是否带 planImageBatch 取决于批次能力开关，这套夹具没开，不在这里断言它出现。
  expect(agentTurnTools({ ...context, experience: 'chat' }).map((tool) => tool.name)).not.toContain(
    'createNodes',
  )
  expect(agentTurnTools({ ...context, canvas: undefined }).map((tool) => tool.name)).not.toContain(
    'createNodes',
  )
})
it('persists creation, editing, legal references, arrangement and deletion without a browser', async () => {
  const { run, graph } = await fixture()
  await run(createNodes, {
    nodes: [
      { id: 'text', type: 'text', text: '清晨' },
      { id: 'image', type: 'image', prompt: '窗边的萌芽' },
      { id: 'video', type: 'video', videoMode: 'first', prompt: '缓慢推镜' },
    ],
  })
  expect((await graph()).nodes).toHaveLength(3)
  await run(connectNodes, {
    edges: [
      { source: 'text', target: 'image' },
      { source: 'image', target: 'video' },
    ],
  })
  await run(updateNodes, { nodes: [{ id: 'text', text: '第二幕', x: 50 }] })
  await run(arrangeNodes, { nodeIds: ['text', 'image', 'video'], columns: 3 })
  const saved = await graph()
  expect(saved.edges).toHaveLength(2)
  expect(saved.nodes.find((node) => node.id === 'text')?.data).toMatchObject({ text: '第二幕' })
  expect(saved.nodes.find((node) => node.id === 'video')?.data).toMatchObject({
    meta: { nodeVideoMode: 'first', nodePrompt: '缓慢推镜' },
  })
  await run(deleteNodes, { nodeIds: ['image'] })
  expect((await graph()).nodes).toHaveLength(2)
  expect((await graph()).edges).toHaveLength(0)
})
it('rolls back the whole batch for an implicit video mode or unsupported edge', async () => {
  const { run, graph } = await fixture()
  await expect(
    run(createNodes, {
      nodes: [
        { id: 'text', type: 'text' },
        { id: 'video', type: 'video' },
      ],
    }),
  ).rejects.toThrow('videoMode')
  expect((await graph()).nodes).toHaveLength(0)
  await run(createNodes, {
    nodes: [
      { id: 'text', type: 'text' },
      { id: 'video', type: 'video', videoMode: 'text' },
      { id: 'image', type: 'image' },
    ],
  })
  await expect(
    run(connectNodes, {
      edges: [
        { source: 'text', target: 'video' },
        { source: 'video', target: 'text' },
      ],
    }),
  ).rejects.toThrow('不支持')
  expect((await graph()).edges).toHaveLength(0)
  await expect(
    run(updateNodes, { nodes: [{ id: 'video', prompt: '没有明确模式' }] }),
  ).rejects.toThrow('videoMode')
})

it('does not persist pending jobs or selected candidates into authoring data while editing', () => {
  const doc = new Y.Doc()
  const origin = canvasOrigin('agent', 'projection-test')
  insertCanvasNode(
    doc,
    {
      id: 'image',
      type: 'image',
      x: 0,
      y: 0,
      width: 320,
      height: 240,
      data: { mediaId: 'original', meta: { nodeKind: 'image' } },
    },
    origin,
  )
  recordCanvasResult(
    doc,
    {
      id: 'candidate',
      nodeId: 'image',
      kind: 'image',
      source: { type: 'media', mediaId: 'candidate-media' },
      createdAt: 1,
    },
    origin,
  )
  chooseCanvasResult(doc, 'image', 'candidate', { data: { mediaId: 'candidate-media' } }, origin)
  setCanvasNodeJob(
    doc,
    {
      id: 'job',
      nodeId: 'image',
      createdAt: 2,
      status: 'loading',
      message: '',
      meta: { nodeGeneration: true, prompt: 'next', clientRequestId: 'request' },
    },
    origin,
  )
  patchAgentCanvasNode(doc, { id: 'image', x: 70 }, origin)
  patchAgentCanvasNode(doc, { id: 'image', prompt: 'edited', name: 'edited name' }, origin)
  finishCanvasNodeJob(doc, 'job', origin)
  expect(canvasNodeSourceData(doc, 'image')).toMatchObject({
    mediaId: 'original',
    name: 'edited name',
    meta: { nodePrompt: 'edited' },
  })
  expect(canvasNodeSourceData(doc, 'image')).not.toHaveProperty('pending')
  expect(readCanvasDocument(doc).nodes[0]).toMatchObject({
    x: 70,
    data: { mediaId: 'candidate-media' },
  })
  expect(readCanvasDocument(doc).nodes[0]?.data).not.toHaveProperty('pending')
  doc.destroy()
})

it('only proposes an authorized batch and never submits or modifies the canvas before confirmation', async () => {
  const { context, run, graph } = await fixture()
  await run(createNodes, { nodes: [{ id: 'image', type: 'image', prompt: '嫩芽' }] })
  const before = await graph()
  const tasks = await db.select({ id: schema.tasks.id }).from(schema.tasks)
  const proposal = await run(runNodes, { nodeIds: ['image'] })
  expect(proposal.details?.canvasRun?.nodeIds).toEqual(['image'])
  expect(proposal.details).not.toHaveProperty('job')
  expect(proposal.details?.canvasRun).not.toHaveProperty('autoRun')
  const auto = await runNodes
    .create({ ...context, autoSubmit: { take: () => true } })
    .execute('auto', { nodeIds: ['image'] }, undefined, undefined)
  expect(auto.details?.canvasRun?.autoRun).toBe(true)
  const exhausted = await runNodes
    .create({ ...context, autoSubmit: { take: () => false } })
    .execute('exhausted', { nodeIds: ['image'] }, undefined, undefined)
  expect(exhausted.details?.canvasRun).not.toHaveProperty('autoRun')
  expect(await graph()).toEqual(before)
  expect(await db.select({ id: schema.tasks.id }).from(schema.tasks)).toEqual(tasks)
  await expect(run(runNodes, { nodeIds: ['missing'] })).rejects.toThrow('不存在')
  await expect(
    runNodes
      .create({ ...context, conversationId: 'another-conversation' })
      .execute('foreign', { nodeIds: ['image'] }, undefined, undefined),
  ).rejects.toThrow('云端项目')
  await expect(
    runNodes
      .create({ ...context, experience: 'chat' })
      .execute('chat', { nodeIds: ['image'] }, undefined, undefined),
  ).rejects.toThrow('云端节点画布')
})

it('turns a chat attachment into an image node the user does not have to drag in', async () => {
  const { context, run, graph } = await fixture()
  const now = Date.now()
  const mediaId = crypto.randomUUID()
  await db.insert(schema.media_objects).values({
    id: mediaId,
    user_id: userId,
    sha256: 'b'.repeat(64),
    bytes: 1024,
    content_type: 'image/png',
    status: 'ready',
    reserved_bytes: 1024,
    staging_key: `staging/${mediaId}`,
    object_key: `media/${mediaId}`,
    width: 800,
    height: 600,
    expires_at: now + 86_400_000,
    created_at: now,
    updated_at: now,
  })
  const attached = {
    ...context,
    images: createAgentImageSource({
      references: [{ imageId: 'file_bathtub', mediaId, name: '浴缸正面' }],
      history: [],
      conversationId: context.conversationId,
      userId,
    }),
  }
  const runAttached = (args: unknown) =>
    createNodes.create(attached).execute(crypto.randomUUID(), args, undefined, undefined)
  await runAttached({
    nodes: [
      { id: 'bathtub', type: 'image', imageId: 'file_bathtub' },
      { id: 'scene', type: 'image', prompt: '把浴缸放进海景浴室' },
    ],
  })
  const saved = await graph()
  expect(saved.nodes.find((node) => node.id === 'bathtub')?.data).toMatchObject({
    mediaId,
    name: '浴缸正面',
    meta: { nodeKind: 'image' },
  })
  expect(saved.nodes.find((node) => node.id === 'scene')?.data).not.toHaveProperty('mediaId')
  await expect(
    runAttached({ nodes: [{ id: 'ghost', type: 'image', imageId: 'file_missing' }] }),
  ).rejects.toThrow('file_bathtub')
  await expect(
    run(createNodes, { nodes: [{ id: 'note', type: 'text', imageId: 'file_bathtub' }] }),
  ).rejects.toThrow('只有 image 节点可以设置 imageId')
})

it('routes node canvas generation away from generic batch plans', async () => {
  const { context } = await fixture()
  const items = [{ key: 'a', imageIds: ['image-a'], prompt: '换背景', dependencies: [] }]
  await expect(
    planImageBatch
      .create(context)
      .execute('batch', { title: '批量', rule: '统一', items }, undefined, undefined),
  ).rejects.toThrow('runNodes')
  await expect(
    planImageBatch.create(context).execute(
      'batch-generation',
      {
        title: '批量',
        rule: '统一',
        items: [
          ...items.map((item) => ({ ...item, kind: 'analysis' as const })),
          { ...items[0]!, key: 'b', kind: 'generation' as const },
        ],
      },
      undefined,
      undefined,
    ),
  ).rejects.toThrow('runNodes')
})

it('splits a script into imageless assets and a storyboard, and appends the next episode', async () => {
  const { run, graph } = await fixture()
  await run(createNodes, { nodes: [{ id: 'script', type: 'text', text: '## 第 1 集\n窗台。\n' }] })
  const tasks = await db.select({ id: schema.tasks.id }).from(schema.tasks)
  await run(applyScriptPlan, {
    scriptNodeId: 'script',
    storyboardId: 'board',
    assets: [
      { id: 'lin', kind: 'person', name: '林夏', description: '插画师' },
      { id: 'sill', kind: 'location', name: '窗台', description: '朝东窄窗' },
    ],
    shots: [
      {
        id: 'shot-1',
        description: '林夏蹲在窗台前',
        lookIds: ['lin'],
        locationId: 'sill',
        durationSeconds: 5,
      },
    ],
    episode: { number: 2, text: '第二天，新叶又展开一片。' },
  })
  const document = await graph()
  const script = document.nodes.find((node) => node.id === 'script')
  const board = document.nodes.find((node) => node.id === 'board')
  const lin = document.nodes.find((node) => node.id === 'lin')
  expect(script?.type).toBe('text')
  if (script?.type === 'text') expect(script.data.text).toContain('## 第 2 集')
  if (script?.type === 'text') expect(script.data.text).toContain('## 第 1 集')
  expect(board?.type).toBe('storyboard')
  if (board?.type === 'storyboard')
    expect(board.data.shots.map((shot) => shot.id)).toEqual(['shot-1'])
  expect(lin?.type).toBe('image')
  if (lin?.type === 'image') {
    expect(lin.data.meta).toMatchObject({ nodeKind: 'asset', assetKind: 'person' })
    expect(lin.data).not.toHaveProperty('fileId')
  }
  expect(document.edges).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ source: 'script', target: 'board' }),
      expect.objectContaining({ source: 'lin', target: 'board' }),
      expect.objectContaining({ source: 'sill', target: 'board' }),
    ]),
  )
  expect(await db.select({ id: schema.tasks.id }).from(schema.tasks)).toEqual(tasks)
  await expect(
    run(applyScriptPlan, {
      scriptNodeId: 'script',
      storyboardId: 'board-2',
      assets: [],
      shots: [{ id: 'shot-2', description: '重复的一集', lookIds: ['lin'] }],
      episode: { number: 2, text: '再写一次' },
    }),
  ).rejects.toThrow('board')
  expect((await graph()).nodes.some((node) => node.id === 'board-2')).toBe(false)
})
