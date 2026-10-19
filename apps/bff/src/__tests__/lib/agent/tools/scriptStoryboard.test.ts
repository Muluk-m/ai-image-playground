import { afterAll, beforeAll, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import {
  canvasInputFingerprint,
  canvasMainResult,
  canvasOrigin,
  canvasResultIsStale,
  canvasResults,
  chooseCanvasResult,
  insertCanvasNode,
  readCanvasDocument,
  recordCanvasResult,
  storyboardFingerprint,
  updateCanvasNode,
} from '@image-playground/shared'
import * as Y from 'yjs'

process.env.DATABASE_URL = await resetTestDatabase('agent_script_storyboard')
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../../../canvas-sync-operator-config.json')
// Database/config singletons must load after this suite selects its isolated database.
const { db, schema, close } = await import('../../../../db/client')
const { createNodes, connectNodes, applyScriptPlan } = await import('../../../../lib/agent/tools/nodeCanvas')
const { createAgentImageSource } = await import('../../../../lib/agent/images')
const { accessCanvasDocument } = await import('../../../../lib/canvasSyncStore')
const { _setChannelsForTesting } = await import('../../../../lib/channels')
const userId = 'script-storyboard-owner'
beforeAll(async () => {
  await db.insert(schema.users).values({
    id: userId, username: userId, password_hash: 'unused', status: 'active',
    created_at: Date.now(), updated_at: Date.now(),
  })
})
afterAll(close)

async function fixture() {
  const conversationId = crypto.randomUUID(), projectId = crypto.randomUUID(), now = Date.now()
  await db.insert(schema.agent_conversations).values({
    id: conversationId, user_id: userId, title: '分镜表', created_at: now, updated_at: now,
  })
  await db.insert(schema.canvas_projects).values({
    id: projectId, user_id: userId, conversation_id: conversationId, name: '分镜表',
    document: { version: 1, elements: [] }, revision: 1, receipts: [], element_count: 0,
    created_at: now, updated_at: now,
  })
  const context = {
    mode: 'image' as const, experience: 'canvas' as const, conversationId, turnId: 'turn',
    deviceId: 'device-test', userId, canvas: { selectedNodeIds: [], elements: [] },
    images: createAgentImageSource({ references: [], history: [], conversationId, userId }),
  }
  const run = (tool: typeof createNodes, args: unknown) =>
    tool.create(context).execute(crypto.randomUUID(), args, undefined, undefined)
  const document = async () => {
    const doc = new Y.Doc()
    Y.applyUpdate(doc, await accessCanvasDocument(userId, projectId))
    return doc
  }
  const graph = async () => {
    const doc = await document()
    try { return readCanvasDocument(doc) } finally { doc.destroy() }
  }
  await run(createNodes, { nodes: [{ id: 'script', type: 'text', text: '## 第 1 集\n窗台。\n' }] })
  return { run, graph, document, projectId, context }
}
const plan = {
  scriptNodeId: 'script', storyboardId: 'board', assets: [],
  shots: [{ id: 'opening', description: '推开窗户', lookIds: [] }],
}

it('expands an episode in its original board, preserves shot identity and deletes omitted shots', async () => {
  const { run, graph } = await fixture()
  await run(applyScriptPlan, plan)
  await run(applyScriptPlan, {
    ...plan,
    shots: [
      { ...plan.shots[0]!, description: '缓缓推开窗户' },
      { id: 'ending', description: '新叶展开', lookIds: [] },
    ],
  })
  expect((await graph()).nodes.filter((node) => node.type === 'storyboard')).toMatchObject([
    { id: 'board', data: { shots: [
      { id: 'opening', description: '缓缓推开窗户' }, { id: 'ending', description: '新叶展开' },
    ] } },
  ])
  await run(applyScriptPlan, { ...plan, shots: [{ id: 'ending', description: '结尾定格', lookIds: [] }] })
  expect((await graph()).nodes.find((node) => node.id === 'board')?.data).toMatchObject({
    shots: [{ id: 'ending', description: '结尾定格' }],
  })
  expect((await graph()).edges.filter((edge) => edge.source === 'script')).toHaveLength(1)
})

it('rejects a second effective board for the episode and points to the original without partial writes', async () => {
  const { run, graph } = await fixture()
  await run(applyScriptPlan, plan)
  const before = await graph()
  await expect(run(applyScriptPlan, {
    ...plan, storyboardId: 'duplicate',
    assets: [{ id: 'unused-person', kind: 'person', name: '新人', description: '' }],
  })).rejects.toThrow('board')
  expect(await graph()).toEqual(before)
  await run(applyScriptPlan, {
    ...plan, storyboardId: 'episode-two', episodeNumber: 2,
    episode: { number: 2, text: '第二天。' },
  })
  expect((await graph()).nodes.filter((node) => node.type === 'storyboard')).toHaveLength(2)
  await expect(run(applyScriptPlan, {
    ...plan, episodeNumber: 2,
  })).rejects.toThrow('第 1 集')
})

it('adopts an existing connected legacy board instead of creating another for episode one', async () => {
  const { run, graph } = await fixture()
  await run(createNodes, { nodes: [{ id: 'legacy', type: 'storyboard' }] })
  await run(connectNodes, { edges: [{ source: 'script', target: 'legacy' }] })
  await expect(run(applyScriptPlan, plan)).rejects.toThrow('legacy')
  await run(applyScriptPlan, { ...plan, storyboardId: 'legacy' })
  expect((await graph()).nodes.find((node) => node.id === 'legacy')?.data).toMatchObject({
    episode: { scriptNodeId: 'script', number: 1 },
    shots: [{ id: 'opening' }],
  })
})

it('rejects shots above the current first-frame video model limit with a split-shot remedy', async () => {
  const { run, graph, context } = await fixture()
  _setChannelsForTesting([{
    id: 'video-gateway', kind: 'openai-queue', label: 'Video',
    baseUrl: 'https://gateway.example/v1',
    auth: { type: 'bearer', secretRef: 'VIDEO_API_KEY', secret: 'test' },
    allowedPaths: ['videos/generations'], defaults: { asyncTasks: true },
    models: [
      { id: 'grok-imagine-video', label: 'Grok', media: 'video', capabilities: ['generate'] },
      { id: 'veo-3.1-lite-generate-preview', label: 'Veo', media: 'video', capabilities: ['generate'] },
    ],
  }])
  try {
    const selected = applyScriptPlan.create({
      ...context,
      params: { video: { model: 'veo-3.1-lite-generate-preview', durationSeconds: 8, aspectRatio: '16:9', resolution: '720p' } },
    })
    await selected.execute('within-limit', {
      ...plan, shots: [{ ...plan.shots[0]!, durationSeconds: 8 }],
    }, undefined, undefined)
    const before = await graph()
    await expect(selected.execute('over-limit', {
      ...plan, shots: [{ ...plan.shots[0]!, durationSeconds: 9 }],
    }, undefined, undefined)).rejects.toThrow(/opening.*8.*拆镜/)
    expect(await graph()).toEqual(before)
    await run(applyScriptPlan, {
      ...plan, shots: [{ ...plan.shots[0]!, durationSeconds: 15 }],
    })
    await expect(run(applyScriptPlan, {
      ...plan, shots: [{ ...plan.shots[0]!, durationSeconds: 16 }],
    })).rejects.toThrow(/15.*拆镜/)
  } finally {
    _setChannelsForTesting([])
  }
})

it('prevents duplicate episode boards through another script or an omitted episode number', async () => {
  const { run, graph } = await fixture()
  await run(applyScriptPlan, plan)
  await run(createNodes, { nodes: [{ id: 'other-script', type: 'text', text: '另一稿' }] })
  const before = await graph()
  await expect(run(applyScriptPlan, {
    ...plan, scriptNodeId: 'other-script', storyboardId: 'other-board', episodeNumber: 1,
  })).rejects.toThrow('board')
  await expect(run(applyScriptPlan, {
    ...plan, scriptNodeId: 'other-script', storyboardId: 'other-board',
  })).rejects.toThrow('board')
  expect(await graph()).toEqual(before)
})

it('editing a finalized board makes it draft and immediately stales frames and videos without removing results', async () => {
  const { run, document, projectId } = await fixture()
  await run(applyScriptPlan, plan)
  const origin = canvasOrigin('user', 'storyboard-fixture')
  const doc = await document()
  const vector = Y.encodeStateVector(doc)
  const board = readCanvasDocument(doc).nodes.find((node) => node.id === 'board')!
  if (board.type !== 'storyboard') throw new Error('Missing storyboard')
  const fingerprint = storyboardFingerprint(board.data.shots)
  updateCanvasNode(doc, board.id, {
    data: { ...board.data, confirmed: { fingerprint, model: 'image-model', quantity: 1 } },
  }, origin)
  for (const [nodeId, role, kind] of [
    ['first-frame', 'frame', 'image'], ['shot-video', 'video', 'video'],
  ] as const) {
    const taskId = crypto.randomUUID()
    await db.insert(schema.tasks).values({
      id: taskId, user_id: userId, provider: 'openai-compat', model: 'fixture',
      status: 'completed', request_payload: { prompt: 'fixture' }, submitted_at: Date.now(),
    })
    insertCanvasNode(doc, {
      id: nodeId, type: 'image', x: 500, y: 0, width: 300, height: 200,
      data: { meta: { nodeKind: kind, storyboardId: 'board', storyboardRole: role, storyboardFingerprint: fingerprint } },
    }, origin)
    recordCanvasResult(doc, {
      id: `${nodeId}-result`, nodeId, kind, source: { type: 'queue', taskId, outputIndex: 0 },
      inputFingerprint: canvasInputFingerprint(doc, nodeId), createdAt: Date.now(),
    }, origin)
    chooseCanvasResult(doc, nodeId, `${nodeId}-result`, {
      data: kind === 'video' ? { video: { taskId, outputIndex: 0 } } : {},
    }, origin)
    expect(canvasResultIsStale(doc, nodeId)).toBe(false)
  }
  await accessCanvasDocument(userId, projectId, Y.encodeStateAsUpdate(doc, vector))
  doc.destroy()
  await run(applyScriptPlan, plan)
  const unchanged = await document()
  expect(canvasResultIsStale(unchanged, 'first-frame')).toBe(false)
  expect(canvasResultIsStale(unchanged, 'shot-video')).toBe(false)
  const results = canvasResults(unchanged)
  unchanged.destroy()
  await run(applyScriptPlan, {
    ...plan, shots: [{ ...plan.shots[0]!, description: '新的开场' }],
  })
  const edited = await document()
  try {
    const current = readCanvasDocument(edited).nodes.find((node) => node.id === 'board')!
    if (current.type !== 'storyboard') throw new Error('Missing storyboard')
    expect(current.data.confirmed?.fingerprint).not.toBe(storyboardFingerprint(current.data.shots))
    for (const nodeId of ['first-frame', 'shot-video']) {
      expect(canvasResultIsStale(edited, nodeId)).toBe(true)
      expect(canvasMainResult(edited, nodeId)?.id).toBe(`${nodeId}-result`)
    }
    expect(canvasResults(edited)).toEqual(results)
  } finally {
    edited.destroy()
  }
})

it('can remove every shot while keeping the episode board identity', async () => {
  const { run, graph } = await fixture()
  await run(applyScriptPlan, plan)
  await run(applyScriptPlan, { ...plan, shots: [] })
  expect((await graph()).nodes.find((node) => node.id === 'board')?.data).toMatchObject({
    shots: [], episode: { scriptNodeId: 'script', number: 1 },
  })
  await run(applyScriptPlan, {
    ...plan, shots: [{ id: 'replacement', description: '新的镜头', lookIds: [] }],
  })
  expect((await graph()).nodes.find((node) => node.id === 'board')?.data).toMatchObject({
    shots: [{ id: 'replacement' }],
  })
})

it('rejects an unavailable explicitly selected model instead of silently checking another model', async () => {
  const { context, graph } = await fixture()
  const before = await graph()
  await expect(applyScriptPlan.create({
    ...context,
    params: { video: { model: 'unavailable-video', durationSeconds: 8, aspectRatio: '16:9', resolution: '720p' } },
  }).execute('unavailable', plan, undefined, undefined)).rejects.toThrow('首帧视频模型')
  expect(await graph()).toEqual(before)
})
