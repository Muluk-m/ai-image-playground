import { afterAll, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'

const directory = mkdtempSync(resolve(tmpdir(), 'domain-handoff-disabled-'))
process.env.DATABASE_URL = await resetTestDatabase('bff_domain_handoff_disabled')
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'test'
// accounts:login is off here; the handoff config is mounted anyway.
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../quota-operator-config.json')
process.env.DOMAIN_HANDOFF_CONFIG_FILE = resolve(directory, 'handoff.json')
writeFileSync(
  process.env.DOMAIN_HANDOFF_CONFIG_FILE,
  JSON.stringify({
    sourceOrigin: 'https://old.example',
    targetOrigin: 'https://new.example',
    sourceApiOrigin: 'https://api.old.example',
    targetApiOrigin: 'https://api.new.example',
  }),
)
// Dynamic import keeps the env above ahead of configuration module evaluation, as in the sibling tests.
const { app } = await import('../../app')
const { close } = await import('../../db/client')
const call = (url: string) => app.handle(new Request(url))

afterAll(async () => {
  await close()
  rmSync(directory, { recursive: true, force: true })
})

it('mints no session while the login capability is disabled', async () => {
  const available = await call('https://api.new.example/api/auth/domain/available')
  expect(await available.json()).toEqual({ enabled: false, completed: false })
  expect((await call('https://api.new.example/api/auth/domain/start')).status).toBe(404)
  expect(
    (
      await call(
        `https://api.new.example/api/auth/domain/finish?state=${'s'.repeat(43)}&code=${'c'.repeat(43)}`,
      )
    ).status,
  ).toBe(404)
  expect(
    (await call(`https://api.old.example/api/auth/domain/authorize?state=${'s'.repeat(43)}`))
      .status,
  ).toBe(404)
})
