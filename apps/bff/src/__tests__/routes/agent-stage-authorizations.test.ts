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
import { eq, sql } from 'drizzle-orm'
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
const { config } = await import('../../config')
const { db, schema, close } = await import('../../db/client')
const { createUserSession, hashSessionToken, USER_SESSION_COOKIE } = await import(
  '../../lib/user-session'
)
const { finishLogout } = await import('../../routes/auth')
const { createNodes, runNodes } = await import('../../lib/agent/tools/nodeCanvas')
const { accessCanvasDocument } = await import('../../lib/canvasSyncStore')
const {
  STAGE_AUTHORIZATION_ACTIVE_TTL_MS,
  STAGE_AUTHORIZATION_EXPIRE_BATCH,
  consumeStageAuthorization,
  expireStaleStageAuthorizations,
  proposeStageAuthorization,
  stageAuthorizationInFlightTaskIds,
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
    n?: number
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

it('keeps the proposed spec, rejects a drifted confirmation, and expires an idle active authorization with no in-flight task', async () => {
  const proposal = await fixture(['a'], 1)
  expect(proposal.specs).toEqual([
    { nodeId: 'a', model: 'gpt-image-2.5-flare', quantity: 1, unitMultiplier: 1 },
  ])
  const drifted = await request(proposal.authorizationId, '/confirm', {
    charges: [{ nodeId: 'a', model: 'gpt-image-2.5-flare', quantity: 2, unitMultiplier: 1 }],
  })
  expect(drifted.status).toBe(409)
  expect(await drifted.json()).toMatchObject({ error: 'stage_authorization_stale' })
  expect(await (await request(proposal.authorizationId)).json()).toMatchObject({
    status: 'pending',
    budgetCap: 6,
  })
  const confirmed = await request(proposal.authorizationId, '/confirm', {
    charges: [{ nodeId: 'a', model: 'gpt-image-2.5-flare', quantity: 1, unitMultiplier: 1 }],
  })
  expect(confirmed.status).toBe(200)
  const receipt = await confirmed.json()
  expect(receipt.authorization.budgetCap).toBe(6)
  expect(
    (
      await request(proposal.authorizationId, '/preflight', {
        nodeId: 'a',
        model: 'gpt-image-2.5-flare',
        quantity: 2,
        unitMultiplier: 1,
        executionToken: receipt.executionToken,
        attemptId: 'more',
      })
    ).status,
  ).toBe(409)
  expect(
    (
      await request(proposal.authorizationId, '/preflight', {
        nodeId: 'a',
        model: 'gpt-image-1',
        quantity: 1,
        unitMultiplier: 1,
        executionToken: receipt.executionToken,
        attemptId: 'other-model',
      })
    ).status,
  ).toBe(409)
  const priced = await request(proposal.authorizationId, '/preflight', {
    nodeId: 'a',
    model: 'gpt-image-2.5-flare',
    quantity: 1,
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
      consumeStageAuthorization(tx, 'stage-owner', ref, 'task-negative', usage, -1, {
        prompt: '嫩芽',
        inputCount: 0,
      }),
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
        { prompt: '嫩芽', inputCount: 0 },
      ),
    ),
  ).rejects.toThrow('stage_authorization_attempt_conflict')
  expect(await (await request(proposal.authorizationId)).json()).toMatchObject({
    spentCredits: 0,
    attempts: [{ taskIds: [] }],
  })
})

it('counts a fractional submitted duration as the preflight ceiling', async () => {
  const proposal = await fixture(['a'], undefined, undefined, { n: 2 })
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
    consumeStageAuthorization(tx, 'stage-owner', ref, 'task-fraction', usage, 0, {
      prompt: '嫩芽',
      inputCount: 0,
    }),
  )
  expect(await (await request(proposal.authorizationId)).json()).toMatchObject({
    attempts: [{ submittedQuantity: 2, taskIds: ['task-fraction'] }],
  })
  await expect(
    db.transaction((tx) =>
      consumeStageAuthorization(tx, 'stage-owner', ref, 'task-fraction-again', usage, 0, {
        prompt: '嫩芽',
        inputCount: 0,
      }),
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
  // 与过期扫描共用 stageAuthorizationInFlightTaskIds。选出 task_id 列：
  // 生产 SQL 若退回 `as task_id`，这里会因列不存在而失败。空闲授权没有在途任务，不能出现。
  const inFlight = await db.execute<{ authorization_id: string; task_id: string }>(sql`
    select ${schema.agent_stage_authorizations.id} as authorization_id, inflight.task_id as task_id
    from ${schema.agent_stage_authorizations}
    cross join lateral (${stageAuthorizationInFlightTaskIds()}) as inflight
    where ${schema.agent_stage_authorizations.id} like ${`inflight-${seed.id}-%`}
       or ${schema.agent_stage_authorizations.id} = ${idleId}
  `)
  expect(inFlight).toHaveLength(STAGE_AUTHORIZATION_EXPIRE_BATCH)
  expect(inFlight.map((row) => row.authorization_id)).not.toContain(idleId)
})

const PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function queueSubmit(body: Record<string, unknown>, session = cookie) {
  return app.handle(
    new Request('http://localhost/v1/queue/openai-compat/gpt-image-2.5-flare/submit', {
      method: 'POST',
      headers: { cookie: session, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

it('keeps the submitted duration and rejects an authorization whose content is not the frozen node', async () => {
  const proposal = await fixture()
  const { executionToken } = await (await request(proposal.authorizationId, '/confirm', {})).json()
  await request(proposal.authorizationId, '/preflight', {
    nodeId: 'a',
    model: 'gpt-image-2.5-flare',
    quantity: 1,
    unitMultiplier: 1,
    executionToken,
    attemptId: 'bound',
  })
  const auth = {
    authorizationId: proposal.authorizationId,
    executionToken,
    attemptId: 'bound',
    nodeId: 'a',
  }
  const wrongPrompt = await queueSubmit({
    prompt: '别的内容',
    device_id: 'stage-test-device',
    client_request_id: crypto.randomUUID(),
    stage_authorization: auth,
  })
  expect(wrongPrompt.status).toBe(409)
  expect(await wrongPrompt.json()).toMatchObject({ error: 'stage_authorization_scope' })
  const ref = { ...auth }
  const usage = { model: 'gpt-image-2.5-flare', quantity: 1, unitMultiplier: 1 }
  await expect(
    db.transaction((tx) =>
      consumeStageAuthorization(tx, 'stage-owner', ref, 'task-video', usage, 0, {
        prompt: '嫩芽',
        inputCount: 0,
        video: { durationSeconds: 5, resolution: '720p', aspectRatio: '16:9' },
      }),
    ),
  ).rejects.toThrow('stage_authorization_scope')
  const open = await (await request(proposal.authorizationId)).json()
  await db
    .update(schema.agent_stage_authorizations)
    .set({ state: { ...open, bindings: undefined } })
    .where(eq(schema.agent_stage_authorizations.id, proposal.authorizationId))
  const unbound = await queueSubmit({
    prompt: '嫩芽',
    device_id: 'stage-test-device',
    client_request_id: crypto.randomUUID(),
    stage_authorization: auth,
  })
  expect(unbound.status).toBe(409)
  expect(await unbound.json()).toMatchObject({ error: 'stage_authorization_scope' })
  expect(await (await request(proposal.authorizationId)).json()).toMatchObject({
    spentCredits: 0,
    attempts: [{ taskIds: [] }],
  })
})

it('discards archived inputs when stage consumption fails after preparation', async () => {
  const { InMemoryObjectStore } = await import('../helpers/inMemoryObjectStore')
  const { setObjectStoreForTesting } = await import('../../lib/objectStore')
  const store = new InMemoryObjectStore()
  setObjectStoreForTesting(store)
  try {
    const proposal = await fixture()
    const { executionToken } = await (
      await request(proposal.authorizationId, '/confirm', {})
    ).json()
    await request(proposal.authorizationId, '/preflight', {
      nodeId: 'a',
      model: 'gpt-image-2.5-flare',
      quantity: 1,
      unitMultiplier: 1,
      executionToken,
      attemptId: 'archive',
    })
    const before = new Set(
      (await db.select({ id: schema.tasks.id }).from(schema.tasks)).map((row) => row.id),
    )
    const failed = await queueSubmit({
      prompt: '嫩芽',
      device_id: 'stage-test-device',
      client_request_id: crypto.randomUUID(),
      input_images: [PIXEL],
      stage_authorization: {
        authorizationId: proposal.authorizationId,
        executionToken,
        attemptId: 'archive',
        nodeId: 'a',
      },
    })
    expect(failed.status).toBe(409)
    expect(await failed.json()).toMatchObject({ error: 'stage_authorization_scope' })
    expect(store.events.some((event) => event.startsWith('write:'))).toBe(true)
    expect(
      store.events.some((event) => event.startsWith('delete:') && event.endsWith('/in/')),
    ).toBe(true)
    expect(store.objects.size).toBe(0)
    const created = (await db.select({ id: schema.tasks.id }).from(schema.tasks)).filter(
      (row) => !before.has(row.id),
    )
    expect(created).toHaveLength(0)
  } finally {
    setObjectStoreForTesting()
  }
})

it('includes the stage authorization in the idempotency identity and does not consume a mismatched replay', async () => {
  const proposal = await fixture()
  const { executionToken } = await (await request(proposal.authorizationId, '/confirm', {})).json()
  await request(proposal.authorizationId, '/preflight', {
    nodeId: 'a',
    model: 'gpt-image-2.5-flare',
    quantity: 1,
    unitMultiplier: 1,
    executionToken,
    attemptId: 'idem',
  })
  const stageAuthorization = {
    authorizationId: proposal.authorizationId,
    executionToken,
    attemptId: 'idem',
    nodeId: 'a',
  }
  const sharedId = crypto.randomUUID()
  const plain = await queueSubmit({
    prompt: '嫩芽',
    device_id: 'stage-test-device',
    client_request_id: sharedId,
  })
  expect(plain.status).toBe(200)
  const rebound = await queueSubmit({
    prompt: '嫩芽',
    device_id: 'stage-test-device',
    client_request_id: sharedId,
    stage_authorization: stageAuthorization,
  })
  expect(rebound.status).toBe(409)
  expect(await rebound.json()).toMatchObject({ error: 'idempotency_key_conflict' })
  expect(await (await request(proposal.authorizationId)).json()).toMatchObject({ spentCredits: 0 })
  const authedId = crypto.randomUUID()
  const authed = {
    prompt: '嫩芽',
    device_id: 'stage-test-device',
    client_request_id: authedId,
    stage_authorization: stageAuthorization,
  }
  const first = await queueSubmit(authed)
  expect(first.status).toBe(200)
  const replay = await queueSubmit(authed)
  expect(replay.status).toBe(200)
  expect((await replay.json()).request_id).toBe((await first.json()).request_id)
  const charged = await (await request(proposal.authorizationId)).json()
  expect(charged).toMatchObject({ spentCredits: 6 })
  expect(charged.attempts[0].taskIds).toHaveLength(1)
  const stripped = await queueSubmit({
    prompt: '嫩芽',
    device_id: 'stage-test-device',
    client_request_id: authedId,
  })
  expect(stripped.status).toBe(409)
  const still = await (await request(proposal.authorizationId)).json()
  expect(still.spentCredits).toBe(6)
  expect(still.attempts[0].taskIds).toHaveLength(1)
})

it('returns the existing proposal when the key matches and rejects a different owner or node set', async () => {
  const proposal = await fixture()
  const [row] = await db
    .select()
    .from(schema.agent_stage_authorizations)
    .where(eq(schema.agent_stage_authorizations.id, proposal.authorizationId))
  if (!row?.state.bindings) throw new Error('missing binding')
  const again = await proposeStageAuthorization({
    userId: 'stage-owner',
    conversationId: row.conversation_id,
    projectId: row.project_id,
    proposalKey: row.proposal_key,
    stage: row.state.stage,
    nodeIds: [...row.state.nodeIds],
    nodeNames: [...row.state.nodeNames],
    nodes: (row.state.charges ?? []).map(({ nodeId, model, quantity, unitMultiplier }) => ({
      nodeId,
      model,
      quantity,
      unitMultiplier,
    })),
    bindings: row.state.bindings,
  })
  expect(again.id).toBe(proposal.authorizationId)
  await expect(
    proposeStageAuthorization({
      userId: 'stage-owner',
      conversationId: row.conversation_id,
      projectId: row.project_id,
      proposalKey: row.proposal_key,
      stage: row.state.stage,
      nodeIds: ['b'],
      nodeNames: ['树'],
      nodes: [{ nodeId: 'b', model: 'gpt-image-2.5-flare', quantity: 1, unitMultiplier: 1 }],
      bindings: row.state.bindings.map((binding) => ({ ...binding, nodeId: 'b' })),
    }),
  ).rejects.toThrow('stage_authorization_conflict')
  await expect(
    proposeStageAuthorization({
      userId: 'stage-owner',
      conversationId: row.conversation_id,
      projectId: row.project_id,
      proposalKey: row.proposal_key,
      stage: row.state.stage,
      nodeIds: [...row.state.nodeIds],
      nodeNames: [...row.state.nodeNames],
      nodes: (row.state.charges ?? []).map(({ nodeId, model, unitMultiplier }) => ({
        nodeId,
        model,
        quantity: 2,
        unitMultiplier,
      })),
      bindings: row.state.bindings,
    }),
  ).rejects.toThrow('stage_authorization_conflict')
  await expect(
    proposeStageAuthorization({
      userId: 'stage-owner',
      conversationId: row.conversation_id,
      projectId: row.project_id,
      proposalKey: row.proposal_key,
      stage: '另一阶段',
      nodeIds: [...row.state.nodeIds],
      nodeNames: ['别的名字'],
      nodes: (row.state.charges ?? []).map(({ nodeId, model, quantity, unitMultiplier }) => ({
        nodeId,
        model,
        quantity,
        unitMultiplier,
      })),
      bindings: row.state.bindings,
    }),
  ).rejects.toThrow('stage_authorization_conflict')
  const binding = row.state.bindings[0]
  if (!binding) throw new Error('missing binding')
  await expect(
    proposeStageAuthorization({
      userId: 'stage-owner',
      conversationId: row.conversation_id,
      projectId: row.project_id,
      proposalKey: `${row.proposal_key}:duplicate`,
      stage: row.state.stage,
      nodeIds: ['a', 'a'],
      nodeNames: ['嫩芽', '嫩芽'],
      nodes: [
        { nodeId: 'a', model: 'gpt-image-2.5-flare', quantity: 1, unitMultiplier: 1 },
        { nodeId: 'a', model: 'gpt-image-2.5-flare', quantity: 1, unitMultiplier: 1 },
      ],
      bindings: [binding, { ...binding, nodeId: 'b' }],
    }),
  ).rejects.toThrow('stage_authorization_scope')
  const otherConversation = crypto.randomUUID()
  const now = Date.now()
  await db.insert(schema.agent_conversations).values({
    id: otherConversation,
    user_id: 'stage-owner',
    title: '另一会话',
    created_at: now,
    updated_at: now,
  })
  await expect(
    proposeStageAuthorization({
      userId: 'stage-owner',
      conversationId: otherConversation,
      projectId: row.project_id,
      proposalKey: 'other-project',
      stage: '素材',
      nodeIds: ['a'],
      nodeNames: ['嫩芽'],
      nodes: [{ nodeId: 'a', model: 'gpt-image-2.5-flare', quantity: 1, unitMultiplier: 1 }],
      bindings: row.state.bindings,
    }),
  ).rejects.toThrow('stage_authorization_scope')
  await db.insert(schema.users).values({
    id: 'stage-other',
    username: 'stage-other',
    password_hash: 'unused',
    status: 'active',
    created_at: now,
    updated_at: now,
  })
  let foreignKeyRejected = false
  try {
    await db.insert(schema.agent_stage_authorizations).values({
      id: 'cross-user-stage',
      user_id: 'stage-other',
      conversation_id: row.conversation_id,
      project_id: row.project_id,
      proposal_key: 'cross-user',
      state: row.state,
      created_at: now,
      updated_at: now,
    })
  } catch (error) {
    foreignKeyRejected = true
    const cause = error instanceof Error ? error.cause : undefined
    const text = `${error instanceof Error ? error.message : String(error)}\n${cause instanceof Error ? cause.message : String(cause ?? '')}`
    expect(text).toMatch(/foreign key|23503/i)
  }
  expect(foreignKeyRejected).toBe(true)
  expect(await (await request(proposal.authorizationId)).json()).toMatchObject({
    status: 'pending',
    nodeIds: ['a'],
  })
})

it('submits an authorized image and a fractional reference video through confirm, preflight and consume', async () => {
  const { InMemoryObjectStore } = await import('../helpers/inMemoryObjectStore')
  const { setObjectStoreForTesting } = await import('../../lib/objectStore')
  const { getChannels, _setChannelsForTesting } = await import('../../lib/channels')
  const store = new InMemoryObjectStore()
  setObjectStoreForTesting(store)
  const savedChannels = getChannels()
  const now = Date.now()
  const sharedMedia = crypto.randomUUID()
  const uploadedMedia = crypto.randomUUID()
  const referenceMedia = crypto.randomUUID()
  const readyMedia = (id: string, sha256: string) =>
    db.insert(schema.media_objects).values({
      id,
      user_id: 'stage-owner',
      sha256,
      bytes: 8,
      content_type: 'image/png',
      status: 'ready',
      reserved_bytes: 8,
      staging_key: `staging/${id}`,
      object_key: `media/${id}`,
      width: 1,
      height: 1,
      expires_at: now + 86_400_000,
      created_at: now,
      updated_at: now,
    })
  await readyMedia(sharedMedia, 'a'.repeat(64))
  await readyMedia(uploadedMedia, 'b'.repeat(64))
  await readyMedia(referenceMedia, 'c'.repeat(64))
  const cloudFile = (id: string) => `cloud-${id}`
  try {
    const image = await fixture(['a', 'b', 'out'], undefined, async ({ projectId }) => {
      await accessCanvasDocument('stage-owner', projectId, async (current) => {
        const doc = new Y.Doc()
        Y.applyUpdate(doc, Y.encodeStateAsUpdate(current))
        const vector = Y.encodeStateVector(doc)
        const origin = canvasOrigin('system', 'fixture')
        for (const id of ['a', 'b']) {
          const node = readCanvasDocument(doc).nodes.find((item) => item.id === id)
          if (!node || node.type !== 'image') throw new Error(`missing ${id}`)
          updateCanvasNode(
            doc,
            id,
            { data: { ...node.data, mediaId: sharedMedia, fileId: cloudFile(sharedMedia) } },
            origin,
          )
        }
        insertCanvasNode(
          doc,
          {
            id: 'upload',
            type: 'image',
            x: 0,
            y: 0,
            width: 320,
            height: 240,
            data: { name: '上传', mediaId: uploadedMedia, fileId: cloudFile(uploadedMedia) },
          },
          origin,
        )
        insertCanvasNode(
          doc,
          {
            id: 'out',
            type: 'image',
            x: 40,
            y: 0,
            width: 320,
            height: 240,
            data: { name: '成片', meta: { nodePrompt: '成片' } },
          },
          origin,
        )
        connectCanvasNodes(doc, { source: 'a', target: 'out' }, origin)
        connectCanvasNodes(doc, { source: 'b', target: 'out' }, origin)
        connectCanvasNodes(doc, { source: 'upload', target: 'out' }, origin)
        const update = Y.encodeStateAsUpdate(doc, vector)
        doc.destroy()
        return update
      })
    })
    const imageState = await (await request(image.authorizationId)).json()
    const imageBinding = imageState.bindings.find(
      (binding: { nodeId: string }) => binding.nodeId === 'out',
    )
    expect(imageBinding).toMatchObject({ kind: 'image', prompt: '成片', inputCount: 3 })
    const { executionToken: imageToken } = await (
      await request(image.authorizationId, '/confirm', {})
    ).json()
    expect(
      (
        await request(image.authorizationId, '/preflight', {
          nodeId: 'out',
          model: 'gpt-image-2.5-flare',
          quantity: 1,
          unitMultiplier: 1,
          executionToken: imageToken,
          attemptId: 'image-happy',
        })
      ).status,
    ).toBe(200)
    const imageSubmit = await queueSubmit({
      prompt: '成片',
      device_id: 'stage-test-device',
      client_request_id: crypto.randomUUID(),
      input_images: [PIXEL, PIXEL, PIXEL],
      stage_authorization: {
        authorizationId: image.authorizationId,
        executionToken: imageToken,
        attemptId: 'image-happy',
        nodeId: 'out',
      },
    })
    expect(imageSubmit.status).toBe(200)
    expect(await (await request(image.authorizationId)).json()).toMatchObject({
      spentCredits: 6,
      attempts: [{ nodeId: 'out', taskIds: [expect.any(String)], submittedQuantity: 1 }],
    })

    const video = await fixture(['clip'], undefined, async ({ projectId }) => {
      const [project] = await db
        .select({ conversationId: schema.canvas_projects.conversation_id })
        .from(schema.canvas_projects)
        .where(eq(schema.canvas_projects.id, projectId))
      if (!project?.conversationId) throw new Error('missing conversation')
      await createNodes
        .create({
          mode: 'image' as const,
          experience: 'canvas' as const,
          conversationId: project.conversationId,
          turnId: 'turn',
          deviceId: 'stage-device',
          userId: 'stage-owner',
          canvas: { selectedNodeIds: [], elements: [] },
          images: createAgentImageSource({
            references: [],
            history: [],
            conversationId: project.conversationId,
            userId: 'stage-owner',
          }),
        })
        .execute(
          'video',
          { nodes: [{ id: 'clip', type: 'video', prompt: '海浪', videoMode: 'reference' }] },
          undefined,
          undefined,
        )
      await accessCanvasDocument('stage-owner', projectId, async (current) => {
        const doc = new Y.Doc()
        Y.applyUpdate(doc, Y.encodeStateAsUpdate(current))
        const vector = Y.encodeStateVector(doc)
        const origin = canvasOrigin('system', 'fixture')
        const clip = readCanvasDocument(doc).nodes.find((item) => item.id === 'clip')
        if (!clip || clip.type !== 'image') throw new Error('missing clip')
        updateCanvasNode(
          doc,
          'clip',
          {
            data: {
              ...clip.data,
              meta: {
                ...clip.data.meta,
                nodeVideoMode: 'reference',
                nodeVideoDraft: JSON.stringify({
                  model: 'grok-imagine-video',
                  duration: 1.9,
                  resolution: '720p',
                  aspectRatio: '16:9',
                }),
              },
            },
          },
          origin,
        )
        for (const id of ['ref-a', 'ref-b']) {
          insertCanvasNode(
            doc,
            {
              id,
              type: 'image',
              x: 0,
              y: 0,
              width: 200,
              height: 200,
              data: { name: id, mediaId: referenceMedia, fileId: cloudFile(referenceMedia) },
            },
            origin,
          )
          connectCanvasNodes(doc, { source: id, target: 'clip' }, origin)
        }
        const update = Y.encodeStateAsUpdate(doc, vector)
        doc.destroy()
        return update
      })
    })
    const videoState = await (await request(video.authorizationId)).json()
    const videoBinding = videoState.bindings.find(
      (binding: { nodeId: string }) => binding.nodeId === 'clip',
    )
    expect(videoBinding).toMatchObject({
      kind: 'video',
      prompt: '海浪',
      inputCount: 1,
      video: { durationSeconds: 5, resolution: '720p', aspectRatio: '16:9' },
    })
    const { executionToken: videoToken } = await (
      await request(video.authorizationId, '/confirm', {})
    ).json()
    expect(
      (
        await request(video.authorizationId, '/preflight', {
          nodeId: 'clip',
          model: 'grok-imagine-video',
          quantity: 5,
          unitMultiplier: 1,
          executionToken: videoToken,
          attemptId: 'video-happy',
        })
      ).status,
    ).toBe(200)
    const sample = savedChannels[0]
    const sampleModel = sample?.models[0]
    if (!sample || !sampleModel) throw new Error('missing channel')
    _setChannelsForTesting([
      ...savedChannels,
      {
        ...sample,
        id: `${sample.id}-stage-reference`,
        models: [{ ...sampleModel, id: 'grok-imagine-video', label: 'Grok', media: 'video' }],
      },
    ])
    const videoSubmit = await app.handle(
      new Request('http://localhost/v1/queue/openai-compat/grok-imagine-video/submit', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt: '海浪',
          device_id: 'stage-test-device',
          client_request_id: crypto.randomUUID(),
          input_images: [PIXEL],
          video: {
            duration_seconds: 1.9,
            aspect_ratio: '16:9',
            resolution: '720p',
            reference_image_indices: [0],
          },
          stage_authorization: {
            authorizationId: video.authorizationId,
            executionToken: videoToken,
            attemptId: 'video-happy',
            nodeId: 'clip',
          },
        }),
      }),
    )
    expect(videoSubmit.status).toBe(200)
    const accepted = await videoSubmit.json()
    const [task] = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, accepted.request_id))
    expect(task?.request_payload).toMatchObject({
      prompt: '海浪',
      video: { duration_seconds: 5, resolution: '720p', aspect_ratio: '16:9' },
    })
    expect(task?.request_payload.input_images).toHaveLength(1)
    expect(await (await request(video.authorizationId)).json()).toMatchObject({
      spentCredits: 6,
      attempts: [{ nodeId: 'clip', submittedQuantity: 5, taskIds: [accepted.request_id] }],
    })
  } finally {
    _setChannelsForTesting(savedChannels)
    setObjectStoreForTesting()
  }
})

it('ends active stage authorizations when the user logs out', async () => {
  const proposal = await fixture()
  const second = await fixture()
  const { executionToken } = await (await request(proposal.authorizationId, '/confirm', {})).json()
  expect(executionToken).toEqual(expect.any(String))
  await (await request(second.authorizationId, '/confirm', {})).json()
  const staleAt = Date.now() - STAGE_AUTHORIZATION_ACTIVE_TTL_MS - 5_000
  const [fresh] = await db
    .select()
    .from(schema.agent_stage_authorizations)
    .where(eq(schema.agent_stage_authorizations.id, proposal.authorizationId))
  if (!fresh) throw new Error('missing authorization')
  await db
    .update(schema.agent_stage_authorizations)
    .set({
      updated_at: staleAt,
      state: {
        ...fresh.state,
        audit: fresh.state.audit.map((event) =>
          event.kind === 'confirmed' ? { ...event, at: staleAt } : event,
        ),
      },
    })
    .where(eq(schema.agent_stage_authorizations.id, proposal.authorizationId))
  const token = await db.transaction((tx) => createUserSession('stage-owner', tx))
  const logout = await app.handle(
    new Request('http://localhost/api/auth/logout', {
      method: 'POST',
      headers: { cookie: `${USER_SESSION_COOKIE}=${token}` },
    }),
  )
  expect(logout.status).toBe(200)
  const [expired] = await db
    .select()
    .from(schema.agent_stage_authorizations)
    .where(eq(schema.agent_stage_authorizations.id, proposal.authorizationId))
  const [ended] = await db
    .select()
    .from(schema.agent_stage_authorizations)
    .where(eq(schema.agent_stage_authorizations.id, second.authorizationId))
  expect(expired?.state.status).toBe('expired')
  expect(ended?.state.status).toBe('ended')
  expect(
    await db
      .select({ token_hash: schema.user_sessions.token_hash })
      .from(schema.user_sessions)
      .where(eq(schema.user_sessions.token_hash, hashSessionToken(token))),
  ).toHaveLength(0)
  expect((await request(proposal.authorizationId)).status).toBe(200)

  const disabled = await fixture()
  await (await request(disabled.authorizationId, '/confirm', {})).json()
  await db
    .update(schema.users)
    .set({ status: 'disabled' })
    .where(eq(schema.users.id, 'stage-owner'))
  const disabledToken = await db.transaction((tx) => createUserSession('stage-owner', tx))
  const disabledLogout = await app.handle(
    new Request('http://localhost/api/auth/logout', {
      method: 'POST',
      headers: { cookie: `${USER_SESSION_COOKIE}=${disabledToken}` },
    }),
  )
  expect(disabledLogout.status).toBe(200)
  const [disabledRow] = await db
    .select()
    .from(schema.agent_stage_authorizations)
    .where(eq(schema.agent_stage_authorizations.id, disabled.authorizationId))
  expect(disabledRow?.state.status).toBe('ended')
  expect(
    await db
      .select({ token_hash: schema.user_sessions.token_hash })
      .from(schema.user_sessions)
      .where(eq(schema.user_sessions.token_hash, hashSessionToken(disabledToken))),
  ).toHaveLength(0)
})

it('revokes the session when stage reclaim fails during logout', async () => {
  const token = await db.transaction((tx) => createUserSession('stage-owner', tx))
  const { log } = await import('../../lib/logger')
  const warnings: unknown[] = []
  const original = log.warn.bind(log)
  log.warn = ((...args: unknown[]) => {
    warnings.push(args)
  }) as typeof log.warn
  let cleared = false
  try {
    await finishLogout(
      token,
      () => {
        cleared = true
      },
      async () => {
        throw new Error('reclaim failed')
      },
    )
  } finally {
    log.warn = original as typeof log.warn
  }
  expect(cleared).toBe(true)
  expect(warnings.length).toBeGreaterThan(0)
  const sessions = await db
    .select({ token_hash: schema.user_sessions.token_hash })
    .from(schema.user_sessions)
    .where(eq(schema.user_sessions.token_hash, hashSessionToken(token)))
  expect(sessions).toHaveLength(0)
})

it('reclaims authorizations before dropping a disabled session, including when login is off', async () => {
  await db.update(schema.users).set({ status: 'active' }).where(eq(schema.users.id, 'stage-owner'))
  const pending = await fixture()
  await db
    .update(schema.users)
    .set({ status: 'disabled' })
    .where(eq(schema.users.id, 'stage-owner'))
  const token = await db.transaction((tx) => createUserSession('stage-owner', tx))
  const me = await app.handle(
    new Request('http://localhost/api/auth/me', {
      headers: { cookie: `${USER_SESSION_COOKIE}=${token}` },
    }),
  )
  expect(me.status).toBe(401)
  const [dropped] = await db
    .select()
    .from(schema.agent_stage_authorizations)
    .where(eq(schema.agent_stage_authorizations.id, pending.authorizationId))
  expect(dropped?.state.status).toBe('ended')
  expect(
    await db
      .select({ token_hash: schema.user_sessions.token_hash })
      .from(schema.user_sessions)
      .where(eq(schema.user_sessions.token_hash, hashSessionToken(token))),
  ).toHaveLength(0)

  await db.update(schema.users).set({ status: 'active' }).where(eq(schema.users.id, 'stage-owner'))
  const gated = await fixture()
  await db
    .update(schema.users)
    .set({ status: 'disabled' })
    .where(eq(schema.users.id, 'stage-owner'))
  const gatedToken = await db.transaction((tx) => createUserSession('stage-owner', tx))
  const previous = config.operator.capabilities['accounts:login']
  Object.assign(config.operator.capabilities, { 'accounts:login': false })
  try {
    const logout = await app.handle(
      new Request('http://localhost/api/auth/logout', {
        method: 'POST',
        headers: { cookie: `${USER_SESSION_COOKIE}=${gatedToken}` },
      }),
    )
    expect(logout.status).toBe(200)
  } finally {
    Object.assign(config.operator.capabilities, { 'accounts:login': previous })
    await db
      .update(schema.users)
      .set({ status: 'active' })
      .where(eq(schema.users.id, 'stage-owner'))
  }
  const [ended] = await db
    .select()
    .from(schema.agent_stage_authorizations)
    .where(eq(schema.agent_stage_authorizations.id, gated.authorizationId))
  expect(ended?.state.status).toBe('ended')
  expect(
    await db
      .select({ token_hash: schema.user_sessions.token_hash })
      .from(schema.user_sessions)
      .where(eq(schema.user_sessions.token_hash, hashSessionToken(gatedToken))),
  ).toHaveLength(0)
})
