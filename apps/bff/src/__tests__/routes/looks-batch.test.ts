import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { Elysia } from 'elysia'
import { TEST_IMAGE_CHANNEL } from '../helpers/agentStubs'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'

process.env.PORT = '0'
process.env.DATABASE_URL = await resetTestDatabase('bff_looks_batch')
process.env.LOG_LEVEL = 'silent'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../sync-operator-config.json')

// Dynamic imports keep environment setup ahead of modules that capture configuration.
const { lookRoutes } = await import('../../routes/looks')
const { ensureAgentSkills, setAgentSkillsRootForTesting } = await import('../../lib/agent/skills')
const { _setChannelsForTesting } = await import('../../lib/channels')
const { setObjectStoreForTesting } = await import('../../lib/objectStore')
const { assetObjectKey } = await import('../../lib/sync-assets')
const { createUserSession, USER_SESSION_COOKIE } = await import('../../lib/user-session')
const { close: closeDb, db, schema } = await import('../../db/client')

const app = new Elysia().use(lookRoutes)
const USER = 'look-batch-owner'
const DEVICE = 'device-abcdefgh'
const MODEL = TEST_IMAGE_CHANNEL.models[0]!.id
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgAAIAAAUAAeImBZsAAAAASUVORK5CYII=',
  'base64',
)
const BODY = [
  '## 1. 一句话目标',
  '把产品放进极简棚拍场景。',
  '',
  '## 3. 需要用户提供的输入',
  '- 产品素材 ×1',
  '',
  '## 4. 工作流程',
  '1. 先看输入图。',
].join('\n')

let cookie = ''
let storage: InMemoryObjectStore
let skillsRoot = ''

async function putAsset(
  id: string,
  name: string,
  views: Array<{ imageId: string; label: string; source: string }>,
): Promise<void> {
  const now = Date.now()
  await db.insert(schema.user_assets).values({
    user_id: USER,
    id,
    name,
    image_id: views[0]?.imageId ?? null,
    kind: 'product',
    background: 'solid',
    views,
    created_at: now,
    updated_at: now,
    last_used_at: now,
    version: 1,
  })
  for (const view of views) {
    await db
      .insert(schema.user_asset_objects)
      .values({
        user_id: USER,
        image_id: view.imageId,
        bytes: PNG.length,
        content_type: 'image/png',
        created_at: now,
      })
      .onConflictDoNothing()
    await storage.write(assetObjectKey(USER, view.imageId), PNG, 'image/png')
  }
}

async function putLook(
  id: string,
  overrides: Partial<{ slotCount: number; model: string; referenceImageIds: string[] }> = {},
): Promise<void> {
  const now = Date.now()
  await db.insert(schema.user_looks).values({
    user_id: USER,
    id,
    name: '极简棚拍',
    description: '白底棚拍主图',
    purpose: 'hero',
    body: BODY,
    model: overrides.model ?? MODEL,
    size: '1024x1536',
    slot_count: overrides.slotCount ?? 1,
    reference_image_ids: overrides.referenceImageIds ?? [],
    cover_image_id: null,
    created_at: now,
    updated_at: now,
    last_used_at: now,
    version: 1,
  })
}

async function batch(body: unknown, withCookie = true) {
  const response = await app.handle(
    new Request('http://localhost/api/looks/batch', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(withCookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    }),
  )
  return { status: response.status, json: (await response.json()) as Record<string, unknown> }
}

async function tasks() {
  return db.select().from(schema.tasks)
}

beforeAll(async () => {
  skillsRoot = await mkdtemp(join(tmpdir(), 'aip-look-batch-'))
  const dir = join(skillsRoot, 'image', 'look-seaview-hotel')
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'SKILL.md'),
    `---\nname: look-seaview-hotel\ndescription: 何时用：海景房场景图。\n---\n\n${BODY}\n`,
    'utf8',
  )
  await writeFile(join(dir, 'reference-1.png'), PNG)
  await writeFile(join(dir, 'cover.png'), PNG)
  await writeFile(
    join(dir, 'meta.json'),
    JSON.stringify({
      icon: 'image',
      summary: '海景房场景图',
      template: {
        purpose: 'scene',
        model: MODEL,
        size: '1024x1024',
        slotCount: 1,
        cover: 'cover.png',
        references: ['reference-1.png'],
      },
    }),
    'utf8',
  )
  _setChannelsForTesting([TEST_IMAGE_CHANNEL])
  setAgentSkillsRootForTesting(skillsRoot)
  await ensureAgentSkills()
})

afterAll(async () => {
  _setChannelsForTesting([])
  setAgentSkillsRootForTesting(null)
  setObjectStoreForTesting()
  if (skillsRoot) await rm(skillsRoot, { recursive: true, force: true })
  await closeDb()
})

beforeEach(async () => {
  storage = new InMemoryObjectStore()
  setObjectStoreForTesting(storage)
  await db.delete(schema.tasks)
  await db.delete(schema.users)
  const now = Date.now()
  await db.insert(schema.users).values({
    id: USER,
    username: USER,
    password_hash: 'fixture-hash',
    status: 'active',
    created_at: now,
    updated_at: now,
  })
  cookie = `${USER_SESSION_COOKIE}=${await db.transaction((tx) => createUserSession(USER, tx))}`
})

describe('POST /api/looks/batch', () => {
  it('素材位只有一个时每条素材各起一个任务，提示词点名这一条素材', async () => {
    await putAsset('cup', '白瓷杯', [
      { imageId: 'cup-front', label: 'front', source: 'upload' },
      { imageId: 'cup-sheet', label: 'sheet', source: 'generated' },
    ])
    await putAsset('lamp', '台灯', [{ imageId: 'lamp-1', label: 'none', source: 'upload' }])
    await putLook('look-1', { referenceImageIds: ['ref-1'] })
    await db.insert(schema.user_asset_objects).values({
      user_id: USER,
      image_id: 'ref-1',
      bytes: PNG.length,
      content_type: 'image/png',
      created_at: Date.now(),
    })
    await storage.write(assetObjectKey(USER, 'ref-1'), PNG, 'image/png')

    const { status, json } = await batch({
      lookId: 'look-1',
      assetIds: ['cup', 'lamp'],
      perAsset: 2,
      device_id: DEVICE,
    })

    expect(status).toBe(200)
    const created = json.tasks as Array<{ assetIds: string[]; taskId: string }>
    expect(created.map((task) => task.assetIds)).toEqual([['cup'], ['lamp']])

    const rows = await tasks()
    const byId = new Map(rows.map((row) => [row.id, row]))
    const first = byId.get(created[0]!.taskId)!
    expect(first.model).toBe(MODEL)
    expect(first.request_payload.size).toBe('1024x1536')
    expect(first.request_payload.n).toBe(2)
    // 拼图比正面全，所以送的是拼图那张；参考图排在素材之后。
    expect(first.request_payload.input_images).toHaveLength(2)
    expect(first.request_payload.prompt).toContain('输入 1 = 素材「白瓷杯」')
    expect(first.request_payload.prompt).toContain('参考图：输入 2')
    expect(first.request_payload.prompt).not.toContain('- 产品素材 ×1')
    expect(byId.get(created[1]!.taskId)!.request_payload.prompt).toContain('输入 1 = 素材「台灯」')
  })

  it('counts 盖过这条素材的张数，其余照 perAsset', async () => {
    await putAsset('cup', '白瓷杯', [{ imageId: 'cup-1', label: 'front', source: 'upload' }])
    await putAsset('lamp', '台灯', [{ imageId: 'lamp-1', label: 'front', source: 'upload' }])
    await putLook('look-1')

    const { status, json } = await batch({
      lookId: 'look-1',
      assetIds: ['cup', 'lamp'],
      perAsset: 1,
      counts: { lamp: 4 },
      device_id: DEVICE,
    })

    expect(status).toBe(200)
    const created = json.tasks as Array<{ assetIds: string[]; taskId: string }>
    const byId = new Map((await tasks()).map((row) => [row.id, row]))
    expect(byId.get(created[0]!.taskId)!.request_payload.n).toBe(1)
    expect(byId.get(created[1]!.taskId)!.request_payload.n).toBe(4)
  })

  it('素材位不止一个时这一批素材填满那几个位，只起一个任务', async () => {
    await putAsset('cup', '白瓷杯', [{ imageId: 'cup-1', label: 'front', source: 'upload' }])
    await putAsset('model', '模特', [{ imageId: 'model-1', label: 'front', source: 'upload' }])
    await putLook('look-2', { slotCount: 2 })

    const { status, json } = await batch({
      lookId: 'look-2',
      assetIds: ['cup', 'model'],
      perAsset: 1,
      device_id: DEVICE,
    })

    expect(status).toBe(200)
    expect(json.tasks).toHaveLength(1)
    const [row] = await tasks()
    expect(row!.request_payload.input_images).toHaveLength(2)
    expect(row!.request_payload.prompt).toContain('输入 2 = 素材「模特」')
  })

  it('素材数与素材位不符时整批拒绝，一个任务都不建', async () => {
    await putAsset('cup', '白瓷杯', [{ imageId: 'cup-1', label: 'front', source: 'upload' }])
    await putLook('look-2', { slotCount: 2 })

    const { status, json } = await batch({
      lookId: 'look-2',
      assetIds: ['cup'],
      perAsset: 1,
      device_id: DEVICE,
    })

    expect(status).toBe(422)
    expect(json.error).toBe('slot_mismatch')
    expect(await tasks()).toHaveLength(0)
  })

  it('批里有一条素材不存在时整批拒绝并点名', async () => {
    await putAsset('cup', '白瓷杯', [{ imageId: 'cup-1', label: 'front', source: 'upload' }])
    await putLook('look-1')

    const { status, json } = await batch({
      lookId: 'look-1',
      assetIds: ['cup', 'ghost'],
      perAsset: 1,
      device_id: DEVICE,
    })

    expect(status).toBe(404)
    expect(json).toMatchObject({ error: 'asset_not_found', assetId: 'ghost' })
    expect(await tasks()).toHaveLength(0)
  })

  it('素材图还没上传到服务端时整批拒绝，一个任务都不建', async () => {
    await putAsset('cup', '白瓷杯', [{ imageId: 'cup-1', label: 'front', source: 'upload' }])
    // 这一条只有记录没有图本体：同步还没把它推上来。
    const now = Date.now()
    await db.insert(schema.user_assets).values({
      user_id: USER,
      id: 'pending',
      name: '刚拍的',
      image_id: 'pending-1',
      views: [{ imageId: 'pending-1', label: 'front', source: 'upload' }],
      created_at: now,
      updated_at: now,
      last_used_at: now,
      version: 2,
    })
    await putLook('look-1')

    const { status, json } = await batch({
      lookId: 'look-1',
      assetIds: ['cup', 'pending'],
      perAsset: 1,
      device_id: DEVICE,
    })

    expect(status).toBe(422)
    expect(json).toMatchObject({ error: 'image_unavailable', imageId: 'pending-1' })
    expect(await tasks()).toHaveLength(0)
  })

  it('模板钉死的模型不在这个部署的清单里时不替用户换一个', async () => {
    await putAsset('cup', '白瓷杯', [{ imageId: 'cup-1', label: 'front', source: 'upload' }])
    await putLook('look-3', { model: 'retired-model' })

    const { status, json } = await batch({
      lookId: 'look-3',
      assetIds: ['cup'],
      perAsset: 1,
      device_id: DEVICE,
    })

    expect(status).toBe(422)
    expect(json).toMatchObject({ error: 'model_unavailable', model: 'retired-model' })
    expect(await tasks()).toHaveLength(0)
  })

  it('预置模板按技能名出图，参考图从技能目录读', async () => {
    await putAsset('cup', '白瓷杯', [{ imageId: 'cup-1', label: 'front', source: 'upload' }])

    const { status, json } = await batch({
      skillName: 'look-seaview-hotel',
      assetIds: ['cup'],
      perAsset: 1,
      device_id: DEVICE,
    })

    expect(status).toBe(200)
    expect(json.tasks).toHaveLength(1)
    const [row] = await tasks()
    expect(row!.request_payload.size).toBe('1024x1024')
    expect(row!.request_payload.input_images).toHaveLength(2)
    expect(row!.request_payload.prompt).toContain('参考图：输入 2')
  })

  it('同时给模板 id 与技能名（或都不给）是坏请求', async () => {
    await putLook('look-1')
    const both = await batch({
      lookId: 'look-1',
      skillName: 'look-seaview-hotel',
      assetIds: ['cup'],
      perAsset: 1,
      device_id: DEVICE,
    })
    expect(both.status).toBe(400)

    const neither = await batch({ assetIds: ['cup'], perAsset: 1, device_id: DEVICE })
    expect(neither.status).toBe(400)
  })

  it('没有登录身份时不出图', async () => {
    const { status } = await batch(
      { lookId: 'look-1', assetIds: ['cup'], perAsset: 1, device_id: DEVICE },
      false,
    )
    expect(status).toBe(401)
  })
})
