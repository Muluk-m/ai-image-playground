import { describe, expect, it } from 'bun:test'
import { SafeFetchError } from '../../../lib/safeFetch'
import {
  AgentToolError,
  confirmedSubmissionText,
  createToolFailureLog,
  isSealLease,
  mergeMaskedPlanCarries,
  noModelMessage,
  queueArtifacts,
  queueParamsFor,
  queueRefusalCode,
  SEAL_LEASE_PREFIX,
  safeFetchToolError,
  selectionSettings,
  toolErrorText,
  toolResultBlock,
  wakeReviewImageIds,
  wakeTurnSetup,
} from '../../../modules/agent/contracts'

describe('modules/agent/contracts', () => {
  it('classifies tool errors, queue refusals, and safeFetch failures consistently', () => {
    expect(queueRefusalCode('insufficient_credits')).toBe('insufficient_credits')
    expect(queueRefusalCode('private_billing_denied')).toBe('invalid_params')
    expect(queueRefusalCode('price_unavailable')).toBe('model_unavailable')
    expect(queueRefusalCode('idempotency_conflict')).toBe('upstream_error')

    const log = createToolFailureLog()
    log.started('call-1')
    log.failed('call-1', new AgentToolError('timeout', 'timed out'), false)
    expect(log.take('call-1', false)).toBe('timeout')
    // Unstarted tool call failed schema validation inside pi
    expect(log.take('call-never-started', false)).toBe('invalid_params')
    expect(log.take('call-aborted', true)).toBe('cancelled')

    const timeoutErr = safeFetchToolError(new SafeFetchError('timeout', 'fetch timed out'))
    expect(timeoutErr).toBeInstanceOf(AgentToolError)
    expect((timeoutErr as AgentToolError).code).toBe('timeout')

    const networkErr = safeFetchToolError(new SafeFetchError('network', 'socket closed'))
    expect((networkErr as AgentToolError).code).toBe('upstream_error')

    const blockedErr = safeFetchToolError(new SafeFetchError('blocked_url', 'private ip'))
    expect((blockedErr as AgentToolError).code).toBe('source_unavailable')
  })

  it('builds toolResultBlock, seal lease checks, queue params, and artifacts', () => {
    expect(isSealLease(`${SEAL_LEASE_PREFIX}abc`)).toBe(true)
    expect(isSealLease('turn-123')).toBe(false)

    expect(toolErrorText({ content: [{ type: 'text', text: 'bad input' }] })).toBe('bad input')
    expect(toolErrorText({})).toBe('工具执行失败')

    const failed = toolResultBlock(
      { toolCallId: 'tc-1', toolName: 'generateImage', title: '生图' },
      { content: [{ type: 'text', text: '余额不足' }] },
      'insufficient_credits',
    )
    expect(failed).toMatchObject({
      type: 'toolResult',
      toolCallId: 'tc-1',
      status: 'failed',
      errorCode: 'insufficient_credits',
      message: '余额不足',
    })

    const gifParams = queueParamsFor('openai-compat', {
      output_format: 'gif',
      frame_count: 8,
      frame_duration_ms: 120,
      output_compression: 80,
    })
    expect(gifParams).toEqual({
      output_format: 'gif',
      quality: 'medium',
      frame_count: 8,
      frame_duration_ms: 120,
      output_compression: 80,
    })

    expect(confirmedSubmissionText('image', 'blue cat')).toContain('执行提示词：blue cat。')
    expect(noModelMessage('video')).toBe('暂时没有可用的生视频模型')
    expect(
      queueArtifacts('task-1', 'image', {
        images: [{ index: 0, mime: 'image/png', width: 512, height: 512 }],
      }),
    ).toHaveLength(1)

    expect(selectionSettings.maxPixels).toBeGreaterThan(0)
    expect(
      mergeMaskedPlanCarries([
        { authorization: 'a', protected: false, contents: ['c1'], deferred: ['d1'] },
        { authorization: 'b', protected: true, contents: ['c1', 'c2'], deferred: ['d2'] },
      ]),
    ).toEqual({
      authorization: 'b',
      protected: true,
      contents: ['c1', 'c2'],
      deferred: ['d2'],
    })
    expect(wakeTurnSetup([])).toEqual({ mode: 'image' })
    expect(wakeReviewImageIds([])).toEqual([])
  })
})
