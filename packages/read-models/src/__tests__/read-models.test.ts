import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { createDb, type DbHandle } from '@image-playground/db'
import { resetTestDatabase } from '@image-playground/db/testing'
import {
  exportGenerationTasks,
  generationTasksCsv,
  getDeviceDetail,
  getGenerationTasks,
  getOverview,
  getOverviewActivity,
  getTask,
  getTodayOverview,
  getUserDetail,
  getUserKpis,
  getUserTasks,
  listDevices,
  listOperatorAudits,
  listUsers,
  readUserAssetBytes,
  resetUserKpiCacheForTesting,
  resetWindowFacetsCacheForTesting,
  TaskQueryError,
} from '../index'

let handle: DbHandle
const now = Date.now()

beforeAll(async () => {
  const url = await resetTestDatabase('read_models_core')
  handle = createDb(url)

  await handle.db.insert(handle.schema.users).values([
    {
      id: 'rm-user-1',
      username: 'alice',
      password_hash: 'hashed-pw',
      status: 'active',
      created_at: now - 3600_000,
      updated_at: now - 3600_000,
      last_login_at: now - 120_000,
    },
    {
      id: 'rm-user-2',
      username: 'bob',
      password_hash: 'hashed-pw',
      status: 'disabled',
      created_at: now - 7200_000,
      updated_at: now - 7200_000,
    },
  ])

  await handle.db.insert(handle.schema.user_asset_objects).values([
    {
      user_id: 'rm-user-1',
      image_id: 'img-1',
      bytes: 1200,
      content_type: 'image/png',
      created_at: now - 1000,
    },
    {
      user_id: 'rm-user-1',
      image_id: 'img-2',
      bytes: 3400,
      content_type: 'image/jpeg',
      created_at: now - 500,
    },
  ])

  type TaskInsert = typeof handle.schema.tasks.$inferInsert
  await handle.db.insert(handle.schema.tasks).values([
    {
      id: 'rm-task-1',
      user_id: 'rm-user-1',
      provider: 'openai-compat',
      model: 'gpt-image-2',
      status: 'completed',
      request_payload: {
        device_id: 'rm-dev-1',
        prompt: '=SUM(A1:A2) cat portrait',
        apiKey: 'sk-secret-value',
        data: 'data:image/png;base64,AAAA',
        n: 2,
      } as unknown as TaskInsert['request_payload'],
      result_payload: { _image_meta: [{ index: 0, mime: 'image/png' }] },
      submitted_at: now - 60_000,
      started_at: now - 55_000,
      completed_at: now - 45_000,
      attempt_count: 1,
      upstream_invocation_count: 1,
    },
    {
      id: 'rm-task-2',
      user_id: 'rm-user-1',
      provider: 'gemini',
      model: 'gemini-3-pro',
      status: 'failed',
      error_type: 'rate_limit',
      error_message: 'Authorization: Bearer secret-token-123 failed',
      upstream_status: 429,
      request_payload: {
        device_id: 'rm-dev-1',
        contents: [{ parts: [{ text: 'sunset beach' }] }],
      } as unknown as TaskInsert['request_payload'],
      submitted_at: now - 30_000,
      started_at: now - 25_000,
      completed_at: now - 20_000,
      attempt_count: 2,
      upstream_invocation_count: 2,
    },
  ] satisfies TaskInsert[])

  await handle.db.insert(handle.schema.operator_audits).values([
    {
      id: 'audit-b',
      operator_id: 'op-1',
      action: 'user.note.update',
      target_type: 'user',
      target_id: 'rm-user-1',
      details: { note: 'vip' },
      created_at: now - 10_000,
    },
    {
      id: 'audit-a',
      operator_id: 'op-1',
      action: 'user.note.update',
      target_type: 'user',
      target_id: 'rm-user-1',
      details: { note: 'initial' },
      created_at: now - 10_000,
    },
  ])
}, 30_000)

afterAll(async () => {
  await handle?.close()
}, 30_000)

describe('@image-playground/read-models', () => {
  it('shares identical user asset byte footprint between BFF tx helper and Admin getUserDetail', async () => {
    const directBytes = await readUserAssetBytes(handle.db, 'rm-user-1')
    const txBytes = await handle.db.transaction((tx) => readUserAssetBytes(tx, 'rm-user-1'))
    const detail = await getUserDetail(handle, 'rm-user-1', false)

    expect(directBytes).toBe(4600)
    expect(txBytes).toBe(4600)
    expect(detail?.asset_bytes).toBe(4600)
    expect(detail?.user?.username).toBe('alice')
    expect(detail?.user?.task_count).toBe(2)
  })

  it('lists users, supports segments without billing, and coalesces KPI reads', async () => {
    const listed = await listUsers(handle, 'ali', { segments: true, billingCreditsEnabled: false })
    expect(listed.total).toBe(1)
    expect(listed.users[0]?.id).toBe('rm-user-1')
    expect(listed.segments).toMatchObject({ all: 1, 'active-7d': 1, disabled: 0 })

    resetUserKpiCacheForTesting()
    const first = getUserKpis(handle, now)
    const second = getUserKpis(handle, now)
    expect(second).toBe(first)
    const kpis = await first
    expect(kpis.total_users).toBe(2)
    expect(kpis.submissions_24h).toBe(2)
    expect(kpis.failure_rate_24h).toBeCloseTo(0.5)
  })

  it('reads devices, tasks with redaction, user tasks, overview, and generation tasks', async () => {
    const devices = await listDevices(handle, '7d', 'last_seen')
    expect(devices.total).toBe(1)
    expect(devices.devices[0]).toMatchObject({
      device_id: 'rm-dev-1',
      total: 2,
      ok_count: 1,
      fail_count: 1,
    })

    const devDetail = await getDeviceDetail(handle, 'rm-dev-1', '7d')
    expect(devDetail.device?.device_id).toBe('rm-dev-1')
    expect(devDetail.tasks).toHaveLength(2)

    const userTasks = await getUserTasks(handle, 'rm-user-1', 'all')
    expect(userTasks.tasks.map((t) => t.id)).toEqual(['rm-task-2', 'rm-task-1'])

    const detail = await getTask(handle, 'rm-task-1')
    expect(detail?.prompt).toBe('=SUM(A1:A2) cat portrait')
    expect(detail?.result_meta.images).toEqual([{ index: 0, mime: 'image/png' }])
    expect(detail?.request_payload).toMatchObject({
      apiKey: '[REDACTED]',
      data: '[BINARY REDACTED]',
    })

    const overview = await getOverview(handle, '1d')
    expect(overview.summary.total).toBe(2)
    expect(overview.summary.completed).toBe(1)
    expect(overview.summary.failed).toBe(1)
    expect(overview.pulse.current.images).toBe(2)

    const today = await getTodayOverview(handle, now)
    expect(today.summary.tasks).toBe(2)
    expect(today.models.map((m) => m.model)).toEqual(['gemini-3-pro', 'gpt-image-2'])

    resetWindowFacetsCacheForTesting()
    const window = { from: now - 3600_000, to: now + 1000 }
    const paged = await getGenerationTasks(handle, { ...window, page: 1, pageSize: 50 })
    expect(paged.total).toBe(2)
    expect(paged.facets?.statusCounts.completed).toBe(1)
    expect(paged.facets?.statusCounts.failed).toBe(1)

    await expect(
      getGenerationTasks(handle, { ...window, minDurationSec: 20, maxDurationSec: 10 }),
    ).rejects.toThrow(TaskQueryError)

    const exported = await exportGenerationTasks(handle, window)
    expect(exported.truncated).toBe(false)
    const csv = generationTasksCsv(exported.tasks)
    expect(csv).toContain("'=SUM(A1:A2) cat portrait")
  })

  it('supports injectable server log reader on getOverviewActivity and keyset pagination on audits', async () => {
    const window = { from: now - 3600_000, to: now + 1000 }
    const offActivity = await getOverviewActivity(handle, window)
    expect(offActivity.tasks).toHaveLength(2)
    expect(offActivity.server).toEqual({ availability: 'off', total: 0, entries: [] })

    const customActivity = await getOverviewActivity(handle, window, {
      readServerErrors: async () => ({
        availability: 'complete',
        total: 1,
        entries: [
          {
            id: 'srv-1',
            at: now - 1000,
            service: 'bff',
            message: 'boom',
            stack: null,
            task_id: 'rm-task-2',
            request_id: 'req-1',
            instance: 'bff-1',
          },
        ],
      }),
    })
    expect(customActivity.server.total).toBe(1)
    expect(customActivity.server.entries[0]?.id).toBe('srv-1')

    const page1 = await listOperatorAudits(handle, { limit: 1, action: 'user.note.update' })
    expect(page1.audits.map((a) => a.id)).toEqual(['audit-b'])
    expect(page1.nextCursor).not.toBeNull()

    const page2 = await listOperatorAudits(handle, {
      limit: 1,
      action: 'user.note.update',
      cursor: page1.nextCursor!,
    })
    expect(page2.audits.map((a) => a.id)).toEqual(['audit-a'])
    expect(page2.nextCursor).toBeNull()
  })
})
