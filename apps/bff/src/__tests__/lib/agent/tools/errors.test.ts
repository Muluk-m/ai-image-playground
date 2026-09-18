import { expect, it } from 'bun:test'
import {
  AgentToolError,
  createToolFailureLog,
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
  // 执行者丢了或上游结局查不到：可能已经出图计费，不能归进可重试的类。
  expect(taskFailureCode('interrupted')).toBe('result_unknown')
  expect(taskFailureCode('upstream_result_unknown')).toBe('result_unknown')
  expect(taskFailureCode('object_storage_error')).toBe('upstream_error')
  expect(taskFailureCode(null)).toBe('upstream_error')
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
