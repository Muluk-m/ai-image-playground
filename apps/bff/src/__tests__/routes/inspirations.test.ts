import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'

process.env.PORT = '0'
process.env.DATABASE_URL = await resetTestDatabase('bff_inspiration_publications')
process.env.INTERNAL_API_TOKEN = 'inspiration-test-service-token'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../../../operator-config.example.json')
process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'test'
process.env.OPENAI_API_KEY = 'test'

const { app } = await import('../../app')
const { close: closeDb, db, schema } = await import('../../db/client')
const { initChannels, _setChannelsForTesting } = await import('../../lib/channels')
initChannels(resolve(import.meta.dir, '../../../channels.json'))

const ITEM = {
  id: 'public-test-card',
  kind: 'template',
  featured: true,
  title: 'Replace the {product}',
  description: 'A product card',
  categoryId: 'test-category',
  prompt: 'A {product} on a bright backdrop',
  recommendedProvider: 'openai-compat',
  recommendedModel: 'gpt-image-2.5-flare',
  params: { size: 'auto', n: 1 },
  tags: ['test'],
  coverKey: 'https://example.com/card.png',
  imageKey: null,
  referenceImages: [],
  skillName: null,
  sourceUrl: null,
  author: null,
  sort: 1,
}

const service = { authorization: 'Bearer inspiration-test-service-token' }
function request(path: string, method = 'GET', body?: unknown, authenticated = true) {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        ...(authenticated ? service : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  )
}

beforeEach(async () => {
  await db.delete(schema.inspiration_publications)
  await db.delete(schema.inspiration_items)
  await db.delete(schema.inspiration_categories)
  await db.delete(schema.operator_audits)
  expect(
    (
      await request('/internal/admin/inspiration-categories', 'POST', {
        id: 'test-category',
        name: 'Products',
        sort: 1,
      })
    ).status,
  ).toBe(201)
})

afterAll(async () => {
  _setChannelsForTesting([])
  await closeDb()
})

describe('inspiration publication', () => {
  it('keeps drafts and archived items private and increments the public version on publication', async () => {
    expect((await request('/internal/admin/inspirations', 'POST', ITEM, false)).status).toBe(401)
    expect((await request('/internal/admin/inspirations', 'POST', ITEM)).status).toBe(201)
    const before = await request('/api/inspirations/manifest', 'GET', undefined, false)
    const draftManifest = await before.json()
    expect(draftManifest.items).toEqual([])
    expect(before.headers.get('cache-control')).toBe(
      'public, max-age=300, stale-while-revalidate=86400',
    )

    expect(
      (
        await request(`/internal/admin/inspirations/${ITEM.id}/status`, 'POST', {
          status: 'published',
        })
      ).status,
    ).toBe(200)
    const published = await request('/api/inspirations/manifest', 'GET', undefined, false)
    const publishedManifest = await published.json()
    expect(publishedManifest.items).toEqual([
      expect.objectContaining({
        id: ITEM.id,
        kind: 'template',
        featured: true,
        category: 'Products',
        slots: ['product'],
        thumbnailUrl: ITEM.coverKey,
      }),
    ])
    expect(publishedManifest.version).toBeGreaterThan(draftManifest.version)

    expect((await request(`/internal/admin/inspirations/${ITEM.id}`, 'DELETE')).status).toBe(409)
    expect(
      (
        await request(`/internal/admin/inspirations/${ITEM.id}/status`, 'POST', {
          status: 'archived',
        })
      ).status,
    ).toBe(200)
    const archivedManifest = await (
      await request('/api/inspirations/manifest', 'GET', undefined, false)
    ).json()
    expect(archivedManifest.items).toEqual([])
    expect(archivedManifest.version).toBeGreaterThan(publishedManifest.version)
    const audits = await db.select().from(schema.operator_audits)
    expect(audits.map(({ action }) => action)).toContain('inspiration.archived')
  })

  it('rejects model/provider mismatch and templates without fillable slots before publication', async () => {
    const mismatched = { ...ITEM, kind: 'showcase', recommendedProvider: 'gemini' }
    expect((await request('/internal/admin/inspirations', 'POST', mismatched)).status).toBe(201)
    const invalidModel = await request(`/internal/admin/inspirations/${ITEM.id}/status`, 'POST', {
      status: 'published',
    })
    expect(invalidModel.status).toBe(400)
    expect(await invalidModel.json()).toEqual({ error: 'invalid_model' })

    const invalidTemplate = { ...ITEM, id: 'without-slot', prompt: 'No template placeholder' }
    const invalid = await request('/internal/admin/inspirations', 'POST', invalidTemplate)
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toEqual({ error: 'invalid_template' })
  })
})
