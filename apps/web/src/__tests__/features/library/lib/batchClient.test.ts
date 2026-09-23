import { beforeEach, describe, expect, it, vi } from 'vitest'

const DEVICE = 'device-abcdefgh'
const fetcher = vi.fn()

vi.mock('../../../../lib/deviceId', () => ({ getDeviceId: () => DEVICE }))
vi.mock('../../../../lib/runtimeConfig', () => ({
  bffBaseUrl: () => 'https://bff.test',
  getRuntimeConfig: () => ({ bff: { enabled: true } }),
}))
vi.mock('../../../../lib/authClient', () => ({
  authenticatedBffFetch: (url: string, init?: RequestInit) => fetcher(url, init),
}))

import { LookBatchError, submitLookBatch } from '../../../../features/library/lib/batchClient'

function accepted(tasks: unknown) {
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ tasks }), { status: 200 }))
}

function sentBody(): Record<string, unknown> {
  return JSON.parse(String(fetcher.mock.calls[0]![1].body))
}

describe('submitLookBatch', () => {
  beforeEach(() => {
    fetcher.mockClear()
  })

  it('把模板、素材顺序、张数与设备标识一起发给批量端点', async () => {
    accepted([{ assetIds: ['cup'], taskId: 'task-1' }])

    const result = await submitLookBatch({
      lookId: 'look-1',
      assetIds: ['cup', 'lamp'],
      perAsset: 2,
      counts: { lamp: 4 },
    })

    expect(fetcher.mock.calls[0]![0]).toBe('https://bff.test/api/looks/batch')
    expect(fetcher.mock.calls[0]![1].method).toBe('POST')
    expect(sentBody()).toEqual({
      lookId: 'look-1',
      assetIds: ['cup', 'lamp'],
      perAsset: 2,
      counts: { lamp: 4 },
      device_id: DEVICE,
    })
    expect(result.tasks).toEqual([{ assetIds: ['cup'], taskId: 'task-1' }])
  })

  it('没给的那一项不出现在请求体里，空的每条张数表也不发', async () => {
    accepted([])

    await submitLookBatch({ skillName: 'look-seaview-hotel', assetIds: ['cup'], perAsset: 1 })

    expect(sentBody()).toEqual({
      skillName: 'look-seaview-hotel',
      assetIds: ['cup'],
      perAsset: 1,
      device_id: DEVICE,
    })
  })

  it('被拒时带出拒绝码与那条素材，调用方据此指名道姓', async () => {
    fetcher.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'slot_mismatch', assetId: 'lamp' }), { status: 422 }),
    )

    const failure = await submitLookBatch({
      lookId: 'look-1',
      assetIds: ['lamp'],
      perAsset: 1,
    }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(LookBatchError)
    expect(failure).toMatchObject({
      status: 422,
      code: 'slot_mismatch',
      detail: { assetId: 'lamp' },
    })
  })

  it('响应体不是 JSON 时也给一个能显示的拒绝码', async () => {
    fetcher.mockResolvedValueOnce(new Response('<html>502</html>', { status: 502 }))

    const failure = await submitLookBatch({
      lookId: 'look-1',
      assetIds: ['lamp'],
      perAsset: 1,
    }).catch((error: unknown) => error)

    expect(failure).toMatchObject({ status: 502, code: 'look_batch_failed', detail: {} })
  })
})
