// @vitest-environment jsdom
import { CLIENT_ERRORS_PATH } from '@image-playground/shared'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  _resetErrorReportingForTesting,
  configureErrorReporting,
  flushClientErrors,
  reportClientError,
  reportRecoverableClientError,
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

it('preserves a bounded cause chain and reports a handled Error instance only once', async () => {
  configureErrorReporting('')
  const original = new DOMException('Storage temporarily unavailable', 'UnknownError')
  const error = Object.assign(new Error('Project catalog unavailable'), { cause: original })
  reportClientError('error', error, { operation: 'project.catalog', stage: 'read-local' })
  reportClientError('rejection', error)
  flushClientErrors()
  const [sent] = await sentBodies()
  expect(sent?.body.errors).toHaveLength(1)
  expect(sent?.body.errors[0].context).toMatchObject({
    stage: 'read-local',
    causes: [{ name: 'UnknownError', message: 'Storage temporarily unavailable' }],
  })
})

it('terminates cyclic causes without serializing arbitrary error properties', async () => {
  configureErrorReporting('')
  const cause = Object.assign(new Error('underlying'), { token: 'never-serialize' })
  const error = Object.assign(new Error('outer'), { cause })
  Reflect.set(cause, 'cause', error)
  reportClientError('error', error)
  flushClientErrors()
  const [sent] = await sentBodies()
  expect(sent?.body.errors[0].context.causes).toHaveLength(1)
  expect(JSON.stringify(sent?.body)).not.toContain('never-serialize')
})

it('sends recovery evidence only after explicit success, separately from errors and only once', async () => {
  configureErrorReporting('')
  const recovered = reportRecoverableClientError(new Error('failed'), {
    operation: 'project.catalog',
    stage: 'read-local',
  })
  flushClientErrors()
  const [failure] = await sentBodies()
  expect(failure?.body.recoveries).toBeUndefined()
  recovered()
  recovered()
  flushClientErrors()
  const bodies = await sentBodies()
  expect(bodies).toHaveLength(2)
  expect(bodies[1]?.body).toMatchObject({
    errors: [],
    recoveries: [
      {
        incidentId: failure?.body.errors[0].context.incidentId,
        operation: 'project.catalog',
      },
    ],
  })
})

it('retains diagnosis and recovery identity when a multibyte stack exceeds the payload budget', async () => {
  configureErrorReporting('')
  const error = Object.assign(new Error('Project catalog unavailable'), {
    cause: new DOMException('Storage unavailable', 'UnknownError'),
  })
  error.stack = '堆栈'.repeat(4000)
  reportRecoverableClientError(error, { operation: 'project.catalog', stage: 'read-local' })
  flushClientErrors()
  const [sent] = await sentBodies()
  expect(sent?.body.errors[0].context.incidentId).toEqual(expect.any(String))
  expect(sent?.body.errors[0].context.causes[0].name).toBe('UnknownError')
  expect(sendBeacon.mock.calls[0]?.[1].size).toBeLessThanOrEqual(24 * 1024)
})

it('does not upload arbitrary properties of an object cause without a message', async () => {
  configureErrorReporting('')
  const cause = {
    token: 'private-token',
    response: { body: 'private-response' },
    name: 'RemoteFailure',
    status: 502,
    code: 'bad_gateway',
  }
  reportClientError('error', Object.assign(new Error('Failed'), { cause }))
  flushClientErrors()
  const [sent] = await sentBodies()
  expect(sent?.body.errors[0].context.causes).toEqual([
    { name: 'RemoteFailure', message: 'Non-error cause', status: 502, code: 'bad_gateway' },
  ])
  expect(JSON.stringify(sent?.body)).not.toContain('private-')
})

it('bounds escaped cause chains to the server context limit while retaining recovery identity', async () => {
  configureErrorReporting('')
  let cause: unknown
  for (let i = 0; i < 4; i++)
    cause = Object.assign(new Error('\\'.repeat(1000)), { cause, stack: '\n'.repeat(1500) })
  const recovered = reportRecoverableClientError(
    Object.assign(new Error('catalog failed'), { cause }),
    { operation: 'project.catalog', stage: 'read-local' },
  )
  flushClientErrors()
  recovered()
  flushClientErrors()
  const [failure, success] = await sentBodies()
  const context = failure?.body.errors[0].context
  expect(JSON.stringify(context).length).toBeLessThanOrEqual(16 * 1024)
  expect(context).toMatchObject({
    operation: 'project.catalog',
    stage: 'read-local',
    incidentId: expect.any(String),
  })
  expect(context.causes).toHaveLength(4)
  expect(success?.body.recoveries[0].incidentId).toBe(context.incidentId)
})

it('retains incident identity when unrelated context is oversized or cyclic', async () => {
  configureErrorReporting('')
  const extra: Record<string, unknown> = { text: 'x'.repeat(20 * 1024) }
  extra.self = extra
  reportRecoverableClientError(
    Object.assign(new Error('failed'), { cause: new Error('original') }),
    { operation: 'project.catalog', stage: 'read-local', extra },
  )
  flushClientErrors()
  const [sent] = await sentBodies()
  const context = sent?.body.errors[0].context
  expect(JSON.stringify(context).length).toBeLessThanOrEqual(16 * 1024)
  expect(context).toMatchObject({
    operation: 'project.catalog',
    stage: 'read-local',
    incidentId: expect.any(String),
    causes: [{ name: 'Error', message: 'original' }],
  })
})

it('queues a recoverable diagnostic even when enumerable context getters throw', async () => {
  configureErrorReporting('')
  const context = {
    operation: 'project.catalog' as const,
    stage: 'read-local',
    get extra() {
      throw new Error('getter failed')
    },
  }
  const error = Object.assign(new Error('catalog failed'), { cause: new Error('original') })
  const recovered = reportRecoverableClientError(error, context)
  reportClientError('rejection', error)
  flushClientErrors()
  recovered()
  flushClientErrors()
  const [failure, success] = await sentBodies()
  expect(failure?.body.errors).toHaveLength(1)
  expect(failure?.body.errors[0].context).toMatchObject({
    operation: 'project.catalog',
    stage: 'read-local',
    causes: [{ name: 'Error', message: 'original' }],
  })
  expect(success?.body.recoveries[0].incidentId).toBe(failure?.body.errors[0].context.incidentId)
})

it('ignores inaccessible diagnostic identity fields without throwing or losing the error', async () => {
  configureErrorReporting('')
  const context = {
    get stage() {
      throw new Error('getter failed')
    },
    get online() {
      throw new Error('getter failed')
    },
  }
  expect(() => reportClientError('error', new Error('original'), context)).not.toThrow()
  flushClientErrors()
  const [sent] = await sentBodies()
  expect(sent?.body.errors[0].message).toBe('original')
})

it('keeps the root cause and incident within the HTTP byte limit for multibyte context', async () => {
  configureErrorReporting('')
  let cause: unknown
  for (let i = 0; i < 4; i++)
    cause = Object.assign(new Error('原因'.repeat(500)), { cause, stack: '堆栈'.repeat(750) })
  const error = Object.assign(new Error('catalog failed'), { cause, stack: '堆栈'.repeat(4000) })
  reportRecoverableClientError(error, { operation: 'project.catalog', stage: 'read-local' })
  flushClientErrors()
  const [sent] = await sentBodies()
  const context = sent?.body.errors[0].context
  expect(context).toMatchObject({
    operation: 'project.catalog',
    stage: 'read-local',
    incidentId: expect.any(String),
  })
  expect(context.causes.at(-1).message).toContain('原因')
  expect(sendBeacon.mock.calls[0]?.[1].size).toBeLessThanOrEqual(24 * 1024)
})
