import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { eq } from 'drizzle-orm'
import { InMemoryObjectStore } from '../../helpers/inMemoryObjectStore'

const TEST_DB = await resetTestDatabase('bff_task_submission_plugins')

process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'test'
process.env.DATABASE_URL = TEST_DB
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../../projects-operator-config.json')

const { close: closeDb, db, schema } = await import('../../../db/client')
const { setObjectStoreForTesting } = await import('../../../lib/objectStore')
const { _setPrivateBffOverlayForTesting, EMPTY_PRIVATE_BFF_OVERLAY } = await import(
  '../../../lib/private-overlay'
)
const {
  _resetTaskSubmissionPluginsForTesting,
  createQueueTask,
  listTaskSubmissionPluginIds,
  MissingTaskSubmissionPluginError,
  registerTaskSubmissionPlugin,
} = await import('../../../modules/execution')
const { registerDefaultTaskSubmissionPlugins } = await import('../../../bootstrap/task-submission')

type TaskSubmissionPlugin = import('../../../modules/execution').TaskSubmissionPlugin

let store: InMemoryObjectStore

beforeEach(async () => {
  store = new InMemoryObjectStore()
  setObjectStoreForTesting(store)
  _resetTaskSubmissionPluginsForTesting()
  _setPrivateBffOverlayForTesting(EMPTY_PRIVATE_BFF_OVERLAY)
  await db.delete(schema.tasks)
})

afterEach(() => {
  _resetTaskSubmissionPluginsForTesting()
  registerDefaultTaskSubmissionPlugins()
  _setPrivateBffOverlayForTesting()
  setObjectStoreForTesting()
})

afterAll(async () => {
  await closeDb()
})

describe('TaskSubmissionPlugin registration', () => {
  it('registers default submission plugins in deterministic order and stays idempotent', () => {
    registerDefaultTaskSubmissionPlugins()
    registerDefaultTaskSubmissionPlugins()

    expect(listTaskSubmissionPluginIds()).toEqual([
      'masked-input',
      'stage-authorization',
      'project-archive',
      'agent-job',
    ])
  })

  it('rejects conflicting definitions with the same id and supports disposal', () => {
    const first: TaskSubmissionPlugin = { id: 'custom-submit' }
    const dispose = registerTaskSubmissionPlugin(first)
    expect(registerTaskSubmissionPlugin(first)).toBeTypeOf('function')
    expect(listTaskSubmissionPluginIds()).toEqual(['custom-submit'])

    const conflicting: TaskSubmissionPlugin = { id: 'custom-submit' }
    expect(() => registerTaskSubmissionPlugin(conflicting)).toThrow(
      'Conflicting task submission plugin registration for id: custom-submit',
    )

    dispose()
    expect(listTaskSubmissionPluginIds()).toEqual([])
    registerTaskSubmissionPlugin(conflicting)
    expect(listTaskSubmissionPluginIds()).toEqual(['custom-submit'])
  })
})

describe('TaskSubmissionPlugin fail-closed guards & transaction atomicity', () => {
  it('fails closed when a masked submission runs without masked-input plugin (not swallowed as storage error)', async () => {
    await expect(
      createQueueTask({
        entry: 'web-direct',
        provider: 'openai-compat',
        model: 'gpt-image-2.5-flare',
        userId: null,
        request: {
          prompt: 'masked edit',
          input_images: ['data:image/png;base64,AAAA'],
          mask: 'data:image/png;base64,BBBB',
        },
      }),
    ).rejects.toThrow(MissingTaskSubmissionPluginError)
  })

  it('fails closed when stageAuthorization, agent.job, or synced project archive runs without its plugin', async () => {
    await expect(
      createQueueTask({
        entry: 'agent',
        provider: 'openai-compat',
        model: 'gpt-image-2.5-flare',
        userId: 'u-1',
        stageAuthorization: {
          authorizationId: 'auth-1',
          attemptId: 'att-1',
          nodeId: 'node-1',
          executionToken: 'exec-token-1',
        },
        request: { prompt: 'stage job' },
      }),
    ).rejects.toThrow('Missing required task submission plugin: stage-authorization')

    await expect(
      createQueueTask({
        entry: 'agent',
        provider: 'openai-compat',
        model: 'gpt-image-2.5-flare',
        userId: null,
        agent: {
          conversationId: 'conv-1',
          turnId: 'turn-1',
          job: { toolCallId: 'call-1', wakeOnSuccess: true },
        },
        request: { prompt: 'agent job' },
      }),
    ).rejects.toThrow('Missing required task submission plugin: agent-job')

    await expect(
      createQueueTask({
        entry: 'agent',
        provider: 'openai-compat',
        model: 'gpt-image-2.5-flare',
        userId: 'u-1',
        agent: {
          conversationId: 'conv-1',
          turnId: 'turn-1',
        },
        request: { prompt: 'synced project job' },
      }),
    ).rejects.toThrow('Missing required task submission plugin: project-archive')
  })

  it('executes transformInput -> beforeAdmission -> afterTaskCreated in order and rolls back on plugin error', async () => {
    const order: string[] = []
    registerTaskSubmissionPlugin({
      id: 'trace-plugin',
      async transformInput(input) {
        order.push(`transform:${input.request.prompt}`)
        return {
          request: { ...input.request, prompt: `${input.request.prompt} (transformed)` },
        }
      },
      async beforeAdmission(_tx, input) {
        order.push(`before:${input.request.prompt}`)
      },
      async afterTaskCreated(_tx, ctx) {
        order.push(`after:${ctx.taskId}:${ctx.requestPayload.prompt}`)
      },
    })

    const created = await createQueueTask({
      entry: 'web-direct',
      provider: 'openai-compat',
      model: 'gpt-image-2.5-flare',
      userId: null,
      request: { prompt: 'hello' },
    })
    expect(created.kind).toBe('created')
    if (created.kind !== 'created') return
    expect(order).toEqual([
      'transform:hello',
      'before:hello',
      `after:${created.taskId}:hello (transformed)`,
    ])

    // Throwing in afterTaskCreated must roll back the inserted task row.
    registerTaskSubmissionPlugin({
      id: 'failing-after',
      async afterTaskCreated() {
        throw new Error('plugin rollback boom')
      },
    })
    const beforeCount = (await db.select().from(schema.tasks)).length
    await expect(
      createQueueTask({
        entry: 'web-direct',
        provider: 'openai-compat',
        model: 'gpt-image-2.5-flare',
        userId: null,
        request: { prompt: 'rollback me' },
      }),
    ).rejects.toThrow('plugin rollback boom')
    const afterRows = await db.select().from(schema.tasks)
    expect(afterRows).toHaveLength(beforeCount)
    expect(afterRows.every((row) => row.id === created.taskId)).toBe(true)
    const [persisted] = await db
      .select({ prompt: schema.task_payloads.request_payload })
      .from(schema.task_payloads)
      .where(eq(schema.task_payloads.task_id, created.taskId))
    expect(persisted?.prompt.prompt).toBe('hello (transformed)')
  })
})
