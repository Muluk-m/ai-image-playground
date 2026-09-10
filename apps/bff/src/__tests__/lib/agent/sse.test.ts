import { describe, expect, it } from 'bun:test'
import type { AgentTurnEvent } from '@image-playground/shared'
import type { StoredAgentEvent } from '../../../lib/agent/events'
import { agentTurnStream } from '../../../lib/agent/sse'
import { parseFrames } from '../../helpers/agentStubs'

const TURN_END: AgentTurnEvent = {
  type: 'turnEnd',
  turnId: 'turn-1',
  durationMs: 5,
  stopReason: 'completed',
  usage: null,
}

/** 一条前半段沉默的流：工具执行或模型迟迟不吐首字时就是这个形状。 */
async function* silentThenEnd(silentMs: number): AsyncGenerator<StoredAgentEvent> {
  yield { seq: 7, event: { type: 'assistantStart', messageId: 'a1' } }
  await Bun.sleep(silentMs)
  yield { seq: 8, event: TURN_END }
}

describe('agentTurnStream', () => {
  it('沉默期补心跳，轮照常收尾', async () => {
    const response = agentTurnStream(silentThenEnd(60), 10)

    const payload = await response.text()

    expect(payload).toContain(': ping')
    expect(parseFrames(payload).map((frame) => frame.id)).toEqual([7, 8])
    expect(parseFrames(payload).at(-1)!.event).toEqual(TURN_END)
  })

  it('帧的 id 是事件表里的序号，不是响应内的计数', async () => {
    async function* tail(): AsyncGenerator<StoredAgentEvent> {
      yield { seq: 42, event: { type: 'textDelta', messageId: 'a1', delta: '好' } }
      yield { seq: 43, event: TURN_END }
    }

    const frames = parseFrames(await agentTurnStream(tail()).text())

    expect(frames.map((frame) => frame.id)).toEqual([42, 43])
  })

  it('反代不缓冲响应，逐字流才不会被攒成一坨', () => {
    const response = agentTurnStream(silentThenEnd(0))

    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(response.headers.get('x-accel-buffering')).toBe('no')
  })
})
