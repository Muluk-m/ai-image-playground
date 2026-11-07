import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resetTestDatabase } from '@image-playground/db/testing'
import type { SubmitRequest } from '@image-playground/shared'
import { eq } from 'drizzle-orm'
import {
  _setPrivateBffOverlayForTesting,
  EMPTY_PRIVATE_BFF_OVERLAY,
} from '../../lib/private-overlay'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'

/**
 * 特征测试：钉住「提交入口 × 模型系列 × 会员」现在实际落库的请求与拒绝结果。
 * 图片档位策略 module 重构（resolveImageTier）期间这张表不能变；改动它就是行为变更。
 *
 * 入口取自 createQueueTask / prepareQueueTask 现有字段：
 * - web-direct：不带任何标记
 * - cli-strict：strictImageRequest
 * - tx：调用方自带事务（确认生成、批次、灵感套用）
 * - prepared：先 prepareQueueTask 再提交（自动提交、批次执行）
 * 智能体与阶段授权入口走同一条 ceiling 分支，由 chat-task / agent-stage-authorizations 测试覆盖。
 */
process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'test-key'
process.env.DATABASE_URL = await resetTestDatabase('bff_image_tier_entries')
process.env.PORT = '0'
_setPrivateBffOverlayForTesting(EMPTY_PRIVATE_BFF_OVERLAY)

const { close, db, schema } = await import('../../db/client')
const { createQueueTask, prepareQueueTask } = await import('../../lib/taskSubmission')
const { setObjectStoreForTesting } = await import('../../lib/objectStore')

type Outcome = Awaited<ReturnType<typeof createQueueTask>>
type Input = Parameters<typeof createQueueTask>[0]
type Entry = 'web-direct' | 'cli-strict' | 'tx' | 'prepared'

const USER = 'tier-entry-user'
const direct = { enabled: process.env.GPT_DIRECT_ENABLED, apiKey: process.env.OPENAI_API_KEY }

beforeEach(async () => {
  setObjectStoreForTesting(new InMemoryObjectStore())
  process.env.GPT_DIRECT_ENABLED = 'true'
  process.env.OPENAI_API_KEY = 'direct-key'
  await db.delete(schema.tasks)
  await db
    .insert(schema.users)
    .values({
      id: USER,
      username: USER,
      password_hash: 'fixture',
      created_at: Date.now(),
      updated_at: Date.now(),
    })
    .onConflictDoNothing()
})
afterEach(() => {
  setObjectStoreForTesting()
  _setPrivateBffOverlayForTesting(EMPTY_PRIVATE_BFF_OVERLAY)
  if (direct.enabled === undefined) delete process.env.GPT_DIRECT_ENABLED
  else process.env.GPT_DIRECT_ENABLED = direct.enabled
  if (direct.apiKey === undefined) delete process.env.OPENAI_API_KEY
  else process.env.OPENAI_API_KEY = direct.apiKey
})
afterAll(async () => {
  await close()
})

function withMember(member: boolean) {
  _setPrivateBffOverlayForTesting({
    ...EMPTY_PRIVATE_BFF_OVERLAY,
    present: true,
    taskHooks: {
      ...EMPTY_PRIVATE_BFF_OVERLAY.taskHooks,
      canSubmitTask: async () => member,
      isActiveMember: async () => member,
    },
  })
}

function baseInput(model: 'gpt' | 'gemini'): Input {
  const request: Omit<SubmitRequest, 'video'> =
    model === 'gpt'
      ? { prompt: 'tier entry', device_id: 'device-abcdefgh', size: '3840x2160', quality: 'high' }
      : { prompt: 'tier entry', device_id: 'device-abcdefgh', image_size: '4K' }
  return {
    provider: model === 'gpt' ? 'openai-compat' : 'gemini',
    model: model === 'gpt' ? 'gpt-image-2.5-flare' : 'gemini-3-pro-image',
    userId: USER,
    request,
  }
}

async function submitVia(entry: Entry, input: Input): Promise<Outcome> {
  switch (entry) {
    case 'web-direct':
      return createQueueTask(input)
    case 'cli-strict':
      return createQueueTask({ ...input, strictImageRequest: true })
    case 'tx':
      return db.transaction((tx) => createQueueTask({ ...input, tx }))
    case 'prepared': {
      const preparation = await prepareQueueTask(input)
      if (preparation.kind !== 'prepared') throw new Error(`prepare failed: ${preparation.kind}`)
      return db.transaction((tx) =>
        createQueueTask({ ...input, tx, prepared: preparation.prepared }),
      )
    }
  }
}

async function stored(outcome: Outcome) {
  expect(outcome.kind).toBe('created')
  if (outcome.kind !== 'created') throw new Error('expected a task')
  const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, outcome.taskId))
  return task!.request_payload
}

const ENTRIES: readonly Entry[] = ['web-direct', 'cli-strict', 'tx', 'prepared']

describe('GPT 4K high request by entry', () => {
  // GPT 在 tx / prepared 入口一律收到非会员上限，会员也一样；只有 web-direct 按会员，cli-strict 不改参数。
  const CEILING: Record<Entry, { member: 'keep' | 'clamp'; nonMember: 'clamp' | 'denied' }> = {
    'web-direct': { member: 'keep', nonMember: 'clamp' },
    'cli-strict': { member: 'keep', nonMember: 'denied' },
    tx: { member: 'clamp', nonMember: 'clamp' },
    prepared: { member: 'clamp', nonMember: 'clamp' },
  }

  for (const entry of ENTRIES) {
    for (const member of [true, false]) {
      const expected = CEILING[entry][member ? 'member' : 'nonMember']
      it(`${entry} / ${member ? 'member' : 'non-member'} → ${expected}`, async () => {
        withMember(member)
        const outcome = await submitVia(entry, baseInput('gpt'))
        if (expected === 'denied') {
          expect(outcome.kind).toBe('private_billing_denied')
          expect(await db.select().from(schema.tasks)).toHaveLength(0)
          return
        }
        const payload = await stored(outcome)
        if (expected === 'keep') {
          expect(payload).toMatchObject({ size: '3840x2160', quality: 'high' })
          return
        }
        expect(payload.quality).toBe('medium')
        const [width, height] = payload.size!.split('x').map(Number)
        expect(width! * height!).toBeLessThanOrEqual(4_194_304)
      })
    }
  }
})

describe('Gemini 4K request by entry', () => {
  // Gemini 不分入口：非会员降到 2K，会员保留 4K；严格入口不降级，非会员直接拒绝。
  for (const entry of ENTRIES) {
    for (const member of [true, false]) {
      const expected = member ? '4K' : entry === 'cli-strict' ? 'denied' : '2K'
      it(`${entry} / ${member ? 'member' : 'non-member'} → ${expected}`, async () => {
        withMember(member)
        const outcome = await submitVia(entry, baseInput('gemini'))
        if (expected === 'denied') {
          expect(outcome.kind).toBe('private_billing_denied')
          expect(await db.select().from(schema.tasks)).toHaveLength(0)
          return
        }
        expect((await stored(outcome)).image_size).toBe(expected)
      })
    }
  }
})
