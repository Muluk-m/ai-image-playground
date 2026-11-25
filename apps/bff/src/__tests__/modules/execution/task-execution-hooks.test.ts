import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { insertTestTasks, resetTestDatabase } from '@image-playground/db/testing'
import { eq } from 'drizzle-orm'
import { InMemoryObjectStore } from '../../helpers/inMemoryObjectStore'
import { recordingUpstreamFetch } from '../../helpers/upstreamStubs'

const TEST_DB = await resetTestDatabase('bff_task_execution_hooks')

process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'test'
process.env.DATABASE_URL = TEST_DB
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../../projects-operator-config.json')

await import('../../../bootstrap/task-lifecycle')
const { registerDefaultTaskExecutionHooks } = await import('../../../bootstrap/task-execution')
const { close: closeDb, db, schema } = await import('../../../db/client')
const { setObjectStoreForTesting } = await import('../../../lib/objectStore')
const { _setPrivateBffOverlayForTesting, EMPTY_PRIVATE_BFF_OVERLAY } = await import(
  '../../../lib/private-overlay'
)
const { setUpstreamFetchForTesting } = await import('../../../lib/upstream')
const { AgentContextOverflow } = await import('../../../lib/agent/request-budget')
const { MaskedOutputError } = await import('../../../lib/agent/masked-output')
const { AgentToolError } = await import('../../../lib/agent/tools/errors')
const { classifyAnalysisPreparationError } = await import('../../../lib/analysis-tasks')
const {
  _resetTaskExecutionHooksForTesting,
  getAgentBatchAdvancer,
  getMaskedEditExecutionHook,
  listTaskExecutionHookIds,
  MissingTaskExecutionHookError,
  registerAgentBatchAdvancer,
  registerMaskedEditExecutionHook,
} = await import('../../../modules/execution')
const { AgentBatchLoop } = await import('../../../workers/agent-batch-loop')
const { runTask } = await import('../../../workers/task-runner')

type MaskedEditExecutionHook = import('../../../modules/execution').MaskedEditExecutionHook

let store: InMemoryObjectStore

beforeEach(async () => {
  store = new InMemoryObjectStore()
  setObjectStoreForTesting(store)
  _resetTaskExecutionHooksForTesting()
  _setPrivateBffOverlayForTesting(EMPTY_PRIVATE_BFF_OVERLAY)
  await db.delete(schema.tasks)
})

afterEach(() => {
  _resetTaskExecutionHooksForTesting()
  registerDefaultTaskExecutionHooks()
  setUpstreamFetchForTesting()
  _setPrivateBffOverlayForTesting()
  setObjectStoreForTesting()
})

afterAll(async () => {
  await closeDb()
})

describe('TaskExecutionHooks registration', () => {
  it('registers default hooks idempotently and rejects conflicting replacements', () => {
    registerDefaultTaskExecutionHooks()
    registerDefaultTaskExecutionHooks()
    expect(listTaskExecutionHookIds()).toEqual(['masked-edit', 'agent-batch'])

    const duplicateMasked: MaskedEditExecutionHook = {
      protectMaskedOutput: async () => {
        throw new Error('unexpected')
      },
      cropMaskedUpstream: async () => ({ input_images: [] }),
      isMaskedOutputError: () => false,
    }
    expect(() => registerMaskedEditExecutionHook(duplicateMasked)).toThrow(
      'Task execution hook "masked-edit" is already registered',
    )
    expect(() => registerAgentBatchAdvancer(async () => null)).toThrow(
      'Task execution hook "agent-batch" is already registered',
    )
  })

  it('disposes only the matching hook registration', () => {
    const customHook: MaskedEditExecutionHook = {
      protectMaskedOutput: async () => {
        throw new Error('unexpected')
      },
      cropMaskedUpstream: async () => ({ input_images: [] }),
      isMaskedOutputError: () => false,
    }
    const disposeMasked = registerMaskedEditExecutionHook(customHook)
    const disposeBatch = registerAgentBatchAdvancer(async () => null)
    expect(listTaskExecutionHookIds()).toEqual(['masked-edit', 'agent-batch'])

    disposeMasked()
    expect(listTaskExecutionHookIds()).toEqual(['agent-batch'])
    disposeBatch()
    expect(listTaskExecutionHookIds()).toEqual([])
  })

  it('recognizes MaskedOutputError synchronously before protectMaskedOutput is loaded', () => {
    registerDefaultTaskExecutionHooks()
    const hook = getMaskedEditExecutionHook()
    expect(hook.isMaskedOutputError(new MaskedOutputError('invalid mask'))).toBe(true)
    expect(hook.isMaskedOutputError(new Error('plain error'))).toBe(false)
    expect(hook.isMaskedOutputError('not-an-error')).toBe(false)
  })
})

describe('TaskExecutionHooks fail-closed enforcement', () => {
  it('throws MissingTaskExecutionHookError when hooks are absent', () => {
    expect(() => getMaskedEditExecutionHook()).toThrow(MissingTaskExecutionHookError)
    expect(() => getAgentBatchAdvancer()).toThrow(MissingTaskExecutionHookError)
    try {
      getMaskedEditExecutionHook()
    } catch (error) {
      expect(error).toBeInstanceOf(MissingTaskExecutionHookError)
      expect((error as InstanceType<typeof MissingTaskExecutionHookError>).hookId).toBe(
        'masked-edit',
      )
    }
  })

  it('fails closed in AgentBatchLoop constructor without an explicit advance callback', () => {
    expect(() => new AgentBatchLoop()).toThrow(MissingTaskExecutionHookError)

    const loop = new AgentBatchLoop({ advance: async () => null })
    expect(loop.isIdle()).toBe(true)
  })

  it('fails closed in runTask before calling upstream when masked-edit hook is missing', async () => {
    const upstream = recordingUpstreamFetch()
    setUpstreamFetchForTesting(upstream.fetch)

    await insertTestTasks(db, [
      {
        id: 'masked-no-hook',
        provider: 'openai-compat',
        model: 'test-model',
        status: 'queued',
        submitted_at: 1,
        request_payload: {
          prompt: 'edit mask',
          preserve_outside_mask: true,
        },
      },
      {
        id: 'crop-no-hook',
        provider: 'openai-compat',
        model: 'test-model',
        status: 'queued',
        submitted_at: 2,
        request_payload: {
          prompt: 'crop edit',
          masked_crop: { left: 0, top: 0, width: 64, height: 64 },
        },
      },
    ])

    await expect(runTask('masked-no-hook')).rejects.toThrow(MissingTaskExecutionHookError)
    await expect(runTask('crop-no-hook')).rejects.toThrow(MissingTaskExecutionHookError)
    expect(upstream.calls).toEqual([])

    const [maskedRow] = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, 'masked-no-hook'))
    const [cropRow] = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, 'crop-no-hook'))
    expect(maskedRow?.status).toBe('failed')
    expect(maskedRow?.error_type).toBe('interrupted')
    expect(cropRow?.status).toBe('failed')
    expect(cropRow?.error_type).toBe('interrupted')
  })
})

describe('classifyAnalysisPreparationError', () => {
  it('classifies overflow, tool errors, known preparation codes, cancellation, and fallback', () => {
    expect(classifyAnalysisPreparationError(new AgentContextOverflow(200, 100), false)).toBe(
      'context_overflow',
    )
    expect(
      classifyAnalysisPreparationError(new AgentToolError('quota_exceeded', 'too large'), false),
    ).toBe('quota_exceeded')
    for (const code of [
      'analysis_input_changed',
      'analysis_output_budget_invalid',
      'analysis_inputs_invalid',
      'analysis_visual_evidence_missing',
      'analysis_lease_lost',
    ]) {
      expect(classifyAnalysisPreparationError(new Error(code), false)).toBe(code)
    }
    expect(classifyAnalysisPreparationError(new Error('unexpected'), true)).toBe(
      'analysis_cancelled',
    )
    expect(classifyAnalysisPreparationError(new Error('unexpected'), false)).toBe(
      'analysis_preparation_failed',
    )
  })
})
