import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { insertTestTasks, resetTestDatabase } from '@image-playground/db/testing'
import { eq } from 'drizzle-orm'

const TEST_DB = await resetTestDatabase('bff_task_lifecycle_bus')

process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'test'
process.env.DATABASE_URL = TEST_DB
process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-alpha'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../../quota-operator-config.json')

const { close: closeDb, db, schema } = await import('../../../db/client')
const { _setPrivateBffOverlayForTesting, EMPTY_PRIVATE_BFF_OVERLAY } = await import(
  '../../../lib/private-overlay'
)
const {
  _resetTaskLifecycleListenersForTesting,
  cancelTasks,
  finishTask,
  heldBy,
  listTaskLifecycleListenerIds,
  MissingTaskLifecycleListenerError,
  registerTaskLifecycleListener,
} = await import('../../../modules/execution')
const { registerDefaultTaskLifecycleListeners } = await import('../../../bootstrap/task-lifecycle')

type TaskLifecycleListener = import('../../../modules/execution').TaskLifecycleListener

const WORKER_TOKEN = 'lifecycle-bus-worker'

async function insertTask(
  id: string,
  status: 'queued' | 'in_progress',
  metering?: { mode: 'credits' | 'none'; model: string; quantity: number; unitMultiplier: number },
) {
  await insertTestTasks(db, {
    id,
    provider: 'openai-compat',
    model: 'gpt-image-2',
    status,
    ...(status === 'in_progress'
      ? { execution_token: WORKER_TOKEN, lease_expires_at: Date.now() + 60_000 }
      : {}),
    ...(metering ? { metering } : {}),
    request_payload: { prompt: 'lifecycle fixture', device_id: 'lifecycle-device' },
    submitted_at: Date.now(),
    upstream_invocation_count: 1,
  })
}

beforeEach(async () => {
  _resetTaskLifecycleListenersForTesting()
  _setPrivateBffOverlayForTesting(EMPTY_PRIVATE_BFF_OVERLAY)
  await db.delete(schema.tasks)
})

afterEach(() => {
  _resetTaskLifecycleListenersForTesting()
  registerDefaultTaskLifecycleListeners()
  _setPrivateBffOverlayForTesting()
})

afterAll(async () => {
  await closeDb()
})

describe('TaskLifecycleBus registration', () => {
  it('registers default listeners in lock-preserving stage order and stays idempotent', () => {
    registerDefaultTaskLifecycleListeners()
    registerDefaultTaskLifecycleListeners()

    expect(listTaskLifecycleListenerIds('before-settlement')).toEqual([
      'generation-media',
      'project-archive',
    ])
    expect(listTaskLifecycleListenerIds('settlement')).toEqual(['billing-settlement'])
    expect(listTaskLifecycleListenerIds('after-settlement')).toEqual([
      'model-availability',
      'agent-wake',
      'agent-job-settlement',
    ])
  })

  it('rejects conflicting definitions with the same id and supports disposal', () => {
    const first: TaskLifecycleListener = { id: 'custom-hook', stage: 'before-settlement' }
    const duplicateSameRef = registerTaskLifecycleListener(first)
    expect(registerTaskLifecycleListener(first)).toBeTypeOf('function')
    expect(listTaskLifecycleListenerIds()).toEqual(['custom-hook'])

    const conflicting: TaskLifecycleListener = { id: 'custom-hook', stage: 'after-settlement' }
    expect(() => registerTaskLifecycleListener(conflicting)).toThrow(
      'Conflicting task lifecycle listener registration for id: custom-hook',
    )

    duplicateSameRef()
    expect(listTaskLifecycleListenerIds()).toEqual([])
    registerTaskLifecycleListener(conflicting)
    expect(listTaskLifecycleListenerIds('after-settlement')).toEqual(['custom-hook'])
  })
})

describe('TaskLifecycleBus transactional execution', () => {
  it('runs before-settlement, billing-settlement (finalizeTask), and after-settlement in strict order on finishTask', async () => {
    const order: string[] = []
    _setPrivateBffOverlayForTesting(
      Object.freeze({
        ...EMPTY_PRIVATE_BFF_OVERLAY,
        present: true,
        taskHooks: {
          ...EMPTY_PRIVATE_BFF_OVERLAY.taskHooks,
          async finalizeTask({ taskId }: { taskId: string }) {
            order.push(`finalize:${taskId}`)
          },
        },
      }),
    )
    registerDefaultTaskLifecycleListeners()
    registerTaskLifecycleListener({
      id: 'first-before',
      stage: 'before-settlement',
      async onTaskFinished(_tx, event) {
        order.push(`before-1:${event.taskId}:${event.status}`)
      },
    })
    registerTaskLifecycleListener({
      id: 'second-before',
      stage: 'before-settlement',
      async onTaskFinished(_tx, event) {
        order.push(`before-2:${event.taskId}:${event.model}`)
      },
    })
    registerTaskLifecycleListener({
      id: 'first-after',
      stage: 'after-settlement',
      async onTaskFinished(_tx, event) {
        order.push(`after-1:${event.taskId}`)
      },
    })

    await insertTask('bus-finish-order', 'in_progress')
    const written = await finishTask(
      'bus-finish-order',
      { status: 'completed', completedAt: Date.now() },
      heldBy(WORKER_TOKEN),
    )

    expect(written).toBe(true)
    expect(order).toEqual([
      'before-1:bus-finish-order:completed',
      'before-2:bus-finish-order:gpt-image-2',
      'finalize:bus-finish-order',
      'after-1:bus-finish-order',
    ])
  })

  it('fails closed and rolls back finishTask & cancelTasks when billing-settlement listener is missing', async () => {
    await insertTask('bus-missing-finish', 'in_progress')
    await expect(
      finishTask(
        'bus-missing-finish',
        { status: 'completed', completedAt: Date.now() },
        heldBy(WORKER_TOKEN),
      ),
    ).rejects.toThrow(MissingTaskLifecycleListenerError)

    const [stillRunning] = await db
      .select({ status: schema.tasks.status, completedAt: schema.tasks.completed_at })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, 'bus-missing-finish'))
    expect(stillRunning).toEqual({ status: 'in_progress', completedAt: null })

    await insertTask('bus-missing-cancel', 'queued')
    await expect(cancelTasks(eq(schema.tasks.id, 'bus-missing-cancel'))).rejects.toThrow(
      MissingTaskLifecycleListenerError,
    )

    const [stillQueued] = await db
      .select({ status: schema.tasks.status })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, 'bus-missing-cancel'))
    expect(stillQueued?.status).toBe('queued')
  })

  it('skips billing-settlement stage when task metering mode is none', async () => {
    await insertTask('bus-unmetered-finish', 'in_progress', {
      mode: 'none',
      model: 'gpt-image-2',
      quantity: 1,
      unitMultiplier: 1,
    })
    const finished = await finishTask(
      'bus-unmetered-finish',
      { status: 'completed', completedAt: Date.now() },
      heldBy(WORKER_TOKEN),
    )
    expect(finished).toBe(true)

    await insertTask('bus-unmetered-cancel', 'queued', {
      mode: 'none',
      model: 'gpt-image-2',
      quantity: 1,
      unitMultiplier: 1,
    })
    const cancelled = await cancelTasks(eq(schema.tasks.id, 'bus-unmetered-cancel'))
    expect(cancelled.map((row) => row.id)).toEqual(['bus-unmetered-cancel'])
  })

  it('rolls back the entire finishTask transaction when any listener throws', async () => {
    registerDefaultTaskLifecycleListeners()
    registerTaskLifecycleListener({
      id: 'failing-after',
      stage: 'after-settlement',
      async onTaskFinished() {
        throw new Error('simulated listener failure')
      },
    })

    await insertTask('bus-finish-rollback', 'in_progress')
    await expect(
      finishTask(
        'bus-finish-rollback',
        { status: 'completed', completedAt: Date.now() },
        heldBy(WORKER_TOKEN),
      ),
    ).rejects.toThrow('simulated listener failure')

    const [row] = await db
      .select({ status: schema.tasks.status, completedAt: schema.tasks.completed_at })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, 'bus-finish-rollback'))
    expect(row).toEqual({ status: 'in_progress', completedAt: null })
  })

  it('runs cancelTasks listeners in stage order, skips emission on zero rows, and rolls back on throw', async () => {
    const order: string[] = []
    _setPrivateBffOverlayForTesting(
      Object.freeze({
        ...EMPTY_PRIVATE_BFF_OVERLAY,
        present: true,
        taskHooks: {
          ...EMPTY_PRIVATE_BFF_OVERLAY.taskHooks,
          async finalizeTask({ taskId }: { taskId: string }) {
            order.push(`finalize:${taskId}`)
          },
        },
      }),
    )
    registerDefaultTaskLifecycleListeners()
    registerTaskLifecycleListener({
      id: 'cancel-before',
      stage: 'before-settlement',
      async onTasksCancelled(_tx, event) {
        order.push(
          `before:${event.tasks.map((task) => task.taskId).join(',')}:${event.failedAs ?? 'none'}`,
        )
      },
    })
    registerTaskLifecycleListener({
      id: 'cancel-after',
      stage: 'after-settlement',
      async onTasksCancelled(_tx, event) {
        order.push(`after:${event.tasks.map((task) => task.taskId).join(',')}`)
      },
    })

    // No matching rows -> no listener calls.
    expect(await cancelTasks(eq(schema.tasks.id, 'missing-task'))).toEqual([])
    expect(order).toEqual([])

    await insertTask('bus-cancel-1', 'queued')
    const cancelled = await cancelTasks(eq(schema.tasks.id, 'bus-cancel-1'), {
      failedAs: 'timeout',
    })
    expect(cancelled.map((row) => row.id)).toEqual(['bus-cancel-1'])
    expect(order).toEqual([
      'before:bus-cancel-1:timeout',
      'finalize:bus-cancel-1',
      'after:bus-cancel-1',
    ])

    // Listener failure rolls back status update.
    await insertTask('bus-cancel-rollback', 'queued')
    registerTaskLifecycleListener({
      id: 'cancel-boom',
      stage: 'after-settlement',
      async onTasksCancelled() {
        throw new Error('cancel listener exploded')
      },
    })
    await expect(cancelTasks(eq(schema.tasks.id, 'bus-cancel-rollback'))).rejects.toThrow(
      'cancel listener exploded',
    )
    const [stillQueued] = await db
      .select({ status: schema.tasks.status })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, 'bus-cancel-rollback'))
    expect(stillQueued?.status).toBe('queued')
  })

  it('runs afterTaskFinished and afterTasksCancelled only after commit and isolates listener failures', async () => {
    const events: string[] = []
    registerDefaultTaskLifecycleListeners()
    registerTaskLifecycleListener({
      id: 'post-commit-broken',
      stage: 'after-settlement',
      async afterTaskFinished(event) {
        events.push(`broken-finish:${event.taskId}`)
        throw new Error('post-commit finish boom')
      },
      async afterTasksCancelled(event) {
        events.push(`broken-cancel:${event.tasks.map((task) => task.taskId).join(',')}`)
        throw new Error('post-commit cancel boom')
      },
    })
    registerTaskLifecycleListener({
      id: 'post-commit-observer',
      stage: 'after-settlement',
      async afterTaskFinished(event) {
        events.push(`ok-finish:${event.taskId}:${event.taskKind}`)
      },
      async afterTasksCancelled(event) {
        events.push(`ok-cancel:${event.tasks.map((task) => task.taskId).join(',')}`)
      },
    })

    await insertTask('bus-post-finish', 'in_progress', {
      mode: 'none',
      model: 'gpt-image-2',
      quantity: 1,
      unitMultiplier: 1,
    })
    const finished = await finishTask(
      'bus-post-finish',
      { status: 'completed', completedAt: Date.now() },
      heldBy(WORKER_TOKEN),
    )
    expect(finished).toBe(true)
    expect(events).toEqual(['broken-finish:bus-post-finish', 'ok-finish:bus-post-finish:queue'])

    events.length = 0
    await insertTask('bus-post-cancel', 'queued', {
      mode: 'none',
      model: 'gpt-image-2',
      quantity: 1,
      unitMultiplier: 1,
    })
    const cancelled = await cancelTasks(eq(schema.tasks.id, 'bus-post-cancel'))
    expect(cancelled.map((row) => row.id)).toEqual(['bus-post-cancel'])
    expect(events).toEqual(['broken-cancel:bus-post-cancel', 'ok-cancel:bus-post-cancel'])

    // Rollback inside tx must never fire afterTaskFinished.
    events.length = 0
    await insertTask('bus-post-rollback', 'in_progress', {
      mode: 'none',
      model: 'gpt-image-2',
      quantity: 1,
      unitMultiplier: 1,
    })
    registerTaskLifecycleListener({
      id: 'tx-rollback-before-post',
      stage: 'after-settlement',
      async onTaskFinished() {
        throw new Error('tx abort')
      },
    })
    await expect(
      finishTask(
        'bus-post-rollback',
        { status: 'completed', completedAt: Date.now() },
        heldBy(WORKER_TOKEN),
      ),
    ).rejects.toThrow('tx abort')
    expect(events).toEqual([])

    // External tx passes onCommit hooks to be dispatched only after outer tx commits.
    _resetTaskLifecycleListenersForTesting()
    registerDefaultTaskLifecycleListeners()
    const externalEvents: string[] = []
    registerTaskLifecycleListener({
      id: 'post-commit-external-tx',
      stage: 'after-settlement',
      async afterTasksCancelled(event) {
        externalEvents.push(`ext:${event.tasks.map((task) => task.taskId).join(',')}`)
      },
    })
    await insertTask('bus-ext-cancel', 'queued', {
      mode: 'none',
      model: 'gpt-image-2',
      quantity: 1,
      unitMultiplier: 1,
    })
    const postCommitHooks: Array<() => Promise<void>> = []
    await db.transaction(async (tx) => {
      await cancelTasks(eq(schema.tasks.id, 'bus-ext-cancel'), {
        tx,
        onCommit: (hook) => postCommitHooks.push(hook),
      })
      expect(externalEvents).toEqual([])
    })
    expect(postCommitHooks).toHaveLength(1)
    for (const hook of postCommitHooks) await hook()
    expect(externalEvents).toEqual(['ext:bus-ext-cancel'])
  })
})
