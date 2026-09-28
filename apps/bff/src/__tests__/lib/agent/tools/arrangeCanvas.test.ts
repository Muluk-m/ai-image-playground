import { afterAll, beforeEach, expect, it } from 'bun:test'
import { resetTestDatabase } from '@image-playground/db/testing'
import {
  layoutCanvasArrange,
  type ProjectDocument,
  type ProjectElement,
} from '@image-playground/shared'

process.env.DATABASE_URL = await resetTestDatabase('bff_agent_arrange_canvas')
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'

const { arrangeCanvas } = await import('../../../../lib/agent/tools/arrangeCanvas')
const { close: closeDb, db, schema } = await import('../../../../db/client')
type AgentToolContext = Parameters<typeof arrangeCanvas.create>[0]

const USER = 'user-arrange'
const MEDIA_A = '11111111-2222-4333-8444-555555555555'
const MEDIA_B = '22222222-2222-4333-8444-555555555555'

function context(conversationId: string, userId: string | null): AgentToolContext {
  return {
    mode: 'image',
    conversationId,
    turnId: 'turn-1',
    userId,
    deviceId: 'device-abcdefgh',
    images: { references: [], identify: () => undefined, attach: () => {} } as never,
  }
}

async function run(conversationId: string, userId: string | null, groups: unknown) {
  return arrangeCanvas
    .create(context(conversationId, userId))
    .execute('call-1', { groups } as never, undefined, undefined)
}

function image(id: string, mediaId: string, x: number): ProjectElement {
  return {
    id,
    type: 'image',
    mediaId,
    x,
    y: 100,
    width: 200,
    height: 150,
    rotation: 0,
    name: '旧名字',
  }
}

beforeEach(async () => {
  await db.delete(schema.canvas_projects)
  await db.delete(schema.agent_conversations)
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
  await db.insert(schema.agent_conversations).values({
    id: 'conv-1',
    user_id: USER,
    device_id: null,
    title: '整理',
    created_at: now,
    updated_at: now,
  })
})

afterAll(async () => {
  await closeDb()
})

async function project(document: ProjectDocument): Promise<void> {
  const now = Date.now()
  await db.insert(schema.canvas_projects).values({
    id: 'proj-1',
    user_id: USER,
    name: '画布',
    revision: 3,
    document,
    element_count: document.elements.length,
    conversation_id: 'conv-1',
    receipts: [],
    created_at: now,
    updated_at: now,
  })
}

it('places the named group to the right and writes the tabs', async () => {
  const document: ProjectDocument = {
    version: 1,
    elements: [
      {
        id: 'el-text',
        type: 'text',
        x: 0,
        y: 0,
        text: '别盖住我',
        fontSize: 18,
        fill: '#fff',
        width: 80,
        height: 20,
      },
      image('el-a', MEDIA_A, 400),
      image('el-b', MEDIA_B, 700),
    ],
  }
  await project(document)
  const groups = [
    {
      label: '古装角色',
      columns: 1,
      items: [{ elementId: 'el-a', caption: '韩湘子' }, { elementId: 'el-b' }],
    },
  ]

  const result = await run('conv-1', USER, groups)
  const text = result.content[0]
  if (text?.type !== 'text') throw new Error('arrangeCanvas should answer in text')
  expect(text.text).toContain('已把 2 张图排好')

  const expected = layoutCanvasArrange(groups, [
    { id: 'el-text', x: 0, y: 0, w: 80, h: 20 },
    { id: 'el-a', x: 400, y: 100, w: 200, h: 150 },
    { id: 'el-b', x: 700, y: 100, w: 200, h: 150 },
  ])
  expect(result.details?.canvasEdit?.edits).toEqual(
    expected.map((item) => ({
      elementId: item.elementId,
      x: item.x,
      y: item.y,
      ...(item.caption ? { name: item.caption } : {}),
      section: item.section,
    })),
  )
  const moved = result.details?.canvasEdit?.edits[0]
  expect(moved && moved.x > 80).toBe(true)
})

it('names the ids it could not place and still moves the rest', async () => {
  await project({
    version: 1,
    elements: [
      image('el-a', MEDIA_A, 0),
      {
        id: 'el-text',
        type: 'text',
        x: 0,
        y: 400,
        text: '文字',
        fontSize: 18,
        fill: '#fff',
        width: 40,
        height: 20,
      },
    ],
  })

  const result = await run('conv-1', USER, [
    {
      items: [
        { elementId: 'el-a', caption: '雀巢' },
        { elementId: 'missing' },
        { elementId: 'el-text' },
        { elementId: 'el-a' },
      ],
    },
  ])
  const text = result.content[0]
  if (text?.type !== 'text') throw new Error('arrangeCanvas should answer in text')
  expect(text.text).toContain('missing')
  expect(text.text).toContain('el-text')
  expect(text.text).toContain('el-a')
  expect(result.details?.canvasEdit?.edits).toHaveLength(1)
  expect(result.details?.canvasEdit?.edits[0]).toMatchObject({
    elementId: 'el-a',
    name: '雀巢',
  })
})

it('arranges the images on the open canvas when the server copy does not have them', async () => {
  const result = await arrangeCanvas
    .create({
      mode: 'image',
      conversationId: 'conv-1',
      turnId: 'turn-1',
      userId: null,
      deviceId: 'device-abcdefgh',
      images: { references: [], identify: () => undefined, attach: () => {} } as never,
      canvas: {
        elements: [
          { id: 'poster', type: 'image', x: 0, y: 0, width: 100, height: 80, name: '海报' },
          { id: 'code', type: 'image', x: 120, y: 0, width: 80, height: 80, name: '二维码' },
        ],
      },
    })
    .execute(
      'call-1',
      {
        groups: [
          {
            label: '素材',
            items: [
              { elementId: 'poster', caption: '海报' },
              { elementId: 'code', caption: '二维码' },
            ],
          },
        ],
      },
      undefined,
      undefined,
    )

  const edits = result.details?.canvasEdit?.edits ?? []
  expect(edits.map((edit) => edit.elementId)).toEqual(['poster', 'code'])
  expect(edits[0]).toMatchObject({ name: '海报', section: '素材' })
})

it('refuses to invent a layout when this turn has no server canvas', async () => {
  await expect(run('conv-1', null, [{ items: [{ elementId: 'el-a' }] }])).rejects.toMatchObject({
    name: 'AgentToolError',
  })
})
