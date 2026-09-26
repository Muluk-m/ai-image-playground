import { describe, expect, it, vi } from 'vitest'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import {
  prepareProjectMedia,
  projectDocument,
  projectScene,
} from '../../../../features/canvas/lib/projectMedia'

const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
vi.mock('../../../../lib/canvasImage', () => ({
  imageDataUrlToPngBlob: vi.fn(async () => new Blob([PNG_BYTES], { type: 'image/png' })),
}))

describe('上云的项目文档', () => {
  it('bounds an over-long meta value instead of failing the whole document', () => {
    const doc = new CanvasDoc()
    const mediaId = '0f8b6a4e-2c1d-4e5f-9a7b-3c2d1e0f9a8b'
    doc.addElements(
      [
        {
          id: 'img',
          type: 'image',
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          rotation: 0,
          fileId: 'f',
          meta: { prompt: '短', userPrompt: '长'.repeat(12000) },
        },
      ],
      { files: { f: `aip-media:${mediaId}` } },
    )

    const document = projectDocument(doc)

    expect(document).not.toBeNull()
    const image = document!.elements[0] as { meta: Record<string, string> }
    expect(image.meta.userPrompt).toHaveLength(10000)
    expect(image.meta.prompt).toBe('短')
    // 本机画布保留原文。
    const local = doc.getElement('img')
    expect(local?.type === 'image' && local.meta?.userPrompt).toHaveLength(12000)
  })
})

describe('云端项目的失败占位', () => {
  const generationId = '70cf33ea-d548-4a2b-ab0b-4a10e2e444fb'
  const reservation = {
    id: `agent_${generationId}_0`,
    type: 'generation' as const,
    generationId,
    position: 0,
    x: 24,
    y: 0,
    width: 360,
    height: 360,
  }

  it('restores a failed reservation as a failed agent placeholder with its error code', () => {
    const scene = projectScene(
      { version: 1, elements: [{ ...reservation, errorCode: 'timeout' }] },
      new Map(),
      'conversation-1',
    )

    expect(scene.elements).toMatchObject([
      {
        id: reservation.id,
        type: 'placeholder',
        status: 'error',
        meta: {
          agent: true,
          agentErrorCode: 'timeout',
          agentConversationId: 'conversation-1',
          cloudGeneration: { id: generationId, position: 0 },
        },
      },
    ])
  })

  it('keeps a running reservation loading and writes both back unchanged', () => {
    const remote = {
      version: 1 as const,
      elements: [
        reservation,
        {
          ...reservation,
          id: `agent_${generationId}_1`,
          position: 1,
          errorCode: 'no_output' as const,
        },
      ],
    }
    const doc = new CanvasDoc()
    const scene = projectScene(remote)
    doc.restore(scene.elements, scene.files)

    expect(doc.elements.map((one) => one.type === 'placeholder' && one.status)).toEqual([
      'loading',
      'error',
    ])
    expect(projectDocument(doc)).toEqual(remote)
  })
})

describe('只在本机的失败占位', () => {
  it('leaves a refused agent call out of the cloud document so the project keeps syncing', () => {
    const doc = new CanvasDoc()
    doc.addElements([
      {
        id: 'refused',
        type: 'placeholder',
        x: 0,
        y: 0,
        width: 360,
        height: 360,
        status: 'error',
        message: '',
        meta: {
          taskId: '',
          clientRequestId: 'group',
          source: 'builtin-edge',
          prompt: '一只橘猫',
          agent: true,
          agentErrorCode: 'insufficient_credits',
        },
      },
    ])

    expect(projectDocument(doc)).toEqual({ version: 1, elements: [] })
  })
})

describe('本机原图上云', () => {
  /** 最小 WebP：`RIFF` + 长度 + `WEBP`。够让嗅探认出它不是 PNG。 */
  const WEBP_BYTES = Uint8Array.from([
    0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x4c,
  ])

  it('按真实字节申报类型，不信 data URL 上写的那一行', async () => {
    // 画布上的原图曾被贴上 `data:image/png` 却装着 WebP 字节：服务端解出 webp、对不上申报的
    // png，确认那一步 422 media_invalid_image，整批图于是一张都上不去。
    const source = 'data:image/png;base64,UklGRhoAAABXRUJQVlA4TA=='
    const doc = new CanvasDoc()
    doc.addElements(
      [
        {
          id: 'img',
          type: 'image',
          fileId: 'f',
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          rotation: 0,
        },
      ],
      { files: { f: source } },
    )
    const declared: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === source)
          return new Response(WEBP_BYTES, { headers: { 'content-type': 'image/png' } })
        if (url.endsWith('/uploads')) {
          declared.push(JSON.parse(init!.body as string).contentType)
          return Response.json({ id: '3f1d2c5b-8a90-4b21-9d64-7c0e5a1b2f33', status: 'ready' })
        }
        throw new Error(`unexpected request: ${url}`)
      }),
    )

    await prepareProjectMedia(doc, {}, new Map(), new AbortController().signal)

    expect(declared).toEqual(['image/webp'])
    vi.unstubAllGlobals()
  })

  it('云媒体不收的格式（SVG）先转成 PNG 再传，不让一张图卡住整个项目的同步', async () => {
    const source = `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>')}`
    const doc = new CanvasDoc()
    doc.addElements(
      [{ id: 'img', type: 'image', fileId: 'f', x: 0, y: 0, width: 4, height: 4, rotation: 0 }],
      { files: { f: source } },
    )
    const declared: { contentType: string; bytes: number }[] = []
    const put: number[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === source) return new Response(atob(source.split(',')[1]!))
        if (url.endsWith('/uploads')) {
          declared.push(JSON.parse(init!.body as string))
          return Response.json({ id: 'u1', status: 'pending', uploadUrl: 'https://r2/put' })
        }
        if (url === 'https://r2/put') {
          put.push((init!.body as ArrayBuffer).byteLength)
          return new Response(null, { status: 200 })
        }
        if (url.endsWith('/u1/complete')) return Response.json({ id: 'u1', status: 'ready' })
        throw new Error(`unexpected request: ${url}`)
      }),
    )
    const persisted = {}
    const loaded = new Map()

    await prepareProjectMedia(doc, persisted, loaded, new AbortController().signal)

    expect(declared).toEqual([
      expect.objectContaining({ contentType: 'image/png', bytes: PNG_BYTES.length }),
    ])
    expect(put).toEqual([PNG_BYTES.length])
    expect(loaded.get('f')).toMatchObject({ id: 'u1', source })
    vi.unstubAllGlobals()
  })

  it('并发补传：同时最多 4 张，一张被拒不耽误其余的传完', async () => {
    const doc = new CanvasDoc()
    const files: Record<string, string> = {}
    const elements = Array.from({ length: 6 }, (_, index) => {
      files[`f${index}`] = `data:image/png;base64,img${index}`
      return {
        id: `img${index}`,
        type: 'image' as const,
        fileId: `f${index}`,
        x: 0,
        y: 0,
        width: 4,
        height: 4,
        rotation: 0,
      }
    })
    doc.addElements(elements, { files })
    let inFlight = 0
    let peak = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.startsWith('data:'))
          return new Response(Uint8Array.from([...PNG_BYTES, url.length]))
        if (url.endsWith('/uploads')) {
          inFlight += 1
          peak = Math.max(peak, inFlight)
          await new Promise((resolve) => setTimeout(resolve, 5))
          inFlight -= 1
          const { sha256 } = JSON.parse(init!.body as string)
          if (declaredOrder.push(sha256) === 1)
            return Response.json({ error: 'invalid_request' }, { status: 400 })
          return Response.json({ id: crypto.randomUUID(), status: 'ready' })
        }
        throw new Error(`unexpected request: ${url}`)
      }),
    )
    const declaredOrder: string[] = []
    const loaded = new Map()

    await expect(
      prepareProjectMedia(doc, {}, loaded, new AbortController().signal),
    ).rejects.toBeTruthy()

    expect(peak).toBeLessThanOrEqual(4)
    expect(peak).toBeGreaterThan(1)
    expect(loaded.size).toBe(5)
    vi.unstubAllGlobals()
  })
})
