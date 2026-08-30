import { afterEach, describe, expect, it } from 'bun:test'
import { startWorkerHealthServer } from '../../workers/worker-health'

const servers: Array<ReturnType<typeof Bun.serve>> = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop(true)))
})

describe('worker activity health', () => {
  it('reports successful queue polling instead of process availability', async () => {
    let now = 100_000
    let lastSuccessfulPollAt: number | null = null
    const server = startWorkerHealthServer({
      port: 0,
      staleAfterMs: 5_000,
      now: () => now,
      lastSuccessfulPollAt: () => lastSuccessfulPollAt,
    })
    servers.push(server)
    const healthUrl = new URL('/health', server.url)

    const starting = await fetch(healthUrl)
    expect(starting.status).toBe(503)
    expect(await starting.json()).toMatchObject({
      ok: false,
      status: 'starting',
      lastSuccessfulPollAt: null,
    })

    lastSuccessfulPollAt = now
    const active = await fetch(healthUrl)
    expect(active.status).toBe(200)
    expect(await active.json()).toMatchObject({
      ok: true,
      status: 'active',
      lastSuccessfulPollAt: 100_000,
    })

    now += 5_001
    const stale = await fetch(healthUrl)
    expect(stale.status).toBe(503)
    expect(await stale.json()).toMatchObject({
      ok: false,
      status: 'stale',
      lastSuccessfulPollAt: 100_000,
    })
  })
})
