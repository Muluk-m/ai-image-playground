import { expect, it } from 'bun:test'
import {
  AgentToolError,
  createToolFailureLog,
  invalidParams,
  queueRefusalCode,
  taskFailureCode,
} from '../../../../lib/agent/tools/errors'

it('classifies every way a queue submission can be refused', () => {
  expect(queueRefusalCode('insufficient_credits')).toBe('insufficient_credits')
  expect(queueRefusalCode('quota_exceeded')).toBe('quota_exceeded')
  expect(queueRefusalCode('authentication_required')).toBe('authentication_required')
  expect(queueRefusalCode('invalid_input_image')).toBe('invalid_params')
  expect(queueRefusalCode('price_unavailable')).toBe('model_unavailable')
  expect(queueRefusalCode('object_storage_error')).toBe('upstream_error')
  expect(queueRefusalCode('idempotency_conflict')).toBe('upstream_error')
})

it('classifies the failure a worker recorded on the task', () => {
  expect(taskFailureCode('upstream_timeout')).toBe('timeout')
  expect(taskFailureCode('upstream_no_image')).toBe('no_output')
  expect(taskFailureCode('upstream_error')).toBe('upstream_error')
  expect(taskFailureCode('interrupted')).toBe('upstream_error')
  expect(taskFailureCode(null)).toBe('upstream_error')
})

it('keeps a classified error and marks everything else in a parameter check as invalid', async () => {
  const kept = new AgentToolError('model_unavailable', '没有模型')
  await expect(invalidParams(() => Promise.reject(kept))).rejects.toBe(kept)
  const wrapped = await invalidParams(() => Promise.reject(new Error('选区对不上'))).catch(
    (thrown: unknown) => thrown,
  )
  expect(wrapped).toBeInstanceOf(AgentToolError)
  expect(wrapped).toMatchObject({ code: 'invalid_params', message: '选区对不上' })
})

it('remembers why each tool call failed, apart from the text pi keeps', () => {
  const log = createToolFailureLog()
  log.started('a')
  log.failed('a', new AgentToolError('insufficient_credits', '积分不够'), false)
  expect(log.take('a', false)).toBe('insufficient_credits')

  // 没分类的错误：用户中止时算取消，否则说不清。
  log.started('b')
  log.failed('b', new Error('这一轮被中止了'), true)
  expect(log.take('b', false)).toBe('cancelled')
  log.started('c')
  log.failed('c', new Error('意外'), false)
  expect(log.take('c', false)).toBe('unknown')

  // 工具根本没被调起：pi 在执行前的参数校验就拦下了它。
  expect(log.take('never-ran', false)).toBe('invalid_params')
  expect(log.take('never-ran', true)).toBe('cancelled')
})
