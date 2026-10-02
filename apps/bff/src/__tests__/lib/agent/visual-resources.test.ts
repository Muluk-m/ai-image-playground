import { afterEach, expect, it } from 'bun:test'

process.env.PORT = '0'
process.env.DATABASE_URL = 'postgres://unused/unused'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.OPERATOR_CONFIG_FILE = ''
const { config } = await import('../../../config')
const { withVisualPreparation } = await import('../../../lib/agent/visual-resources')
const original = config.operator
afterEach(() => {
  config.operator = original
})
it('cancels a queued preparation without reading bytes and bounds pending work', async () => {
  config.operator = {
    ...original,
    quotas: {
      ...original.quotas,
      'agent:visual-prepare-concurrency': 1,
      'agent:visual-prepare-queue': 1,
    },
  }
  let release!: () => void
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const active = withVisualPreparation(() => blocked)
  const controller = new AbortController()
  let reads = 0
  const queued = withVisualPreparation(async () => {
    reads++
  }, controller.signal)
  const cancelled = queued.catch((error) => error)
  const overflow = withVisualPreparation(async () => {
    reads++
  }).catch((error) => error)
  try {
    controller.abort()
    expect(
      await Promise.race([
        cancelled,
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 50)),
      ]),
    ).toMatchObject({ name: 'AbortError' })
    expect(
      await Promise.race([
        overflow,
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 50)),
      ]),
    ).toMatchObject({ code: 'quota_exceeded' })
    expect(reads).toBe(0)
  } finally {
    release()
    await Promise.all([active, cancelled, overflow])
  }
})

it('serializes a legitimate multi-image request while preserving input order', async () => {
  config.operator = {
    ...original,
    quotas: { ...original.quotas, 'agent:visual-prepare-concurrency': 1 },
  }
  let active = 0
  let peak = 0
  const values = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      withVisualPreparation(async () => {
        active++
        peak = Math.max(peak, active)
        await new Promise((resolve) => setTimeout(resolve, 1))
        active--
        return index
      }),
    ),
  )
  expect(values).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  expect(peak).toBe(1)
})
