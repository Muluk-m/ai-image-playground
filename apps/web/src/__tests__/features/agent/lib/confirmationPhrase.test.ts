import { expect, it } from 'vitest'
import {
  isShortConfirmation,
  shouldHoldConfirmation,
} from '../../../../features/agent/lib/confirmationPhrase'

it('treats a short confirmation, including the repeated-batch phrase, as confirmation', () => {
  for (const phrase of ['确认', '可以', '确认生成', '执行', '确认，执行生成', '  可以。']) {
    expect(isShortConfirmation(phrase), phrase).toBe(true)
  }
})

it('does not treat a short new request, or a long sentence, as confirmation', () => {
  expect(isShortConfirmation('可以再来一版')).toBe(false)
  expect(isShortConfirmation('确认，但是把尺寸改成 16:9')).toBe(false)
  expect(isShortConfirmation('')).toBe(false)
  expect(isShortConfirmation('   ')).toBe(false)
})

it('holds the send only when a confirmation phrase meets pending cards', () => {
  expect(shouldHoldConfirmation('确认', 2)).toBe(true)
  expect(shouldHoldConfirmation('确认', 0)).toBe(false)
  expect(shouldHoldConfirmation('再出一张', 2)).toBe(false)
})
