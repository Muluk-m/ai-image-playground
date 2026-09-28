import { afterEach, describe, expect, it } from 'bun:test'
import { user } from '../../helpers/agentMessages'
import type { ChatCall } from '../../helpers/chatStubs'
import { chatCompletion, chatFetchReturning, recordingChatFetch } from '../../helpers/chatStubs'

process.env.PORT = '0'
process.env.DATABASE_URL = 'postgres://unused/compaction-summary'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
process.env.AGENT_SUMMARY_MODEL = 'fixture-summary-model'
process.env.AGENT_SUMMARY_CONTEXT_WINDOW = '6000'
process.env.OPERATOR_CONFIG_FILE = ''

const { setChatFetchForTesting, setChatRetryBackoffForTesting } = await import(
  '../../../lib/chatCompletion'
)
// 这几条测试故意让上游 502/503：重试真退避要花掉一秒半墙钟，换不来任何确定性。
setChatRetryBackoffForTesting(0)
const { summarizeCompaction, summaryChunkBudget } = await import(
  '../../../lib/agent/compaction-summary'
)

const NARRATIVE = {
  completed: '出了三张马克杯图',
  inProgress: '在调背景色',
  decisions: '主体不换',
  artifacts: 'img-1、img-2',
}

afterEach(() => {
  setChatFetchForTesting()
})

describe('summarizeCompaction', () => {
  it('reserves prompt, prior summary and output inside the summary model window', () => {
    const emptyBudget = summaryChunkBudget(null)
    const previousBudget = summaryChunkBudget({ ...NARRATIVE, completed: '旧结论'.repeat(500) })
    expect(emptyBudget).toBeLessThan(6_000 - 1_500)
    expect(previousBudget).toBeLessThan(emptyBudget)
  })

  it('does not send a summary request that exceeds the summary model window', async () => {
    const calls: ChatCall[] = []
    setChatFetchForTesting(
      recordingChatFetch(calls, () => chatCompletion(JSON.stringify(NARRATIVE))),
    )
    expect(
      await summarizeCompaction({
        messages: [user('m1', '很长的用户内容'.repeat(5_000))],
        previousSummary: null,
      }),
    ).toBeNull()
    expect(calls).toHaveLength(0)
  })

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
    expect(calls[0]!.prompt).toContain('保留用户要表达的核心意思')
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
