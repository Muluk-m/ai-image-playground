// @vitest-environment jsdom
import { CLIENT_ERRORS_PATH } from '@image-playground/shared'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  _resetErrorReportingForTesting,
  configureErrorReporting,
  flushClientErrors,
  reportClientError,
} from '../../lib/errorReporting'

/** jsdom's Blob has no `text()`. */
function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsText(blob)
  })
}

const sendBeacon = vi.fn((_url: string, _body: Blob) => true)
beforeEach(() => {
  _resetErrorReportingForTesting()
  sendBeacon.mockClear()
  Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: sendBeacon })
  window.history.replaceState(null, '', '/workspace?code=secret#/projects')
})
afterEach(() => {
  Reflect.deleteProperty(navigator, 'sendBeacon')
})

async function sentBodies() {
  return Promise.all(
    sendBeacon.mock.calls.map(async ([url, blob]) => ({
      url,
      body: JSON.parse(await readBlob(blob)),
    })),
  )
}

it('holds reports until the BFF address is known, then sends them without the query', async () => {
  reportClientError('error', new TypeError('x is undefined'))
  expect(sendBeacon).not.toHaveBeenCalled()

  configureErrorReporting('https://api.example.test/')
  flushClientErrors()
  const [sent] = await sentBodies()
  expect(sent?.url).toBe(`https://api.example.test${CLIENT_ERRORS_PATH}`)
  expect(sent?.body.errors).toEqual([
    expect.objectContaining({
      kind: 'error',
      name: 'TypeError',
      message: 'x is undefined',
      url: 'http://localhost:3000/workspace#/projects',
    }),
  ])
  expect(typeof sent?.body.deviceId).toBe('string')
})

it('drops everything on deployments without a BFF', () => {
  reportClientError('rejection', 'boom')
  configureErrorReporting(null)
  reportClientError('rejection', 'boom again')
  flushClientErrors()
  expect(sendBeacon).not.toHaveBeenCalled()
})

it('caps repeats of the same error and ignores browser noise', async () => {
  configureErrorReporting('')
  for (let i = 0; i < 10; i += 1) reportClientError('error', new Error('loop'))
  reportClientError('error', 'ResizeObserver loop completed with undelivered notifications.')
  flushClientErrors()
  const [sent] = await sentBodies()
  expect(sent?.url).toBe(CLIENT_ERRORS_PATH)
  expect(sent?.body.errors).toHaveLength(3)
})

it('splits batches by encoded size so long multibyte stacks still arrive', async () => {
  configureErrorReporting('')
  for (let i = 0; i < 8; i += 1) {
    const error = new Error(`第 ${i} 个错误`)
    error.stack = '堆栈'.repeat(4000)
    reportClientError('error', error)
  }
  vi.useFakeTimers()
  try {
    flushClientErrors()
    // 一拍只发 48 KiB，剩下的留到下一拍，不挤爆浏览器的在途配额。
    const firstTick = sendBeacon.mock.calls.reduce((sum, [, blob]) => sum + blob.size, 0)
    expect(firstTick).toBeLessThanOrEqual(48 * 1024)
    await vi.runAllTimersAsync()
  } finally {
    vi.useRealTimers()
  }
  const bodies = await sentBodies()
  expect(bodies.length).toBeGreaterThan(1)
  expect(bodies.flatMap((sent) => sent.body.errors)).toHaveLength(8)
  for (const [, blob] of sendBeacon.mock.calls) expect(blob.size).toBeLessThanOrEqual(24 * 1024)
})
