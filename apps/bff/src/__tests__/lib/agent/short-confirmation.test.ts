import { expect, it } from 'bun:test'

process.env.DATABASE_URL = 'postgres://unused/short-confirmation'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'

const { shortConfirmationGuard } = await import('../../../lib/agent/short-confirmation')

const emptyFacts = {
  pendingDrafts: [],
  voidedDrafts: [],
  pendingNodeRuns: [],
  batches: [],
}

const completedBatch = {
  batchId: '5c9a2650',
  title: '挂墙台盆六角度',
  status: 'closed' as const,
  itemCount: 6,
  completed: 6,
  failed: 0,
  artifactIds: ['agent_aaa_0', 'agent_bbb_0'],
  removed: [],
}

it('does not intercept a new request even when a batch just finished', () => {
  expect(
    shortConfirmationGuard('可以再来一版', { ...emptyFacts, batches: [completedBatch] }),
  ).toBeUndefined()
  expect(shortConfirmationGuard('确认', emptyFacts)).toBeUndefined()
})

it('points at existing artifacts when the user only confirms a finished batch', () => {
  const guard = shortConfirmationGuard('确认，执行生成', {
    ...emptyFacts,
    batches: [completedBatch],
  })
  expect(guard?.reason).toBe('completed')
  expect(guard?.reply).toContain('这批已经出完了')
  expect(guard?.reply).toContain('5c9a2650')
  expect(guard?.reply).toContain('agent_aaa_0')
  expect(guard?.reply).not.toMatch(/generateImage|editImage|planImageBatch/)
})

it('asks the user to confirm on the card when drafts or node runs are waiting', () => {
  const drafts = shortConfirmationGuard('确认', {
    ...emptyFacts,
    pendingDrafts: [{ title: '浅灰浴缸' }],
  })
  expect(drafts?.reason).toBe('pending')
  expect(drafts?.reply).toContain('请在卡片上点确认')
  expect(drafts?.reply).toContain('1 张待确认的生成')

  const nodes = shortConfirmationGuard('可以', {
    ...emptyFacts,
    pendingNodeRuns: [{ title: '产品三视图', nodeIds: ['n1'] }],
  })
  expect(nodes?.reason).toBe('pending')
  expect(nodes?.reply).toContain('1 组待确认的节点运行')

  const plan = shortConfirmationGuard('开始生成', {
    ...emptyFacts,
    batches: [{ ...completedBatch, status: 'draft', completed: 0, artifactIds: [] }],
  })
  expect(plan?.reason).toBe('pending')
  expect(plan?.reply).toContain('待确认的批次计划')
})

it('prefers pending cards over a finished batch', () => {
  const guard = shortConfirmationGuard('确认', {
    ...emptyFacts,
    pendingDrafts: [{ title: '还没点' }],
    batches: [completedBatch],
  })
  expect(guard?.reason).toBe('pending')
})

it('does not resubmit while a batch is still running or paused', () => {
  const running = shortConfirmationGuard('执行', {
    ...emptyFacts,
    batches: [{ ...completedBatch, status: 'running', completed: 2, artifactIds: [] }],
  })
  expect(running?.reason).toBe('in_progress')
  expect(running?.reply).toContain('还在执行中')
})

it('does not intercept a confirmation that is answering a clarification', () => {
  expect(
    shortConfirmationGuard(
      '可以',
      { ...emptyFacts, batches: [completedBatch] },
      { inClarification: true },
    ),
  ).toBeUndefined()
})
