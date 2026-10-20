import { expect, it } from 'bun:test'
import { QUEUE_TIMEOUTS } from '../../../../../packages/shared/src/queue-protocol'
import { reconcilingDue, shouldConfirmNoResult } from '../../lib/reconcile-timing'

const now = 1_700_000_000_000

it('waits five minutes after a task enters result confirmation, and treats an unknown start as due', () => {
  expect(reconcilingDue(now, now, QUEUE_TIMEOUTS.AUTO_RECONCILE_AFTER_MS)).toBe(false)
  expect(
    reconcilingDue(
      now - QUEUE_TIMEOUTS.AUTO_RECONCILE_AFTER_MS,
      now,
      QUEUE_TIMEOUTS.AUTO_RECONCILE_AFTER_MS,
    ),
  ).toBe(true)
  expect(reconcilingDue(null, now, QUEUE_TIMEOUTS.AUTO_RECONCILE_AFTER_MS)).toBe(true)
})

it('refunds only after a real upstream poll found nothing', () => {
  expect(shouldConfirmNoResult('manual_verification_required', 1)).toBe(true)
  expect(shouldConfirmNoResult('manual_verification_required', 0)).toBe(false)
  expect(shouldConfirmNoResult('upstream_result_unknown', 2)).toBe(false)
  expect(shouldConfirmNoResult(undefined, 1)).toBe(false)
})

it('alerts only after thirty minutes', () => {
  expect(
    reconcilingDue(
      now - QUEUE_TIMEOUTS.AUTO_RECONCILE_AFTER_MS,
      now,
      QUEUE_TIMEOUTS.RECONCILE_ALERT_AFTER_MS,
    ),
  ).toBe(false)
  expect(
    reconcilingDue(
      now - QUEUE_TIMEOUTS.RECONCILE_ALERT_AFTER_MS,
      now,
      QUEUE_TIMEOUTS.RECONCILE_ALERT_AFTER_MS,
    ),
  ).toBe(true)
})
