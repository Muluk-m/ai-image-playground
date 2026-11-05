import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { ANNOUNCEMENT_EXPORT_FORMAT, ANNOUNCEMENT_EXPORT_VERSION } from '@image-playground/shared'

process.env.PORT = '0'
process.env.DATABASE_URL = await resetTestDatabase('bff_announcements')
process.env.INTERNAL_API_TOKEN = 'announcement-test-service-token'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../../../operator-config.example.json')
process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'test'
process.env.OPENAI_API_KEY = 'test'
process.env.PUBLIC_ASSET_BASE_URL = 'https://assets.test.example'
process.env.PUBLIC_WEB_ORIGIN = 'https://test.muvloom.online'

const { app } = await import('../../app')
const { close: closeDb, db, schema } = await import('../../db/client')
const { createUserSession, USER_SESSION_COOKIE } = await import('../../lib/user-session')

const service = { authorization: 'Bearer announcement-test-service-token' }

function request(
  path: string,
  method = 'GET',
  body?: unknown,
  extraHeaders: Record<string, string> = {},
) {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        ...extraHeaders,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  )
}

const admin = (path: string, method = 'GET', body?: unknown) =>
  request(path, method, body, { ...service, 'x-admin-operator': 'demo_ops' })

const draft = {
  type: 'feature',
  importance: 'normal',
  titleZh: '去背景支持一次处理 20 张',
  bodyZh: '在工具箱里一次最多 20 张。',
  titleEn: null,
  bodyEn: null,
  coverKey: 'announcements/cover.png',
  ctaLabel: '打开去背景',
  ctaUrl: '/toolbox/remove-bg',
  versionTag: 'v2.15.0',
  audience: 'all',
  publishAt: null,
  expireAt: null,
}

beforeEach(async () => {
  await db.delete(schema.announcement_reads)
  await db.delete(schema.announcements)
  await db.delete(schema.operator_audits)
  await db.delete(schema.user_sessions)
  await db.delete(schema.users)
})

afterAll(async () => {
  await closeDb()
})

async function signIn(id = 'reader'): Promise<string> {
  const now = Date.now()
  await db.insert(schema.users).values({
    id,
    username: id,
    password_hash: 'hash',
    status: 'active',
    created_at: now,
    updated_at: now,
  })
  const token = await db.transaction((tx) => createUserSession(id, tx))
  return `${USER_SESSION_COOKIE}=${token}`
}

describe('announcement visibility', () => {
  it('rejects anonymous admin writes and keeps drafts off the public list', async () => {
    expect((await request('/internal/admin/announcements', 'POST', draft)).status).toBe(401)
    const created = await admin('/internal/admin/announcements', 'POST', draft)
    expect(created.status).toBe(201)
    const body = await created.json()
    expect(body.item.effectiveStatus).toBe('draft')
    expect(body.item.coverUrl).toBe('https://assets.test.example/announcements/cover.png')
    const list = await admin('/internal/admin/announcements')
    expect(await list.json()).toMatchObject({
      counts: { all: 1, draft: 1, scheduled: 0, published: 0, archived: 0 },
      webOrigin: 'https://test.muvloom.online',
    })
    const pub = await request('/api/announcements?locale=zh')
    expect(pub.status).toBe(200)
    expect(await pub.json()).toEqual({ items: [], unreadCount: 0 })
    expect(pub.headers.get('cache-control')).toBeNull()
  })

  it('shows a schedule only inside its window and drops it after expiry', async () => {
    const created = await (await admin('/internal/admin/announcements', 'POST', draft)).json()
    const id = created.item.id as string
    const future = Date.now() + 86_400_000
    const scheduled = await admin(`/internal/admin/announcements/${id}/publish`, 'POST', {
      reason: '排到明天',
      publishAt: future,
    })
    expect(scheduled.status).toBe(200)
    expect((await scheduled.json()).item.effectiveStatus).toBe('scheduled')
    expect((await (await request('/api/announcements')).json()).items).toEqual([])

    const past = Date.now() - 60_000
    const published = await admin(`/internal/admin/announcements/${id}/publish`, 'POST', {
      reason: '提前发布',
      publishAt: past,
    })
    expect((await published.json()).item.effectiveStatus).toBe('published')
    const fallback = await (await request('/api/announcements?locale=en')).json()
    expect(fallback.items).toHaveLength(1)
    expect(fallback.items[0]).toMatchObject({
      title: '去背景支持一次处理 20 张',
      body: '在工具箱里一次最多 20 张。',
      usedFallback: true,
      unread: true,
      ctaUrl: '/toolbox/remove-bg',
    })
    await admin(`/internal/admin/announcements/${id}`, 'PUT', {
      ...draft,
      titleEn: 'Remove twenty',
      bodyEn: 'Up to twenty images.',
      publishAt: past,
    })
    const english = await (await request('/api/announcements?locale=en')).json()
    expect(english.items[0]).toMatchObject({
      title: 'Remove twenty',
      body: 'Up to twenty images.',
      usedFallback: false,
    })

    await admin(`/internal/admin/announcements/${id}`, 'PUT', {
      ...draft,
      titleEn: 'Remove twenty',
      bodyEn: 'Up to twenty images.',
      expireAt: Date.now() - 1000,
      publishAt: past,
    })
    expect((await (await request('/api/announcements?locale=en')).json()).items).toEqual([])
  })

  it('filters audience and records reads for the signed-in user', async () => {
    const cookie = await signIn()
    const loggedIn = await (
      await admin('/internal/admin/announcements', 'POST', { ...draft, audience: 'logged_in' })
    ).json()
    const anon = await (
      await admin('/internal/admin/announcements', 'POST', {
        ...draft,
        titleZh: '未登录也能看',
        audience: 'anonymous',
        ctaLabel: null,
        ctaUrl: null,
      })
    ).json()
    const past = Date.now() - 1000
    for (const item of [loggedIn.item, anon.item]) {
      expect(
        (
          await admin(`/internal/admin/announcements/${item.id}/publish`, 'POST', {
            reason: '上线',
            publishAt: past,
          })
        ).status,
      ).toBe(200)
    }

    const guest = await (await request('/api/announcements')).json()
    expect(guest.items.map((item: { title: string }) => item.title)).toEqual(['未登录也能看'])
    const member = await (await request('/api/announcements', 'GET', undefined, { cookie })).json()
    expect(member.items.map((item: { id: string }) => item.id)).toEqual([loggedIn.item.id])

    expect((await request(`/api/announcements/${loggedIn.item.id}/read`, 'POST', {})).status).toBe(
      401,
    )
    const read = await request(
      `/api/announcements/${loggedIn.item.id}/read`,
      'POST',
      {
        dismissed: true,
      },
      { cookie },
    )
    expect(read.status).toBe(200)
    const again = await (await request('/api/announcements', 'GET', undefined, { cookie })).json()
    expect(again.items[0]).toMatchObject({ unread: false, dismissed: true })
    expect(again.unreadCount).toBe(0)

    const audits = await db.select().from(schema.operator_audits)
    expect(audits.map((row) => row.action).sort()).toEqual([
      'announcement.create',
      'announcement.create',
      'announcement.publish',
      'announcement.publish',
    ])
    expect(audits.find((row) => row.action === 'announcement.publish')?.details).toMatchObject({
      reason: '上线',
    })
  })

  it('requires a reason to publish, unpublish and archive', async () => {
    const created = await (await admin('/internal/admin/announcements', 'POST', draft)).json()
    const id = created.item.id as string
    expect(
      (await admin(`/internal/admin/announcements/${id}/publish`, 'POST', { reason: '   ' }))
        .status,
    ).toBe(400)
    expect(
      (
        await admin(`/internal/admin/announcements/${id}/publish`, 'POST', {
          reason: '发布',
          publishAt: Date.now() - 1000,
        })
      ).status,
    ).toBe(200)
    expect(
      (await admin(`/internal/admin/announcements/${id}/unpublish`, 'POST', { reason: '改文案' }))
        .status,
    ).toBe(200)
    const after = await (await request('/api/announcements')).json()
    expect(after.items).toEqual([])
    expect(
      (await admin(`/internal/admin/announcements/${id}/archive`, 'POST', { reason: '过季' }))
        .status,
    ).toBe(200)
    const actions = (await db.select().from(schema.operator_audits)).map((row) => row.action)
    expect(actions).toContain('announcement.unpublish')
    expect(actions).toContain('announcement.archive')
  })

  it('imports a portable draft and rejects an off-site link', async () => {
    const imported = await admin('/internal/admin/announcements/import', 'POST', {
      format: ANNOUNCEMENT_EXPORT_FORMAT,
      version: ANNOUNCEMENT_EXPORT_VERSION,
      announcement: { ...draft, titleZh: '从测试环境带回' },
    })
    expect(imported.status).toBe(201)
    expect((await imported.json()).item).toMatchObject({
      titleZh: '从测试环境带回',
      status: 'draft',
    })
    const rejected = await admin('/internal/admin/announcements', 'POST', {
      ...draft,
      ctaUrl: 'https://example.com/out',
    })
    expect(rejected.status).toBe(400)
    expect(await rejected.json()).toEqual({ error: 'invalid_announcement' })
  })
})
