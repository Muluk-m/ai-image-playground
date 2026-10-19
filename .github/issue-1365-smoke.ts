// Throwaway runtime smoke: copy into apps/bff/.issue-1365-smoke.ts, run with Bun, then remove.
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import type { CanvasSnapshot } from '@image-playground/shared'
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

process.env.DATABASE_URL = await resetTestDatabase('issue1365_runtime_smoke')
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, 'src/__tests__/canvas-sync-operator-config.json')
// BFF singletons must initialize only after this isolated database/config is selected.
const { db, schema, close } = await import('./src/db/client')
const { createNodes, applyScriptPlan } = await import('./src/lib/agent/tools/nodeCanvas')
const { createAgentImageSource } = await import('./src/lib/agent/images')
const { accessCanvasDocument } = await import('./src/lib/canvasSyncStore')
const { _setChannelsForTesting } = await import('./src/lib/channels')

const userId = crypto.randomUUID()
const conversationId = crypto.randomUUID()
const projectId = crypto.randomUUID()
const now = Date.now()
const events: object[] = []
try {
  await db.insert(schema.users).values({
    id: userId, username: userId, password_hash: 'smoke-unused', status: 'active',
    created_at: now, updated_at: now,
  })
  await db.insert(schema.agent_conversations).values({
    id: conversationId, user_id: userId, title: 'Issue 1365 runtime smoke', created_at: now, updated_at: now,
  })
  await db.insert(schema.canvas_projects).values({
    id: projectId, user_id: userId, conversation_id: conversationId, name: 'Issue 1365 smoke',
    document: { version: 1, elements: [] }, revision: 1, receipts: [], element_count: 0,
    created_at: now, updated_at: now,
  })
  _setChannelsForTesting([{
    id: 'video-gateway', kind: 'openai-queue', label: 'Smoke Veo',
    baseUrl: 'https://upstream.invalid/v1',
    auth: { type: 'bearer', secretRef: 'SMOKE_VIDEO_KEY', secret: 'not-a-real-key' },
    allowedPaths: ['videos/generations'], defaults: { asyncTasks: true },
    models: [{ id: 'veo-3.1-lite-generate-preview', label: 'Veo', media: 'video', capabilities: ['generate'] }],
  }])
  const context = {
    mode: 'image' as const, experience: 'canvas' as const, conversationId, turnId: 'smoke-turn',
    deviceId: 'smoke-device', userId, canvas: { selectedNodeIds: [], elements: [] },
    params: { video: { model: 'veo-3.1-lite-generate-preview', durationSeconds: 8, aspectRatio: '16:9' as const, resolution: '720p' as const } },
    images: createAgentImageSource({ references: [], history: [], conversationId, userId }),
  }
  const invoke = async (tool: typeof createNodes, args: unknown) => {
    const result = await tool.create(context).execute(crypto.randomUUID(), args, undefined, undefined)
    const content = result.content.find((part) => part.type === 'text')
    assert(content && content.type === 'text')
    const receipt = JSON.parse(content.text)
    assert.equal(receipt.saved, true)
    return receipt
  }
  const load = async () => {
    const doc = new Y.Doc()
    Y.applyUpdate(doc, await accessCanvasDocument(userId, projectId))
    return doc
  }
  await invoke(createNodes, { nodes: [{ id: 'script', type: 'text', text: '## 第 1 集\n推开窗户。' }] })
  const plan = {
    scriptNodeId: 'script', storyboardId: 'episode-one', episodeNumber: 1, assets: [],
    shots: [{ id: 'opening', description: '推开窗户', lookIds: [], durationSeconds: 8 }],
  }
  events.push({ operation: 'create-board', receipt: await invoke(applyScriptPlan, plan) })
  const doc = await load()
  try {
    const vector = Y.encodeStateVector(doc)
    const board = readCanvasDocument(doc).nodes.find((node) => node.id === plan.storyboardId)
    assert(board?.type === 'storyboard')
    const fingerprint = storyboardFingerprint(board.data.shots)
    const origin = canvasOrigin('user', 'runtime-smoke')
    updateCanvasNode(doc, board.id, {
      data: { ...board.data, confirmed: { fingerprint, model: 'smoke-image', quantity: 1 } },
    }, origin)
    for (const [nodeId, kind, role] of [
      ['frame', 'image', 'frame'], ['clip', 'video', 'video'],
    ] as const) {
      const taskId = crypto.randomUUID()
      await db.insert(schema.tasks).values({
        id: taskId, user_id: userId, provider: 'openai-compat', model: 'smoke', status: 'completed',
        request_payload: { prompt: 'seeded existing result; no upstream called' }, submitted_at: now,
      })
      insertCanvasNode(doc, {
        id: nodeId, type: 'image', x: 100, y: 100, width: 320, height: 180,
        data: { meta: { nodeKind: kind, storyboardId: board.id, storyboardRole: role, storyboardFingerprint: fingerprint } },
      }, origin)
      assert.equal(recordCanvasResult(doc, {
        id: `${nodeId}-result`, nodeId, kind, createdAt: now,
        source: { type: 'queue', taskId, outputIndex: 0 }, inputFingerprint: canvasInputFingerprint(doc, nodeId),
      }, origin), true)
      assert.equal(chooseCanvasResult(doc, nodeId, `${nodeId}-result`, {
        data: kind === 'video' ? { video: { taskId, outputIndex: 0 } } : {},
      }, origin), true)
      assert.equal(canvasResultIsStale(doc, nodeId), false)
    }
    await accessCanvasDocument(userId, projectId, Y.encodeStateAsUpdate(doc, vector))
  } finally { doc.destroy() }

  events.push({ operation: 'expand-board', receipt: await invoke(applyScriptPlan, {
    ...plan,
    shots: [
      { ...plan.shots[0]!, description: '缓缓推开窗户' },
      { id: 'ending', description: '新叶展开', lookIds: [], durationSeconds: 8 },
    ],
  }) })
  const expanded = await load()
  let expected: CanvasSnapshot
  try {
    expected = readCanvasDocument(expanded)
    const boards = expected.nodes.filter((node) => node.type === 'storyboard')
    assert.equal(boards.length, 1)
    assert.equal(boards[0]!.id, 'episode-one')
    const board = boards[0]!
    assert(board.type === 'storyboard')
    assert.deepEqual(board.data.shots.map((shot) => shot.id), ['opening', 'ending'])
    assert.notEqual(board.data.confirmed?.fingerprint, storyboardFingerprint(board.data.shots))
    assert.equal(canvasResults(expanded).length, 2)
    for (const id of ['frame', 'clip']) {
      assert.equal(canvasResultIsStale(expanded, id), true)
      assert.equal(canvasMainResult(expanded, id)?.id, `${id}-result`)
    }
    events.push({ operation: 'read-expanded-board', id: board.id, shotIds: board.data.shots.map((shot) => shot.id), draft: true, stale: ['frame', 'clip'], retainedResults: 2 })
  } finally { expanded.destroy() }

  for (const [operation, args, pattern] of [
    ['duplicate-board', { ...plan, storyboardId: 'duplicate' }, /episode-one/],
    ['overlong-shot', { ...plan, shots: [{ ...plan.shots[0]!, durationSeconds: 9 }] }, /opening.*8.*拆镜/],
  ] as const) {
    let message = ''
    try { await invoke(applyScriptPlan, args) } catch (error) { message = error instanceof Error ? error.message : String(error) }
    assert.match(message, pattern)
    const unchanged = await load()
    try { assert.deepEqual(readCanvasDocument(unchanged), expected!) } finally { unchanged.destroy() }
    events.push({ operation, rejected: true, message, atomic: true })
  }
  await invoke(applyScriptPlan, { ...plan, shots: [{ id: 'ending', description: '保留结尾', lookIds: [], durationSeconds: 8 }] })
  const trimmed = await load()
  try {
    const board = readCanvasDocument(trimmed).nodes.find((node) => node.id === 'episode-one')
    assert(board?.type === 'storyboard')
    assert.deepEqual(board.data.shots.map((shot) => shot.id), ['ending'])
    assert.equal(canvasResults(trimmed).length, 2)
    events.push({ operation: 'delete-shot', remainingShotIds: ['ending'], retainedResults: 2 })
  } finally { trimmed.destroy() }
  console.log(JSON.stringify({ issue: 1365, status: 'passed', projectId, upstreamCalls: 0, events }, null, 2))
} finally {
  _setChannelsForTesting([])
  await close()
}
