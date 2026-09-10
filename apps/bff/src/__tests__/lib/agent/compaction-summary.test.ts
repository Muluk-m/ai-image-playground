import { afterEach, describe, expect, it } from 'bun:test'
import type { CompactionMessage } from '../../../lib/agent/compaction'
import type { ChatCall } from '../../helpers/chatStubs'
import { chatCompletion, chatFetchReturning, recordingChatFetch } from '../../helpers/chatStubs'

process.env.PORT = '0'
process.env.DATABASE_URL = 'postgres://unused/compaction-summary'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
process.env.AGENT_SUMMARY_MODEL = 'fixture-summary-model'
process.env.OPERATOR_CONFIG_FILE = ''

const { setChatFetchForTesting } = await import('../../../lib/chatCompletion')
const { summarizeCompaction } = await import('../../../lib/agent/compaction-summary')

const NARRATIVE = {
  completed: '出了三张马克杯图',
  inProgress: '在调背景色',
  decisions: '主体不换',
  artifacts: 'img-1、img-2',
}

function user(id: string, text: string): CompactionMessage {
  return { id, message: { role: 'user', content: [{ type: 'text', text }], timestamp: 1 } }
}

afterEach(() => {
  setChatFetchForTesting()
})

describe('summarizeCompaction', () => {
  it('asks the configured summary model and returns the fixed sections', async () => {
    const calls: ChatCall[] = []
    setChatFetchForTesting(
      recordingChatFetch(calls, () => chatCompletion(JSON.stringify(NARRATIVE))),
    )

    const narrative = await summarizeCompaction({
      messages: [user('m1', '把主体换成白色马克杯')],
      previousSummary: null,
    })

    expect(narrative).toEqual(NARRATIVE)
    expect(calls[0]!.model).toBe('fixture-summary-model')
    expect(calls[0]!.prompt).toContain('把主体换成白色马克杯')
    expect(calls[0]!.prompt).not.toContain('上一版摘要')
  })

  it('hands the previous summary over when folding incrementally', async () => {
    const calls: ChatCall[] = []
    setChatFetchForTesting(
      recordingChatFetch(calls, () => chatCompletion(JSON.stringify(NARRATIVE))),
    )

    await summarizeCompaction({
      messages: [user('m2', '背景换成浅木色')],
      previousSummary: NARRATIVE,
    })

    expect(calls[0]!.prompt).toContain('上一版摘要')
    expect(calls[0]!.prompt).toContain('出了三张马克杯图')
  })

  it('returns null instead of throwing when the upstream fails', async () => {
    setChatFetchForTesting(chatFetchReturning(new Response('nope', { status: 502 })))

    expect(await summarizeCompaction({ messages: [user('m1', 'a')], previousSummary: null })).toBe(
      null,
    )
  })

  it('returns null when the model answers with an unusable shape', async () => {
    setChatFetchForTesting(chatFetchReturning(chatCompletion('{"completed": 5}')))

    expect(await summarizeCompaction({ messages: [user('m1', 'a')], previousSummary: null })).toBe(
      null,
    )
  })
})
