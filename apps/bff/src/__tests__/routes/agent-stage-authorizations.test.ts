import { afterAll, beforeAll, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import {
  canvasNodeKind,
  canvasOrigin,
  connectCanvasNodes,
  insertCanvasNode,
  readCanvasDocument,
  updateCanvasNode,
} from '@image-playground/shared'
import { eq } from 'drizzle-orm'
import * as Y from 'yjs'
import {
  _setPrivateBffOverlayForTesting,
  EMPTY_PRIVATE_BFF_OVERLAY,
} from '../../lib/private-overlay'

process.env.DATABASE_URL = await resetTestDatabase('agent_stage_authorizations')
process.env.OPERATOR_CONFIG_FILE = resolve(
  import.meta.dir,
  '../stage-authorization-operator-config.json',
)
process.env.OPENAI_API_KEY = 'test-key'
const { initChannels } = await import('../../lib/channels')
initChannels(resolve(import.meta.dir, '../../../channels.json'))
let actualCredits = 6
let creditsPerUnit = 6
let quoteAvailable = true
_setPrivateBffOverlayForTesting({
  ...EMPTY_PRIVATE_BFF_OVERLAY,
  present: true,
  taskHooks: {
    ...EMPTY_PRIVATE_BFF_OVERLAY.taskHooks,
    async quoteTask({ model, quantity, unitMultiplier }) {
      if (!quoteAvailable) return null
      return {
        estimatedCredits: creditsPerUnit * quantity * unitMultiplier,
        pricing: {
          model,
          quantity,
          unitMultiplier,
          unit: 'image',
          pricingVersion: 'fixture',
          quotedAt: Date.now(),
          validUntil: null,
          baseUnitCredits: 6,
          outputPriceRatio: 0,
          cachedInputPriceRatio: 0,
          inputEstimateTokens: 0,
          outputReserveTokens: 0,
          exemption: 'none',
        },
      }
    },
    async reserveTask() {
      return { kind: 'reserved', credits: actualCredits }
    },
  },
})
// Module loading must follow isolated DATABASE_URL and billing-boundary installation.
const { app } = await import('../../app')
const { db, schema, close } = await import('../../db/client')
const { createUserSession, USER_SESSION_COOKIE } = await import('../../lib/user-session')
const { createNodes, runNodes } = await import('../../lib/agent/tools/nodeCanvas')
const { accessCanvasDocument } = await import('../../lib/canvasSyncStore')
const {
  STAGE_AUTHORIZATION_ACTIVE_TTL_MS,
  STAGE_AUTHORIZATION_EXPIRE_BATCH,
  consumeStageAuthorization,
  expireStaleStageAuthorizations,
} = await import('../../lib/agent/stage-authorizations')
const { createAgentImageSource } = await import('../../lib/agent/images')
let cookie: string
beforeAll(async () => {
  await db.insert(schema.users).values({
    id: 'stage-owner',
    username: 'stage-owner',
    password_hash: 'unused',
    status: 'active',
    created_at: Date.now(),
    updated_at: Date.now(),
  })
  cookie = `${USER_SESSION_COOKIE}=${await db.transaction((tx) => createUserSession('stage-owner', tx))}`
})
afterAll(close)
async function fixture(
  nodeIds = ['a'],
  estimatedCredits?: number,
  beforePropose?: (input: { projectId: string }) => Promise<void>,
  turnParams?: {
    canvasImageModel?: string
    video?: {
      model: string
      durationSeconds: number
      resolution: '480p' | '720p' | '1080p' | '2k'
      aspectRatio: '16:9' | '9:16' | '1:1'
    }
  },
) {
  const conversationId = crypto.randomUUID(),
    projectId = crypto.randomUUID(),
    now = Date.now()
  await db.insert(schema.agent_conversations).values({
    id: conversationId,
    user_id: 'stage-owner',
    title: '授权',
    created_at: now,
    updated_at: now,
  })
  await db.insert(schema.canvas_projects).values({
    id: projectId,
    user_id: 'stage-owner',
    conversation_id: conversationId,
    name: '授权',
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
    deviceId: 'stage-device',
    userId: 'stage-owner',
    canvas: { selectedNodeIds: [], elements: [] },
    images: createAgentImageSource({
      references: [],
      history: [],
      conversationId,
      userId: 'stage-owner',
    }),
    autoSubmit: {
      take: () => {
        throw new Error('Canvas must not consume per-turn quota')
      },
    },
    ...(turnParams ? { params: turnParams } : {}),
  }
  await createNodes.create(context).execute(
    'create',
    {
      nodes: [
        { id: 'a', type: 'image', prompt: '嫩芽' },
        { id: 'b', type: 'image', prompt: '树' },
      ],
    },
    undefined,
    undefined,
  )
  if (beforePropose) await beforePropose({ projectId })
  const result = await runNodes
    .create(context)
    .execute(
      'proposal',
      { stage: '素材', nodeIds, ...(estimatedCredits === undefined ? {} : { estimatedCredits }) },
      undefined,
      undefined,
    )
  return result.details!.canvasRun!
}
async function request(id: string, action = '', body?: unknown, authenticated = true) {
  return app.handle(
    new Request(`http://localhost/api/agent/stage-authorizations/${id}${action}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(authenticated ? { cookie } : {}), 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
}
it('persists a pending scoped proposal and activates once without granting execution to replays', async () => {
  const proposal = await fixture()
  expect(proposal).toMatchObject({
    stage: '素材',
    nodeIds: ['a'],
    estimatedCredits: 6,
    status: 'pending',
  })
  expect(proposal.budgetCap).toBe(6)
  expect(proposal).not.toHaveProperty('autoRun')
  expect(await (await request(proposal.authorizationId)).json()).toMatchObject({
    status: 'pending',
    spentCredits: 0,
    budgetCap: 6,
    charges: [{ nodeId: 'a', quantity: 1, credits: 6 }],
  })
  const confirmed = await request(proposal.authorizationId, '/confirm', {})
  expect(confirmed.status).toBe(200)
  const receipt = await confirmed.json()
  expect(receipt.authorization.status).toBe('active')
  expect(typeof receipt.executionToken).toBe('string')
  expect((await request(proposal.authorizationId, '/confirm', {})).status).toBe(409)
  const restored = await (await request(proposal.authorizationId)).json()
  expect(restored).not.toHaveProperty('executionToken')
  expect(restored.audit.map((event: { kind: string }) => event.kind)).toEqual([
    'proposed',
    'confirmed',
  ])
  expect((await request(proposal.authorizationId, '', undefined, false)).status).toBe(401)
})
it('preflights only active authorized nodes, replaces an unsubmitted attempt and ends before submission', async () => {
  const proposal = await fixture()
  const job = { nodeId: 'a', model: 'gpt-image-2.5-flare', quantity: 1, unitMultiplier: 1 }
  expect(
    (
      await request(proposal.authorizationId, '/preflight', {
        ...job,
        executionToken: 'not-active',
        attemptId: 'attempt',
      })
    ).status,
  ).toBe(409)
  const { executionToken } = await (await request(proposal.authorizationId, '/confirm', {})).json()
  expect(
    (
      await request(proposal.authorizationId, '/preflight', {
        ...job,
        nodeId: 'b',
        executionToken,
        attemptId: 'outside',
      })
    ).status,
  ).toBe(409)
  expect(
    (
      await request(proposal.authorizationId, '/preflight', {
        ...job,
        executionToken,
        attemptId: 'attempt',
      })
    ).status,
  ).toBe(200)
  expect(
    (
      await request(proposal.authorizationId, '/preflight', {
        ...job,
        executionToken,
        attemptId: 'another-attempt',
      })
    ).status,
  ).toBe(200)
  const open = await (await request(proposal.authorizationId)).json()
  expect(open.attempts.map((attempt: { id: string }) => attempt.id)).toEqual(['another-attempt'])
  const ended = await (await request(proposal.authorizationId, '/end', {})).json()
  expect(ended.status).toBe('ended')
  expect(ended.spentCredits).toBe(0)
  expect(
    (
      await request(proposal.authorizationId, '/preflight', {
        ...job,
        executionToken,
        attemptId: 'late',
      })
    ).status,
  ).toBe(409)
})

it('prices the stage on the server when the model omits or understates the estimate', async () => {
  const omitted = await fixture()
  expect(omitted.budgetCap).toBe(6)
  const understated = await fixture(['a'], 0)
  expect(understated.budgetCap).toBe(6)
  expect(understated.estimatedCredits).toBe(6)
  const { executionToken } = await (
    await request(understated.authorizationId, '/confirm', {})
  ).json()
  const result = await request(understated.authorizationId, '/preflight', {
    nodeId: 'a',
    model: 'gpt-image-2.5-flare',
    quantity: 1,
    unitMultiplier: 1,
    executionToken,
    attemptId: 'priced',
  })
  expect(result.status).toBe(200)
})

it('prices prompted asset nodes like images and rejects promptless assets', async () => {
  const insert = (
    projectId: string,
    node: {
      id: string
      data: {
        name: string
        meta: { nodeKind: 'asset'; assetKind: 'person' | 'location'; nodePrompt?: string }
      }
    },
    linkFrom?: string,
  ) =>
    accessCanvasDocument('stage-owner', projectId, async (current) => {
      const doc = new Y.Doc()
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(current))
      const vector = Y.encodeStateVector(doc)
      const origin = canvasOrigin('system', 'fixture')
      insertCanvasNode(doc, { ...node, type: 'image', x: 0, y: 0, width: 320, height: 240 }, origin)
      if (linkFrom) connectCanvasNodes(doc, { source: linkFrom, target: node.id }, origin)
      const update = Y.encodeStateAsUpdate(doc, vector)
      doc.destroy()
      return update
    })
  const prompted = await fixture(['person'], undefined, async ({ projectId }) => {
    await insert(projectId, {
      id: 'person',
      data: {
        name: '林夏',
        meta: { nodeKind: 'asset', assetKind: 'person', nodePrompt: '三视图' },
      },
    })
  })
  expect(prompted).toMatchObject({
    nodeIds: ['person'],
    estimatedCredits: 6,
    budgetCap: 6,
  })
  const { executionToken } = await (await request(prompted.authorizationId, '/confirm', {})).json()
  expect(
    (
      await request(prompted.authorizationId, '/preflight', {
        nodeId: 'person',
        model: 'gpt-image-2.5-flare',
        quantity: 1,
        unitMultiplier: 1,
        executionToken,
        attemptId: 'sheet',
      })
    ).status,
  ).toBe(200)
  await expect(
    fixture(['blank'], undefined, async ({ projectId }) => {
      await insert(
        projectId,
        {
          id: 'blank',
          data: { name: '空场景', meta: { nodeKind: 'asset', assetKind: 'location' } },
        },
        'a',
      )
    }),
  ).rejects.toThrow('没有提示词')
})

it('rounds video duration up and prices an unknown resolution like settlement', async () => {
  const writeDraft = (projectId: string, draft: unknown, mode?: string | null) =>
    accessCanvasDocument('stage-owner', projectId, async (current) => {
      const doc = new Y.Doc()
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(current))
      const vector = Y.encodeStateVector(doc)
      const node = readCanvasDocument(doc).nodes.find((item) => item.id === 'clip')
      if (!node || node.type !== 'image' || canvasNodeKind(node) !== 'video')
        throw new Error('missing clip')
      const meta: Record<string, string> = {
        ...node.data.meta,
        nodeVideoDraft: JSON.stringify(draft),
      }
      // 创建时写了文生。不传模式就删掉，才能测「没写模式时按参考图封顶」。
      if (mode === null) delete meta.nodeVideoMode
      else if (mode !== undefined) meta.nodeVideoMode = mode
      updateCanvasNode(
        doc,
        'clip',
        {
          data: {
            ...node.data,
            meta,
          },
        },
        canvasOrigin('system', 'fixture'),
      )
      const update = Y.encodeStateAsUpdate(doc, vector)
      doc.destroy()
      return update
    })
  const contextFor = async (projectId: string) => {
    const [project] = await db
      .select({ id: schema.canvas_projects.conversation_id })
      .from(schema.canvas_projects)
      .where(eq(schema.canvas_projects.id, projectId))
    const conversationId = project?.id
    if (!conversationId) throw new Error('missing conversation')
    await createNodes
      .create({
        mode: 'image' as const,
        experience: 'canvas' as const,
        conversationId,
        turnId: 'turn',
        deviceId: 'stage-device',
        userId: 'stage-owner',
        canvas: { selectedNodeIds: [], elements: [] },
        images: createAgentImageSource({
          references: [],
          history: [],
          conversationId,
          userId: 'stage-owner',
        }),
      })
      .execute(
        'video',
        { nodes: [{ id: 'clip', type: 'video', prompt: '海浪', videoMode: 'text' }] },
        undefined,
        undefined,
      )
  }
  const fractional = await fixture(['clip'], undefined, async ({ projectId }) => {
    await contextFor(projectId)
    await writeDraft(projectId, {
      model: 'video-fixture',
      duration: 1.9,
      resolution: '720p',
      aspectRatio: '16:9',
    })
  })
  expect(fractional).toMatchObject({ budgetCap: 12, nodeIds: ['clip'] })
  expect(await (await request(fractional.authorizationId)).json()).toMatchObject({
    charges: [{ nodeId: 'clip', quantity: 2, unitMultiplier: 1, credits: 12 }],
  })
  const unknown = await fixture(['clip'], undefined, async ({ projectId }) => {
    await contextFor(projectId)
    await writeDraft(projectId, {
      model: 'video-fixture',
      duration: 5,
      resolution: '4k',
      aspectRatio: '16:9',
    })
  })
  expect(unknown).toMatchObject({ budgetCap: 30, nodeIds: ['clip'] })
  expect(await (await request(unknown.authorizationId)).json()).toMatchObject({
    charges: [{ nodeId: 'clip', quantity: 5, unitMultiplier: 1, credits: 30 }],
  })
  const clamped = await fixture(['clip'], undefined, async ({ projectId }) => {
    await contextFor(projectId)
    await writeDraft(projectId, {
      model: 'grok-imagine-video',
      duration: 6,
      resolution: '480p',
      aspectRatio: '16:9',
    })
  })
  expect(clamped).toMatchObject({ budgetCap: 30, nodeIds: ['clip'] })
  expect(await (await request(clamped.authorizationId)).json()).toMatchObject({
    charges: [
      {
        nodeId: 'clip',
        model: 'grok-imagine-video',
        quantity: 5,
        unitMultiplier: 1,
        credits: 30,
      },
    ],
  })
  const confirmed = await request(fractional.authorizationId, '/confirm', {
    charges: [{ nodeId: 'clip', model: 'video-fixture', quantity: 1.9, unitMultiplier: 1 }],
  })
  expect(confirmed.status).toBe(200)
  const receipt = await confirmed.json()
  expect(receipt.authorization.charges).toMatchObject([{ quantity: 2, unitMultiplier: 1 }])
  expect(
    (
      await request(fractional.authorizationId, '/preflight', {
        nodeId: 'clip',
        model: 'video-fixture',
        quantity: 1.9,
        unitMultiplier: 1,
        executionToken: receipt.executionToken,
        attemptId: 'fractional-duration',
      })
    ).status,
  ).toBe(200)
  const narrowed = await fixture(['clip'], undefined, async ({ projectId }) => {
    await contextFor(projectId)
    await writeDraft(
      projectId,
      {
        model: 'grok-imagine-video',
        duration: 8,
        resolution: '1080p',
        aspectRatio: '16:9',
      },
      null,
    )
  })
  expect(await (await request(narrowed.authorizationId)).json()).toMatchObject({
    budgetCap: 48,
    charges: [{ model: 'grok-imagine-video', quantity: 8, unitMultiplier: 1, credits: 48 }],
  })
  const partial = await fixture(
    ['clip'],
    undefined,
    async ({ projectId }) => {
      await contextFor(projectId)
      await writeDraft(projectId, { model: 'grok-imagine-video', duration: 15 }, null)
    },
    {
      video: {
        model: 'grok-imagine-video',
        durationSeconds: 8,
        resolution: '1080p',
        aspectRatio: '16:9',
      },
    },
  )
  expect(await (await request(partial.authorizationId)).json()).toMatchObject({
    budgetCap: 48,
    charges: [{ model: 'grok-imagine-video', quantity: 8, unitMultiplier: 1, credits: 48 }],
  })
})

it('rejects a proposal when the server cannot price the nodes', async () => {
  quoteAvailable = false
  try {
    await expect(fixture()).rejects.toThrow('无法为这些节点计价')
  } finally {
    quoteAvailable = true
  }
})

it('rejects server-priced requests over budget before any task can start', async () => {
  const proposal = await fixture()
  const { executionToken } = await (await request(proposal.authorizationId, '/confirm', {})).json()
  creditsPerUnit = 7
  try {
    const result = await request(proposal.authorizationId, '/preflight', {
      nodeId: 'a',
      model: 'gpt-image-2.5-flare',
      quantity: 1,
      unitMultiplier: 1,
      executionToken,
      attemptId: 'expensive',
    })
    expect(result.status).toBe(409)
    expect(await result.json()).toMatchObject({ error: 'stage_authorization_budget' })
  } finally {
    creditsPerUnit = 6
  }
  expect(await (await request(proposal.authorizationId)).json()).toMatchObject({
    spentCredits: 0,
    attempts: [],
  })
})

it('replaces an unsubmitted attempt and allows the same node under a new authorization', async () => {
  const proposal = await fixture()
  const { executionToken } = await (await request(proposal.authorizationId, '/confirm', {})).json()
  expect(
    (
      await request(proposal.authorizationId, '/preflight', {
        nodeId: 'a',
        model: 'gpt-image-2.5-flare',
        quantity: 1,
        unitMultiplier: 1,
        executionToken,
        attemptId: 'first',
      })
    ).status,
  ).toBe(200)
  expect(
    (
      await request(proposal.authorizationId, '/preflight', {
        nodeId: 'a',
        model: 'gpt-image-2.5-flare',
        quantity: 1,
        unitMultiplier: 1,
        executionToken,
        attemptId: 'retry',
      })
    ).status,
  ).toBe(200)
  const open = await (await request(proposal.authorizationId)).json()
  expect(open.attempts.map((attempt: { id: string }) => attempt.id)).toEqual(['retry'])
  await db
    .update(schema.agent_stage_authorizations)
    .set({
      state: {
        ...open,
        attempts: open.attempts.map((attempt: { id: string }) =>
          attempt.id === 'retry' ? { ...attempt, taskIds: ['task-kept'] } : attempt,
        ),
      },
    })
    .where(eq(schema.agent_stage_authorizations.id, proposal.authorizationId))
  expect(
    (
      await request(proposal.authorizationId, '/preflight', {
        nodeId: 'a',
        model: 'gpt-image-2.5-flare',
        quantity: 1,
        unitMultiplier: 1,
        executionToken,
        attemptId: 'after-submit',
      })
    ).status,
  ).toBe(409)
  const again = await fixture()
  const next = await (await request(again.authorizationId, '/confirm', {})).json()
  expect(
    (
      await request(again.authorizationId, '/preflight', {
        nodeId: 'a',
        model: 'gpt-image-2.5-flare',
        quantity: 1,
        unitMultiplier: 1,
        executionToken: next.executionToken,
        attemptId: 'fresh',
      })
    ).status,
  ).toBe(200)
})

it('atomically accounts real queue costs, rejects overspend and deduplicates accepted submissions', async () => {
  const proposal = await fixture()
  const { executionToken } = await (await request(proposal.authorizationId, '/confirm', {})).json()
  await request(proposal.authorizationId, '/preflight', {
    nodeId: 'a',
    model: 'gpt-image-2.5-flare',
    quantity: 1,
    unitMultiplier: 1,
    executionToken,
    attemptId: 'one',
  })
  const body = {
    prompt: '嫩芽',
    device_id: 'stage-test-device',
    client_request_id: crypto.randomUUID(),
    stage_authorization: {
      authorizationId: proposal.authorizationId,
      executionToken,
      attemptId: 'one',
      nodeId: 'a',
    },
  }
  const submit = () =>
    app.handle(
      new Request('http://localhost/v1/queue/openai-compat/gpt-image-2.5-flare/submit', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )
  actualCredits = 7
  expect((await submit()).status).toBe(409)
  expect(await (await request(proposal.authorizationId)).json()).toMatchObject({ spentCredits: 0 })
  actualCredits = 6
  const [first, duplicate] = await Promise.all([submit(), submit()])
  expect(first.status).toBe(200)
  expect(duplicate.status).toBe(200)
  const accepted = await first.json()
  expect((await duplicate.json()).request_id).toBe(accepted.request_id)
  const state = await (await request(proposal.authorizationId)).json()
  expect(state).toMatchObject({ status: 'exhausted', spentCredits: 6 })
  expect(state.attempts[0].taskIds).toEqual([accepted.request_id])
  expect(state.audit.filter((event: { kind: string }) => event.kind === 'submitted')).toHaveLength(
    1,
  )
  expect(state).not.toHaveProperty('executionToken')
})

it('serializes simultaneous budget reservations across two authorized nodes', async () => {
  const proposal = await fixture(['a', 'b'])
  expect(proposal.budgetCap).toBe(12)
  creditsPerUnit = 7
  try {
    const { executionToken } = await (
      await request(proposal.authorizationId, '/confirm', {})
    ).json()
    const responses = await Promise.all(
      ['a', 'b'].map((nodeId) =>
        request(proposal.authorizationId, '/preflight', {
          nodeId,
          model: 'gpt-image-2.5-flare',
          quantity: 1,
          unitMultiplier: 1,
          executionToken,
          attemptId: nodeId,
        }),
      ),
    )
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409])
    const state = await (await request(proposal.authorizationId)).json()
    expect(state.attempts).toHaveLength(1)
    expect(state.spentCredits).toBe(0)
  } finally {
    creditsPerUnit = 6
  }
})

it('reprices the confirmed jobs and expires an idle active authorization with no in-flight task', async () => {
  const proposal = await fixture(['a'], 1)
  const confirmed = await request(proposal.authorizationId, '/confirm', {
    charges: [{ nodeId: 'a', model: 'gpt-image-2.5-flare', quantity: 2, unitMultiplier: 1 }],
  })
  expect(confirmed.status).toBe(200)
  const receipt = await confirmed.json()
  expect(receipt.authorization.budgetCap).toBe(12)
  expect(
    (
      await request(proposal.authorizationId, '/preflight', {
        nodeId: 'a',
        model: 'gpt-image-2.5-flare',
        quantity: 1,
        unitMultiplier: 1,
        executionToken: receipt.executionToken,
        attemptId: 'cheaper',
      })
    ).status,
  ).toBe(409)
  expect(
    (
      await request(proposal.authorizationId, '/preflight', {
        nodeId: 'a',
        model: 'gpt-image-1',
        quantity: 2,
        unitMultiplier: 1,
        executionToken: receipt.executionToken,
        attemptId: 'other-model',
      })
    ).status,
  ).toBe(409)
  const priced = await request(proposal.authorizationId, '/preflight', {
    nodeId: 'a',
    model: 'gpt-image-2.5-flare',
    quantity: 2,
    unitMultiplier: 1,
    executionToken: receipt.executionToken,
    attemptId: 'aligned',
  })
  expect(priced.status).toBe(200)
  const stored = await (await request(proposal.authorizationId)).json()
  const aged = {
    ...stored,
    audit: stored.audit.map((event: { kind: string; at: number }) =>
      event.kind === 'confirmed'
        ? { ...event, at: Date.now() - STAGE_AUTHORIZATION_ACTIVE_TTL_MS - 1000 }
        : event,
    ),
    attempts: stored.attempts.map((attempt: object) => ({
      ...attempt,
      taskIds: ['stage-inflight'],
    })),
  }
  await db.insert(schema.tasks).values({
    id: 'stage-inflight',
    user_id: 'stage-owner',
    provider: 'openai-compat',
    model: 'gpt-image-2.5-flare',
    status: 'in_progress',
    request_payload: { device_id: 'stage-test-device', prompt: '嫩芽', n: 1 },
    submitted_at: Date.now(),
  })
  await db
    .update(schema.agent_stage_authorizations)
    .set({
      state: aged,
      updated_at: Date.now() - STAGE_AUTHORIZATION_ACTIVE_TTL_MS - 1000,
    })
    .where(eq(schema.agent_stage_authorizations.id, proposal.authorizationId))
  expect(await (await request(proposal.authorizationId)).json()).toMatchObject({ status: 'active' })
  await db
    .update(schema.tasks)
    .set({ status: 'completed' })
    .where(eq(schema.tasks.id, 'stage-inflight'))
  expect(await (await request(proposal.authorizationId)).json()).toMatchObject({
    status: 'expired',
  })
  expect(await expireStaleStageAuthorizations()).toBe(0)
})

it('prices image nodes with the origin tab workbench model', async () => {
  const proposal = await fixture(['a'], undefined, undefined, {
    canvasImageModel: 'workbench-image',
  })
  expect(await (await request(proposal.authorizationId)).json()).toMatchObject({
    charges: [
      { nodeId: 'a', model: 'workbench-image', quantity: 1, unitMultiplier: 1, credits: 6 },
    ],
  })
  const { executionToken } = await (await request(proposal.authorizationId, '/confirm', {})).json()
  expect(
    (
      await request(proposal.authorizationId, '/preflight', {
        nodeId: 'a',
        model: 'workbench-image',
        quantity: 1,
        unitMultiplier: 1,
        executionToken,
        attemptId: 'workbench',
      })
    ).status,
  ).toBe(200)
  expect(
    (
      await request(proposal.authorizationId, '/preflight', {
        nodeId: 'a',
        model: 'gpt-image-2.5-flare',
        quantity: 1,
        unitMultiplier: 1,
        executionToken,
        attemptId: 'channel-default',
      })
    ).status,
  ).toBe(409)
})

it('rejects duplicate node ids in a confirmation', async () => {
  const proposal = await fixture(['a'])
  const duplicated = await request(proposal.authorizationId, '/confirm', {
    charges: [
      { nodeId: 'a', model: 'gpt-image-2.5-flare', quantity: 1, unitMultiplier: 1 },
      { nodeId: 'a', model: 'gpt-image-2.5-flare', quantity: 1, unitMultiplier: 1 },
    ],
  })
  expect(duplicated.status).toBe(409)
  expect(await duplicated.json()).toMatchObject({ error: 'stage_authorization_scope' })
  expect(await (await request(proposal.authorizationId)).json()).toMatchObject({
    status: 'pending',
  })
})

it('rejects negative or non-positive settlement usage', async () => {
  const proposal = await fixture(['a'])
  const { executionToken } = await (await request(proposal.authorizationId, '/confirm', {})).json()
  expect(
    (
      await request(proposal.authorizationId, '/preflight', {
        nodeId: 'a',
        model: 'gpt-image-2.5-flare',
        quantity: 1,
        unitMultiplier: 1,
        executionToken,
        attemptId: 'spend',
      })
    ).status,
  ).toBe(200)
  const usage = { model: 'gpt-image-2.5-flare', quantity: 1, unitMultiplier: 1 }
  const ref = {
    authorizationId: proposal.authorizationId,
    nodeId: 'a',
    attemptId: 'spend',
    executionToken,
  }
  await expect(
    db.transaction((tx) =>
      consumeStageAuthorization(tx, 'stage-owner', ref, 'task-negative', usage, -1),
    ),
  ).rejects.toThrow('stage_authorization_attempt_conflict')
  await expect(
    db.transaction((tx) =>
      consumeStageAuthorization(
        tx,
        'stage-owner',
        ref,
        'task-backward',
        { ...usage, quantity: -1 },
        0,
      ),
    ),
  ).rejects.toThrow('stage_authorization_attempt_conflict')
  expect(await (await request(proposal.authorizationId)).json()).toMatchObject({
    spentCredits: 0,
    attempts: [{ taskIds: [] }],
  })
})

it('counts a fractional submitted duration as the preflight ceiling', async () => {
  const proposal = await fixture(['a'])
  const { executionToken } = await (
    await request(proposal.authorizationId, '/confirm', {
      charges: [{ nodeId: 'a', model: 'gpt-image-2.5-flare', quantity: 2, unitMultiplier: 1 }],
    })
  ).json()
  expect(
    (
      await request(proposal.authorizationId, '/preflight', {
        nodeId: 'a',
        model: 'gpt-image-2.5-flare',
        quantity: 2,
        unitMultiplier: 1,
        executionToken,
        attemptId: 'fraction',
      })
    ).status,
  ).toBe(200)
  const ref = {
    authorizationId: proposal.authorizationId,
    nodeId: 'a',
    attemptId: 'fraction',
    executionToken,
  }
  const usage = { model: 'gpt-image-2.5-flare', quantity: 1.2, unitMultiplier: 1 }
  await db.transaction((tx) =>
    consumeStageAuthorization(tx, 'stage-owner', ref, 'task-fraction', usage, 0),
  )
  expect(await (await request(proposal.authorizationId)).json()).toMatchObject({
    attempts: [{ submittedQuantity: 2, taskIds: ['task-fraction'] }],
  })
  await expect(
    db.transaction((tx) =>
      consumeStageAuthorization(tx, 'stage-owner', ref, 'task-fraction-again', usage, 0),
    ),
  ).rejects.toThrow('stage_authorization_attempt_conflict')
})

it('looks up an authorization without node ids', async () => {
  const proposal = await fixture(['a'])
  const [row] = await db
    .select()
    .from(schema.agent_stage_authorizations)
    .where(eq(schema.agent_stage_authorizations.id, proposal.authorizationId))
  if (!row) throw new Error('missing authorization')
  const result = await runNodes
    .create({
      mode: 'image' as const,
      experience: 'canvas' as const,
      conversationId: row.conversation_id,
      turnId: 'turn',
      deviceId: 'stage-device',
      userId: 'stage-owner',
      canvas: { selectedNodeIds: [], elements: [] },
      images: createAgentImageSource({
        references: [],
        history: [],
        conversationId: row.conversation_id,
        userId: 'stage-owner',
      }),
    })
    .execute('lookup', { authorizationId: proposal.authorizationId }, undefined, undefined)
  expect(
    JSON.parse(result.content[0]?.type === 'text' ? result.content[0].text : ''),
  ).toMatchObject({
    id: proposal.authorizationId,
    status: 'pending',
    nodeIds: ['a'],
  })
  await expect(
    runNodes
      .create({
        mode: 'image' as const,
        experience: 'canvas' as const,
        conversationId: row.conversation_id,
        turnId: 'turn',
        deviceId: 'stage-device',
        userId: 'stage-owner',
        canvas: { selectedNodeIds: [], elements: [] },
        images: createAgentImageSource({
          references: [],
          history: [],
          conversationId: row.conversation_id,
          userId: 'stage-owner',
        }),
      })
      .execute('empty', {}, undefined, undefined),
  ).rejects.toThrow('需要指定要生成的节点')
})

it('expires an idle authorization behind a full batch of in-flight rows', async () => {
  const proposal = await fixture(['a'])
  const [seed] = await db
    .select()
    .from(schema.agent_stage_authorizations)
    .where(eq(schema.agent_stage_authorizations.id, proposal.authorizationId))
  if (!seed) throw new Error('missing authorization')
  const older = Date.now() - STAGE_AUTHORIZATION_ACTIVE_TTL_MS - 10_000
  const idleAt = Date.now() - STAGE_AUTHORIZATION_ACTIVE_TTL_MS - 1_000
  const active = (id: string, at: number, taskId?: string) => ({
    id,
    conversationId: seed.conversation_id,
    projectId: seed.project_id,
    stage: '回收',
    nodeIds: ['a'],
    nodeNames: ['嫩芽'],
    estimatedCredits: 0,
    budgetCap: 0,
    charges: [],
    spentCredits: 0,
    status: 'active' as const,
    attempts: taskId
      ? [
          {
            id: `${id}-attempt`,
            nodeId: 'a',
            model: 'gpt-image-2.5-flare',
            quantity: 1,
            unitMultiplier: 1,
            reservedCredits: 0,
            spentCredits: 0,
            submittedQuantity: 0,
            taskIds: [taskId],
          },
        ]
      : [],
    audit: [{ kind: 'confirmed' as const, at }],
  })
  for (let index = 0; index < STAGE_AUTHORIZATION_EXPIRE_BATCH; index += 1) {
    const id = `inflight-${seed.id}-${index}`
    const taskId = `task-${id}`
    await db.insert(schema.tasks).values({
      id: taskId,
      user_id: 'stage-owner',
      provider: 'openai-compat',
      model: 'gpt-image-2.5-flare',
      status: 'in_progress',
      request_payload: { device_id: 'stage-test-device', prompt: '嫩芽', n: 1 },
      submitted_at: older,
    })
    await db.insert(schema.agent_stage_authorizations).values({
      id,
      user_id: seed.user_id,
      conversation_id: seed.conversation_id,
      project_id: seed.project_id,
      proposal_key: id,
      state: active(id, older, taskId),
      created_at: older,
      updated_at: older,
    })
  }
  const idleId = `idle-${seed.id}`
  await db.insert(schema.agent_stage_authorizations).values({
    id: idleId,
    user_id: seed.user_id,
    conversation_id: seed.conversation_id,
    project_id: seed.project_id,
    proposal_key: idleId,
    state: active(idleId, idleAt),
    created_at: idleAt,
    updated_at: idleAt,
  })
  expect(await expireStaleStageAuthorizations()).toBe(1)
  const [idle] = await db
    .select()
    .from(schema.agent_stage_authorizations)
    .where(eq(schema.agent_stage_authorizations.id, idleId))
  const [blocked] = await db
    .select()
    .from(schema.agent_stage_authorizations)
    .where(eq(schema.agent_stage_authorizations.id, `inflight-${seed.id}-0`))
  expect(idle?.state.status).toBe('expired')
  expect(blocked?.state.status).toBe('active')
})
