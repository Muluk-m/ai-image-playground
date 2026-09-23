// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest'
import { getCloudProject, listCloudProjects } from '../../../../features/canvas/lib/projectClient'

const fetchMock = vi.hoisted(() => vi.fn())
vi.mock('../../../../lib/authClient', () => ({ authenticatedBffFetch: fetchMock }))
vi.mock('../../../../lib/runtimeConfig', () => ({
  bffBaseUrl: () => 'https://bff.test',
  getRuntimeConfig: () => ({ bff: { enabled: true, baseUrl: 'https://bff.test' } }),
}))

/** 传输层失败按 name 认；jsdom 里抛 DOMException 会被 vitest 当未处理拒绝，用普通 Error 打标。 */
function transportFailure(name: 'TimeoutError' | 'AbortError'): Error {
  const error = new Error(name === 'TimeoutError' ? 'signal timed out' : 'aborted')
  error.name = name
  return error
}

beforeEach(() => {
  fetchMock.mockReset()
})

it('读接口抖一次就再要一遍：超时不该直接变成「项目读不出来」', async () => {
  fetchMock
    .mockImplementationOnce(async () => {
      throw transportFailure('TimeoutError')
    })
    .mockResolvedValueOnce(Response.json({ projects: [], nextCursor: null }))

  await expect(listCloudProjects()).resolves.toEqual({ projects: [], nextCursor: null })
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

it('连着两次都没到达服务端才算失败', async () => {
  fetchMock.mockImplementation(async () => {
    throw transportFailure('TimeoutError')
  })

  let failure: unknown
  try {
    await listCloudProjects()
  } catch (error) {
    failure = error
  }
  expect((failure as Error).name).toBe('TimeoutError')
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

it('服务端答了就不重试：4xx/5xx 是回答，不是链路抖动', async () => {
  fetchMock.mockResolvedValue(Response.json({ error: 'unauthorized' }, { status: 401 }))

  await expect(listCloudProjects()).rejects.toMatchObject({ status: 401 })
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

it('调用方自己撤了就不再补发', async () => {
  const controller = new AbortController()
  fetchMock.mockImplementation(async () => {
    controller.abort()
    throw transportFailure('AbortError')
  })

  let failure: unknown
  try {
    await getCloudProject('p-1', controller.signal)
  } catch (error) {
    failure = error
  }
  expect((failure as Error).name).toBe('AbortError')
  expect(fetchMock).toHaveBeenCalledTimes(1)
})
