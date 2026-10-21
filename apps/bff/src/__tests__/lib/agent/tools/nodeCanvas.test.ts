import { afterAll, beforeAll, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import {
  canvasMainResult,
  canvasNodeSourceData,
  canvasOrigin,
  chooseCanvasResult,
  finishCanvasNodeJob,
  insertCanvasNode,
  readCanvasDocument,
  recordCanvasResult,
  setCanvasNodeJob,
  storyboardFingerprint,
} from '@image-playground/shared'
import { eq } from 'drizzle-orm'
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
  importCanvasImage,
  runNodes,
  runStoryboardFrames,
  patchAgentCanvasNode,
} = await import('../../../../lib/agent/tools/nodeCanvas')
const { createAgentImageSource } = await import('../../../../lib/agent/images')
const { accessCanvasDocument } = await import('../../../../lib/canvasSyncStore')
const { confirmStageAuthorization, preflightStageAuthorization, readStageAuthorization } =
  await import('../../../../lib/agent/stage-authorizations')
const { agentTurnTools } = await import('../../../../lib/agent/tools')
const { planImageBatch } = await import('../../../../lib/agent/tools/planImageBatch')
const { draftQueueTask } = await import('../../../../lib/agent/tools/queueTask')
// These modules bind DATABASE_URL at load time, so static imports cannot precede the fixture setup.
const { proposeBatchGeneration } = await import(
  '../../../../lib/agent/tools/proposeBatchGeneration'
)
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
  return { context, run, graph, projectId }
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
    'importCanvasImage',
    'runStoryboardFrames',
  ])
    expect(names).toContain(name)
  for (const name of [
    'editCanvasObject',
    'arrangeCanvas',
    'arrangeTimeline',
    'generateImage',
    'editImage',
    'generateVideo',
    'proposeBatchGeneration',
    'planImageBatch',
  ])
    expect(names).not.toContain(name)
  // 非节点画布是否带 planImageBatch 取决于批次能力开关，这套夹具没开，不在这里断言它出现。
  expect(agentTurnTools({ ...context, experience: 'chat' }).map((tool) => tool.name)).not.toContain(
    'createNodes',
  )
  expect(agentTurnTools({ ...context, experience: 'chat' }).map((tool) => tool.name)).toEqual(
    expect.arrayContaining(['generateImage', 'editImage']),
  )
  expect(agentTurnTools({ ...context, userId: null }).map((tool) => tool.name)).not.toContain(
    'createNodes',
  )
})
it.each([
  { elements: [] },
  undefined,
])('keeps canvas snapshot %j on node generation and rejects ownerless submissions', async (canvas) => {
  const { context, graph } = await fixture()
  const unselected = { ...context, canvas }
  const tools = agentTurnTools(unselected)
  const names = tools.map((tool) => tool.name)
  for (const name of ['createNodes', 'updateNodes', 'runNodes', 'importCanvasImage'])
    expect(names).toContain(name)
  for (const name of ['generateImage', 'editImage', 'generateVideo', 'proposeBatchGeneration'])
    expect(names).not.toContain(name)
  await tools
    .find((tool) => tool.name === 'createNodes')!
    .execute(
      'create-unselected',
      { nodes: [{ id: 'target', type: 'image', prompt: '人物三视图' }] },
      undefined,
      undefined,
    )
  const proposal = await tools
    .find((tool) => tool.name === 'runNodes')!
    .execute('run-unselected', { nodeIds: ['target'] }, undefined, undefined)
  expect(proposal).toMatchObject({ details: { canvasRun: { nodeIds: ['target'] } } })
  const read = await tools
    .find((tool) => tool.name === 'readCanvas')!
    .execute('read-unselected', { scope: 'all' }, undefined, undefined)
  const content = read.content.find((block) => block.type === 'text')
  if (content?.type !== 'text') throw new Error('expected canvas document')
  expect(JSON.parse(content.text).nodes).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: 'target' })]),
  )
  await expect(
    draftQueueTask(
      { ...unselected, autoSubmit: { take: () => true } },
      { toolName: 'generateImage', media: 'image', prompt: '人物三视图' },
      undefined,
    ),
  ).rejects.toThrow('runNodes')
  await expect(
    proposeBatchGeneration
      .create(unselected)
      .execute(
        'batch-unselected',
        { batchId: 'existing-analysis', expectedVersion: 1, items: [] },
        undefined,
        undefined,
      ),
  ).rejects.toThrow('runNodes')
  await expect(
    planImageBatch.create(unselected).execute(
      'plan-unselected',
      {
        title: '人物三视图',
        rule: '逐个生成',
        items: [
          {
            key: 'person',
            imageIds: [],
            kind: 'generation',
            prompt: '人物三视图',
            dependencies: [],
          },
        ],
      },
      undefined,
      undefined,
    ),
  ).rejects.toThrow('runNodes')
  expect((await graph()).nodes.map((node) => node.id)).toEqual(['target'])
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
  const proposal = await run(runNodes, { nodeIds: ['image'], estimatedCredits: 0 })
  expect(proposal.details?.canvasRun?.nodeIds).toEqual(['image'])
  expect(proposal.details?.canvasRun).toMatchObject({ budgetCap: 0, estimatedCredits: 0 })
  const authorizationId = proposal.details?.canvasRun?.authorizationId
  if (!authorizationId) throw new Error('missing authorization')
  const confirmed = await confirmStageAuthorization(userId, authorizationId, [
    { nodeId: 'image', model: 'fixture-image', quantity: 1, unitMultiplier: 1 },
  ])
  const preflight = await preflightStageAuthorization(userId, authorizationId, {
    nodeId: 'image',
    model: 'fixture-image',
    quantity: 1,
    unitMultiplier: 1,
    executionToken: confirmed.executionToken,
    attemptId: 'unbilled',
  })
  expect(preflight.attempts).toHaveLength(1)
  expect(preflight.budgetCap).toBe(0)
  expect(proposal.details).not.toHaveProperty('job')
  expect(proposal.details?.canvasRun).toMatchObject({ direct: true, status: 'pending' })
  expect(proposal.details?.canvasRun).not.toHaveProperty('autoRun')
  const rows = await db
    .select({ id: schema.agent_stage_authorizations.id })
    .from(schema.agent_stage_authorizations)
  expect(rows.length).toBeGreaterThan(0)
  const turnedOff = await runNodes
    .create({ ...context, params: { autoSubmit: false }, autoSubmit: { take: () => true } })
    .execute('manual', { nodeIds: ['image'], autoSubmit: true } as never, undefined, undefined)
  expect(turnedOff.details?.canvasRun).toMatchObject({ direct: false, status: 'pending' })
  const explicit = await runNodes
    .create({ ...context, params: { autoSubmit: true } })
    .execute('direct', { nodeIds: ['image'] }, undefined, undefined)
  expect(explicit.details?.canvasRun).toMatchObject({ direct: true, status: 'pending' })
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

it('quotes image nodes with the workbench image count, not the omitted turn n', async () => {
  const { context } = await fixture()
  await createNodes
    .create(context)
    .execute(
      'create',
      { nodes: [{ id: 'image', type: 'image', prompt: '嫩芽' }] },
      undefined,
      undefined,
    )
  const quoted = await runNodes
    .create({ ...context, params: { canvasImageModel: 'workbench-image', canvasImageCount: 4 } })
    .execute('count', { nodeIds: ['image'] }, undefined, undefined)
  expect(quoted.details?.canvasRun?.specs).toEqual([
    { nodeId: 'image', model: 'workbench-image', quantity: 4, unitMultiplier: 1 },
  ])
})

it('uses the workbench image model and adopts a real model when the unbilled placeholder is empty', async () => {
  const { context } = await fixture()
  await createNodes
    .create(context)
    .execute(
      'create',
      { nodes: [{ id: 'image', type: 'image', prompt: '嫩芽' }] },
      undefined,
      undefined,
    )
  const aligned = await runNodes
    .create({ ...context, params: { canvasImageModel: 'workbench-image' } })
    .execute('aligned', { nodeIds: ['image'] }, undefined, undefined)
  const alignedId = aligned.details?.canvasRun?.authorizationId
  if (!alignedId) throw new Error('missing authorization')
  const confirmed = await confirmStageAuthorization(userId, alignedId)
  expect(confirmed.authorization.charges).toMatchObject([
    { nodeId: 'image', model: 'workbench-image', quantity: 1, unitMultiplier: 1, credits: 0 },
  ])
  const preflight = await preflightStageAuthorization(userId, alignedId, {
    nodeId: 'image',
    model: 'workbench-image',
    quantity: 1,
    unitMultiplier: 1,
    executionToken: confirmed.executionToken,
    attemptId: 'workbench',
  })
  expect(preflight.attempts).toHaveLength(1)
  await expect(
    preflightStageAuthorization(userId, alignedId, {
      nodeId: 'image',
      model: 'other-image',
      quantity: 1,
      unitMultiplier: 1,
      executionToken: confirmed.executionToken,
      attemptId: 'other',
    }),
  ).rejects.toThrow('stage_authorization_scope')
  const placeholder = await runNodes
    .create(context)
    .execute('placeholder', { nodeIds: ['image'] }, undefined, undefined)
  const placeholderId = placeholder.details?.canvasRun?.authorizationId
  if (!placeholderId) throw new Error('missing placeholder')
  const open = await confirmStageAuthorization(userId, placeholderId)
  expect(open.authorization.charges?.[0]?.model).toBe('')
  const adopted = await preflightStageAuthorization(userId, placeholderId, {
    nodeId: 'image',
    model: 'fixture-image',
    quantity: 1,
    unitMultiplier: 1,
    executionToken: open.executionToken,
    attemptId: 'adopted',
  })
  expect(adopted.charges).toMatchObject([{ nodeId: 'image', model: 'fixture-image' }])
  expect(adopted.attempts).toHaveLength(1)
})

it('authorizes an asset node that has a prompt and rejects a promptless asset', async () => {
  const { context, projectId } = await fixture()
  await accessCanvasDocument(userId, projectId, async (current) => {
    const doc = new Y.Doc()
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(current))
    const vector = Y.encodeStateVector(doc)
    const origin = canvasOrigin('system', 'fixture')
    insertCanvasNode(
      doc,
      {
        id: 'person',
        type: 'image',
        x: 0,
        y: 0,
        width: 320,
        height: 240,
        data: {
          name: '林夏',
          meta: { nodeKind: 'asset', assetKind: 'person', nodePrompt: '三视图' },
        },
      },
      origin,
    )
    const update = Y.encodeStateAsUpdate(doc, vector)
    doc.destroy()
    return update
  })
  const proposal = await runNodes
    .create(context)
    .execute('assets', { nodeIds: ['person'] }, undefined, undefined)
  expect(proposal.details?.canvasRun?.nodeIds).toEqual(['person'])
  expect(proposal.details?.canvasRun).toMatchObject({ budgetCap: 0, estimatedCredits: 0 })
  const authorizationId = proposal.details?.canvasRun?.authorizationId
  if (!authorizationId) throw new Error('missing authorization')
  const confirmed = await confirmStageAuthorization(userId, authorizationId, [
    { nodeId: 'person', model: 'fixture-image', quantity: 1, unitMultiplier: 1 },
  ])
  const preflight = await preflightStageAuthorization(userId, authorizationId, {
    nodeId: 'person',
    model: 'fixture-image',
    quantity: 1,
    unitMultiplier: 1,
    executionToken: confirmed.executionToken,
    attemptId: 'asset-sheet',
  })
  expect(preflight.attempts).toHaveLength(1)
  await accessCanvasDocument(userId, projectId, async (current) => {
    const doc = new Y.Doc()
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(current))
    const vector = Y.encodeStateVector(doc)
    const origin = canvasOrigin('system', 'fixture')
    insertCanvasNode(
      doc,
      {
        id: 'blank',
        type: 'image',
        x: 400,
        y: 0,
        width: 320,
        height: 240,
        data: { name: '空素材', meta: { nodeKind: 'asset', assetKind: 'location' } },
      },
      origin,
    )
    const update = Y.encodeStateAsUpdate(doc, vector)
    doc.destroy()
    return update
  })
  await expect(
    runNodes.create(context).execute('blank', { nodeIds: ['blank'] }, undefined, undefined),
  ).rejects.toThrow('没有提示词')
})

it('runs a script-plan asset with its description as the prompt and still rejects a bare one', async () => {
  const { context, run } = await fixture()
  await run(createNodes, { nodes: [{ id: 'script', type: 'text', text: '## 第 1 集\n窗台。\n' }] })
  await run(applyScriptPlan, {
    scriptNodeId: 'script',
    storyboardId: 'board',
    assets: [
      { id: 'lin', kind: 'person', name: '林夏', description: '插画师，短发' },
      { id: 'sill', kind: 'location', name: '窗台', description: '  ' },
    ],
    shots: [{ id: 'shot-1', description: '林夏在窗台前', lookIds: ['lin'], locationId: 'sill' }],
  })
  const proposal = await runNodes
    .create(context)
    .execute('assets', { stage: '素材', nodeIds: ['lin'] }, undefined, undefined)
  expect(proposal.details?.canvasRun?.nodeIds).toEqual(['lin'])
  const authorization = await readStageAuthorization(
    userId,
    proposal.details!.canvasRun!.authorizationId,
  )
  // 与原标签页 buildNodeBatch 的提示词同一来源：素材名与描述。
  expect(authorization.bindings).toMatchObject([{ nodeId: 'lin', prompt: '林夏：插画师，短发' }])
  await expect(
    runNodes.create(context).execute('bare', { nodeIds: ['sill'] }, undefined, undefined),
  ).rejects.toThrow('没有提示词')
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

it('rejects ownerless generation even when the turn has an automatic submission allowance', async () => {
  const { context, graph } = await fixture()
  await expect(
    proposeBatchGeneration.create(context).execute(
      'batch',
      {
        batchId: 'existing-analysis',
        expectedVersion: 1,
        items: [],
      },
      undefined,
      undefined,
    ),
  ).rejects.toThrow('runNodes')
  await expect(
    draftQueueTask(
      { ...context, autoSubmit: { take: () => true } },
      { toolName: 'generateImage', media: 'image', prompt: '人物三视图' },
      undefined,
    ),
  ).rejects.toThrow('runNodes')
  expect((await graph()).nodes).toHaveLength(0)
})

it('imports an existing image into the specified asset as its primary candidate without generation', async () => {
  const { context, run, graph, projectId } = await fixture()
  const mediaId = crypto.randomUUID()
  const now = Date.now()
  await db.insert(schema.media_objects).values({
    id: mediaId,
    user_id: userId,
    sha256: mediaId,
    bytes: 12,
    content_type: 'image/png',
    status: 'ready',
    reserved_bytes: 0,
    staging_key: `staging/${mediaId}`,
    object_key: `media/${mediaId}`,
    expires_at: now + 86_400_000,
    created_at: now,
    updated_at: now,
  })
  await accessCanvasDocument(userId, projectId, async (current) => {
    const doc = new Y.Doc()
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(current))
    const vector = Y.encodeStateVector(doc)
    const origin = canvasOrigin('system', 'fixture')
    for (const node of [
      { id: 'source', data: { mediaId, name: '现有三视图' } },
      {
        id: 'asset',
        data: { name: '林夏', meta: { nodeKind: 'asset' as const, assetKind: 'person' as const } },
      },
      { id: 'empty', data: {} },
    ])
      insertCanvasNode(doc, { ...node, type: 'image', x: 0, y: 0, width: 320, height: 240 }, origin)
    const update = Y.encodeStateAsUpdate(doc, vector)
    doc.destroy()
    return update
  })
  const beforeTasks = await db.select({ id: schema.tasks.id }).from(schema.tasks)
  await run(updateNodes, { nodes: [{ id: 'asset', prompt: '人物正面侧面背面三视图' }] })
  const proposal = await run(runNodes, { nodeIds: ['asset'] })
  expect(proposal.details?.canvasRun?.nodeIds).toEqual(['asset'])
  expect((await graph()).nodes.find((node) => node.id === 'asset')?.data).toMatchObject({
    meta: { nodeKind: 'asset', nodePrompt: '人物正面侧面背面三视图' },
  })
  const args = { imageNodeId: 'source', assetNodeId: 'asset', viewLabel: 'sheet' }
  const receipt = await importCanvasImage
    .create(context)
    .execute('import', args, undefined, undefined)
  await importCanvasImage.create(context).execute('import', args, undefined, undefined)
  const doc = new Y.Doc()
  Y.applyUpdate(doc, await accessCanvasDocument(userId, projectId))
  expect(readCanvasDocument(doc).nodes).toHaveLength(3)
  expect(readCanvasDocument(doc).nodes.find((node) => node.id === 'asset')?.data).toMatchObject({
    name: '林夏',
    mediaId,
    meta: { nodeKind: 'asset', assetKind: 'person' },
  })
  expect(canvasMainResult(doc, 'asset')).toMatchObject({
    nodeId: 'asset',
    kind: 'image',
    assetViewLabel: 'sheet',
    adopted: true,
    source: { type: 'media', mediaId },
  })
  expect(doc.getMap('nodeResults').size).toBe(1)
  expect(JSON.stringify(receipt.content)).toContain('没有启动生成任务')
  expect(await db.select({ id: schema.tasks.id }).from(schema.tasks)).toEqual(beforeTasks)
  await expect(
    run(importCanvasImage, { imageNodeId: 'empty', assetNodeId: 'asset' }),
  ).rejects.toThrow('真实图片')
  await expect(
    run(importCanvasImage, { imageNodeId: 'source', assetNodeId: 'empty' }),
  ).rejects.toThrow('素材节点')
  expect((await graph()).nodes).toHaveLength(3)
  doc.destroy()
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

it('names the closest nodes when an id is mistyped and stops a repeated failure loop', async () => {
  const { context, run } = await fixture()
  await run(createNodes, {
    nodes: [
      { id: 'agent_02c5d941-fef5-4e04-b95b-8d9dcf1ece43', type: 'text', name: '人物' },
      { id: 'scene', type: 'text', name: '地点' },
    ],
  })
  await expect(
    run(arrangeNodes, { nodeIds: ['agent_02c5c9ef-4f84-4ace-2a77b9a24aaa'] }),
  ).rejects.toThrow('最接近的现有节点：agent_02c5d941-fef5-4e04-b95b-8d9dcf1ece43（人物）')

  const wrapped = agentTurnTools(context).find((tool) => tool.name === 'arrangeNodes')!
  const attempt = () =>
    wrapped.execute(
      crypto.randomUUID(),
      { nodeIds: ['agent_02c5c9ef-4f84-4ace-2a77b9a24aaa'] },
      undefined,
      undefined,
    )
  for (let i = 0; i < 3; i++) await expect(attempt()).rejects.toThrow('节点不存在')
  await expect(attempt()).rejects.toThrow('已停止重试')
  // 熔断只在这一轮内有效，下一轮重新计数。
  const other = agentTurnTools(context).find((tool) => tool.name === 'arrangeNodes')!
  await expect(
    other.execute(crypto.randomUUID(), { nodeIds: ['scene'] }, undefined, undefined),
  ).resolves.toBeDefined()
})

async function storyboardFixture() {
  const fixed = await fixture()
  const { run, projectId } = fixed
  const mediaId = crypto.randomUUID()
  const now = Date.now()
  await db.insert(schema.media_objects).values({
    id: mediaId,
    user_id: userId,
    sha256: mediaId,
    bytes: 12,
    content_type: 'image/png',
    status: 'ready',
    reserved_bytes: 0,
    staging_key: `staging/${mediaId}`,
    object_key: `media/${mediaId}`,
    expires_at: now + 86_400_000,
    created_at: now,
    updated_at: now,
  })
  await accessCanvasDocument(userId, projectId, async (current) => {
    const doc = new Y.Doc()
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(current))
    const vector = Y.encodeStateVector(doc)
    insertCanvasNode(
      doc,
      {
        id: 'sheet',
        type: 'image',
        x: 0,
        y: 600,
        width: 320,
        height: 240,
        data: { mediaId, name: '现有三视图' },
      },
      canvasOrigin('system', 'fixture'),
    )
    const update = Y.encodeStateAsUpdate(doc, vector)
    doc.destroy()
    return update
  })
  await run(createNodes, { nodes: [{ id: 'script', type: 'text', text: '## 第 1 集\n窗台。\n' }] })
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
        description: '林夏蹲在窗台前。她伸手摸嫩芽',
        lookIds: ['lin'],
        locationId: 'sill',
        durationSeconds: 4,
      },
      { id: 'shot-2', description: '窗台特写，嫩芽在晨光里', lookIds: [], locationId: 'sill' },
    ],
  })
  const stageRows = async () =>
    (
      await db
        .select({ id: schema.agent_stage_authorizations.id })
        .from(schema.agent_stage_authorizations)
    ).length
  return { ...fixed, stageRows }
}

it('blocks the first-frame stage while referenced assets have no image and lays nothing out', async () => {
  const { run, graph, stageRows } = await storyboardFixture()
  const before = await graph()
  const rows = await stageRows()
  const tasks = await db.select({ id: schema.tasks.id }).from(schema.tasks)
  const blocked = run(runStoryboardFrames, { storyboardId: 'board' })
  await expect(blocked).rejects.toThrow('林夏（lin）')
  await expect(run(runStoryboardFrames, { storyboardId: 'board' })).rejects.toThrow('素材阶段')
  // 只重出第 2 镜时只看这一镜的素材：窗台仍缺图。
  await expect(
    run(runStoryboardFrames, { storyboardId: 'board', shotIds: ['shot-2'] }),
  ).rejects.toThrow('窗台（sill）')
  await expect(
    run(runStoryboardFrames, { storyboardId: 'board', shotIds: ['shot-2'] }),
  ).rejects.not.toThrow('林夏')
  expect(await graph()).toEqual(before)
  expect(await stageRows()).toBe(rows)
  expect(await db.select({ id: schema.tasks.id }).from(schema.tasks)).toEqual(tasks)
})

it('tells the agent to start the asset stage in the same turn instead of stopping at missing assets', async () => {
  const { context, run } = await storyboardFixture()
  // 直接出图开着：回执给出能照抄的 runNodes 参数，明说不用等确认、不要停下来转述。
  const direct = run(runStoryboardFrames, { storyboardId: 'board' })
  await expect(direct).rejects.toThrow('先出素材、再出首帧')
  await expect(run(runStoryboardFrames, { storyboardId: 'board' })).rejects.toThrow(
    '现在就在同一轮里调用 runNodes（nodeIds: ["lin","sill"]，stage: "素材"）发起素材阶段，它会直接开跑',
  )
  await expect(run(runStoryboardFrames, { storyboardId: 'board' })).rejects.toThrow(
    '素材批跑完后系统会唤醒你，那时再调用 runStoryboardFrames',
  )
  // 用户关掉了直接出图：同样接着提案，由确认卡确认。
  const manual = runStoryboardFrames
    .create({ ...context, params: { autoSubmit: false } })
    .execute('manual-missing', { storyboardId: 'board' }, undefined, undefined)
  await expect(manual).rejects.toThrow('提出素材阶段授权，由用户在确认卡上确认')
})

it('lays out grid first frames with asset references and finalizes the storyboard only on confirmation', async () => {
  const { context, run, graph } = await storyboardFixture()
  await run(importCanvasImage, { imageNodeId: 'sheet', assetNodeId: 'lin', viewLabel: 'sheet' })
  await run(importCanvasImage, { imageNodeId: 'sheet', assetNodeId: 'sill' })
  const tasks = await db.select({ id: schema.tasks.id }).from(schema.tasks)
  const proposal = await run(runStoryboardFrames, { storyboardId: 'board' })
  const canvasRun = proposal.details?.canvasRun
  expect(canvasRun).toMatchObject({
    stage: '首帧',
    status: 'pending',
    direct: true,
    storyboard: {
      storyboardId: 'board',
      shotCount: 2,
      totalSeconds: 9,
      shots: [
        { id: 'shot-1', durationSeconds: 4, line: '林夏蹲在窗台前。' },
        { id: 'shot-2', durationSeconds: 5, line: '窗台特写，嫩芽在晨光里' },
      ],
    },
  })
  const document = await graph()
  const frames = document.nodes.filter(
    (node) => node.type === 'image' && node.data.meta?.storyboardRole === 'frame',
  )
  const grids = document.nodes.filter(
    (node) => node.type === 'image' && node.data.meta?.storyboardRole === 'grid',
  )
  expect(frames).toHaveLength(2)
  expect(grids).toHaveLength(1)
  // 默认宫格：授权范围是宫格节点，切分后的首帧随宫格结果落位。
  expect(canvasRun?.nodeIds).toEqual([grids[0]!.id])
  const frameOf = (shot: string) =>
    frames.find((node) => node.type === 'image' && node.data.meta?.storyboardShotId === shot)!
  const sources = (target: string) =>
    document.edges
      .filter((edge) => edge.target === target)
      .map((edge) => edge.source)
      .sort()
  expect(sources(frameOf('shot-1').id)).toEqual(['lin', 'sill'])
  expect(sources(frameOf('shot-2').id)).toEqual(['sill'])
  expect(sources(grids[0]!.id)).toEqual(['lin', 'sill'])
  expect(frameOf('shot-1').data).toMatchObject({ name: '第 1 镜 · 首帧' })
  const board = () => graph().then((g) => g.nodes.find((node) => node.id === 'board'))
  const draft = await board()
  expect(draft?.type === 'storyboard' && draft.data.confirmed).toBeFalsy()
  const authorizationId = canvasRun?.authorizationId
  if (!authorizationId || draft?.type !== 'storyboard') throw new Error('missing authorization')
  await confirmStageAuthorization(userId, authorizationId)
  const finalized = await board()
  expect(finalized?.type === 'storyboard' && finalized.data.confirmed).toMatchObject({
    fingerprint: storyboardFingerprint(draft.data.shots),
    quantity: 2,
  })
  expect(await db.select({ id: schema.tasks.id }).from(schema.tasks)).toEqual(tasks)
  // 再次铺首帧复用同一批节点，不另建表或节点。
  await run(runStoryboardFrames, { storyboardId: 'board' })
  expect((await graph()).nodes).toHaveLength(document.nodes.length)
  const manual = await runStoryboardFrames
    .create({ ...context, params: { autoSubmit: false } })
    .execute('manual-frames', { storyboardId: 'board' }, undefined, undefined)
  expect(manual.details?.canvasRun).toMatchObject({ direct: false, stage: '首帧' })
  // 首帧节点不能绕开首帧阶段走通用运行。
  await expect(run(runNodes, { nodeIds: [frameOf('shot-1').id] })).rejects.toThrow(
    'runStoryboardFrames',
  )
})

it('re-runs one shot individually and refuses confirmation after the shot table changed', async () => {
  const { run, graph } = await storyboardFixture()
  await run(importCanvasImage, { imageNodeId: 'sheet', assetNodeId: 'lin' })
  await run(importCanvasImage, { imageNodeId: 'sheet', assetNodeId: 'sill' })
  const single = await run(runStoryboardFrames, { storyboardId: 'board', shotIds: ['shot-2'] })
  const document = await graph()
  const frame = document.nodes.find(
    (node) => node.type === 'image' && node.data.meta?.storyboardShotId === 'shot-2',
  )
  expect(single.details?.canvasRun?.nodeIds).toEqual([frame?.id])
  expect(single.details?.canvasRun?.storyboard).toMatchObject({ shotCount: 2 })
  await expect(
    run(runStoryboardFrames, { storyboardId: 'board', shotIds: ['shot-2'], mode: 'grid' }),
  ).rejects.toThrow('individual')
  await expect(
    run(runStoryboardFrames, { storyboardId: 'board', shotIds: ['shot-9'] }),
  ).rejects.toThrow('shot-9')
  // 认不出的 id 回执列出这张表真正的镜头 id，模型照着改正就能在同一轮重试。
  await expect(
    run(runStoryboardFrames, { storyboardId: 'board', shotIds: ['shot-9'] }),
  ).rejects.toThrow('这张分镜表的镜头是：第 1 镜 shot-1、第 2 镜 shot-2')
  // 把首帧节点 id 当镜头传进来：换成它的镜头，授权范围仍是那一镜的首帧，不会登记空授权。
  const byFrame = await run(runStoryboardFrames, { storyboardId: 'board', shotIds: [frame!.id] })
  expect(byFrame.details?.canvasRun?.nodeIds).toEqual([frame?.id])
  // 手工建的、不是这张表铺出的图片节点不算首帧，照未知镜头拒绝。
  await run(createNodes, { nodes: [{ id: 'manual-frame', type: 'image', prompt: '第 2 镜首帧' }] })
  await expect(
    run(runStoryboardFrames, { storyboardId: 'board', shotIds: ['manual-frame'] }),
  ).rejects.toThrow('不是首帧节点或素材节点 id')
  const authorizationId = single.details?.canvasRun?.authorizationId
  if (!authorizationId) throw new Error('missing authorization')
  await run(applyScriptPlan, {
    scriptNodeId: 'script',
    storyboardId: 'board',
    assets: [],
    shots: [
      { id: 'shot-1', description: '林夏蹲在窗台前', lookIds: ['lin'], locationId: 'sill' },
      { id: 'shot-2', description: '窗台特写，换成黄昏', lookIds: [], locationId: 'sill' },
    ],
  })
  await expect(confirmStageAuthorization(userId, authorizationId)).rejects.toThrow(
    'stage_authorization_stale',
  )
  expect((await readStageAuthorization(userId, authorizationId)).status).toBe('pending')
  const board = (await graph()).nodes.find((node) => node.id === 'board')
  expect(board?.type === 'storyboard' && board.data.confirmed).toBeFalsy()
})

it('replays the same first-frame call with its original authorization after the shot table changed', async () => {
  const { context, run, graph, stageRows } = await storyboardFixture()
  await run(importCanvasImage, { imageNodeId: 'sheet', assetNodeId: 'lin' })
  await run(importCanvasImage, { imageNodeId: 'sheet', assetNodeId: 'sill' })
  const call = () =>
    runStoryboardFrames
      .create(context)
      .execute('frames-replay', { storyboardId: 'board' }, undefined, undefined)
  const first = await call()
  const authorizationId = first.details?.canvasRun?.authorizationId
  expect(authorizationId).toBeTruthy()
  const rows = await stageRows()
  const nodes = (await graph()).nodes.length
  expect((await call()).details?.canvasRun).toMatchObject({
    authorizationId,
    storyboard: { shotCount: 2 },
  })
  await run(applyScriptPlan, {
    scriptNodeId: 'script',
    storyboardId: 'board',
    assets: [],
    shots: [
      { id: 'shot-1', description: '林夏蹲在窗台前', lookIds: ['lin'], locationId: 'sill' },
      { id: 'shot-2', description: '窗台特写，换成黄昏', lookIds: [], locationId: 'sill' },
    ],
  })
  // 镜头表改过之后重放：仍返回首次的授权，不另建授权也不按新表重铺，只是不再附过时的摘要。
  const replayed = await call()
  expect(replayed.details?.canvasRun?.authorizationId).toBe(authorizationId)
  expect(replayed.details?.canvasRun?.storyboard).toBeUndefined()
  // 待确认的旧授权确认必被拒绝：回执要明说过时，不能当普通阶段授权交给用户确认。
  const receipt = JSON.parse((replayed.content[0] as { text: string }).text)
  expect(receipt).toMatchObject({ storyboardStale: true })
  expect(receipt.note).toContain('确认会被拒绝')
  expect(await stageRows()).toBe(rows)
  expect((await graph()).nodes.length).toBe(nodes)
  // 同一调用 ID 换了参数不是重放：画布命令按调用指纹拒绝，不能拿原授权冒充新请求的结果。
  await expect(
    runStoryboardFrames
      .create(context)
      .execute(
        'frames-replay',
        { storyboardId: 'board', shotIds: ['shot-2'] },
        undefined,
        undefined,
      ),
  ).rejects.toThrow('canvas_command_conflict')
  expect(await stageRows()).toBe(rows)
})

it('reports an expired authorization when replaying a first-frame call after its active TTL', async () => {
  const { context, run } = await storyboardFixture()
  await run(importCanvasImage, { imageNodeId: 'sheet', assetNodeId: 'lin' })
  await run(importCanvasImage, { imageNodeId: 'sheet', assetNodeId: 'sill' })
  const call = () =>
    runStoryboardFrames
      .create(context)
      .execute('frames-expire', { storyboardId: 'board' }, undefined, undefined)
  const authorizationId = (await call()).details?.canvasRun?.authorizationId
  if (!authorizationId) throw new Error('missing authorization')
  const { authorization } = await confirmStageAuthorization(userId, authorizationId)
  const table = schema.agent_stage_authorizations
  // 把确认时间和最后更新都推回很久以前，没有在途任务，按 TTL 应当过期。
  await db
    .update(table)
    .set({
      updated_at: 1,
      state: {
        ...authorization,
        audit: authorization.audit.map((event) => ({ ...event, at: 1 })),
      },
    })
    .where(eq(table.id, authorizationId))
  expect((await call()).details?.canvasRun?.status).toBe('expired')
})

it('rolls back laid-out first frames when the stage proposal cannot be registered', async () => {
  const { context, run, graph, stageRows } = await storyboardFixture()
  await run(importCanvasImage, { imageNodeId: 'sheet', assetNodeId: 'lin' })
  await run(importCanvasImage, { imageNodeId: 'sheet', assetNodeId: 'sill' })
  await run(updateNodes, { nodes: [{ id: 'lin', prompt: '林夏三视图' }] })
  // 同一个工具调用 ID 已经登记过别的提案：首帧阶段的提案冲突，铺出的节点必须一起回滚。
  await runNodes.create(context).execute('shared-call', { nodeIds: ['lin'] }, undefined, undefined)
  const before = await graph()
  const rows = await stageRows()
  await expect(
    runStoryboardFrames
      .create(context)
      .execute('shared-call', { storyboardId: 'board' }, undefined, undefined),
  ).rejects.toThrow('stage_authorization_conflict')
  expect(await graph()).toEqual(before)
  expect(await stageRows()).toBe(rows)
  expect(
    await db
      .select({ id: schema.canvas_commands.id })
      .from(schema.canvas_commands)
      .where(eq(schema.canvas_commands.tool_call_id, 'shared-call')),
  ).toEqual([])
})
