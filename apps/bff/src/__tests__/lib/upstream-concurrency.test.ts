import { expect, it } from 'bun:test'
import {
  acquireChannelSlot,
  channelGateCountForTesting,
  channelSlotStateForTesting,
} from '../../lib/upstream/concurrency'

it('hands a freed slot to the queue head before a newcomer can take it', async () => {
  const first = await acquireChannelSlot('gate-a', 1)
  const order: string[] = []
  const queued = acquireChannelSlot('gate-a', 1).then((release) => {
    order.push('queued')
    return release
  })
  first()
  // 释放与新请求在同一刻：新请求必须排在队首之后，同时在途不能超过 1。
  const newcomer = acquireChannelSlot('gate-a', 1).then((release) => {
    order.push('newcomer')
    return release
  })
  const releaseQueued = await queued
  expect(channelSlotStateForTesting('gate-a')).toEqual({ active: 1, waiting: 1 })
  releaseQueued()
  const releaseNewcomer = await newcomer
  releaseNewcomer()
  expect(order).toEqual(['queued', 'newcomer'])
})

it('drops an idle channel gate and ignores a second release', async () => {
  const before = channelGateCountForTesting()
  const release = await acquireChannelSlot('gate-b', 2)
  expect(channelGateCountForTesting()).toBe(before + 1)
  release()
  release()
  expect(channelGateCountForTesting()).toBe(before)
  expect(channelSlotStateForTesting('gate-b')).toEqual({ active: 0, waiting: 0 })
})

it('rejects at once when the signal is already aborted', async () => {
  const controller = new AbortController()
  controller.abort()
  await expect(acquireChannelSlot('gate-c', 1, controller.signal)).rejects.toBeDefined()
  expect(channelSlotStateForTesting('gate-c')).toEqual({ active: 0, waiting: 0 })
})
