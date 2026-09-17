import { expect, it } from 'bun:test'
import { createMaskedEditPlan } from '../../../lib/agent/masked-plan'

it('does not grant a new paid batch after an interjection or a different request quote', () => {
  const plan = createMaskedEditPlan(
    () => '修改选区颜色',
    (id) => id,
  )
  plan.capture([{ id: 'first', name: 'editImage', arguments: {} }])
  expect(plan.includes('first')).toBe(true)
  plan.submitted('first')
  plan.interjected()
  plan.capture([{ id: 'retry', name: 'editImage', arguments: {} }])
  expect(plan.includes('first')).toBe(false)
  expect(plan.includes('retry', { targetImageId: 'a', requestQuote: '颜色' })).toBe(false)
})

it('allows a declared dependent edit once with its exact target, selection, quote and count', () => {
  const plan = createMaskedEditPlan(
    () => '先修改 A，再以产物为参考修改 B',
    (id) => id,
  )
  const dependent = {
    targetImageId: 'b',
    selectionId: 'selection-b',
    requestQuote: '再以产物为参考修改 B',
    n: 1,
  }
  plan.capture([{ id: 'first', name: 'editImage', arguments: { deferredEdits: [dependent] } }])
  plan.submitted('first')
  plan.capture([{ id: 'second', name: 'editImage', arguments: {} }])
  expect(plan.includes('second', { ...dependent, n: 2 })).toBe(false)
  expect(plan.includes('second', { ...dependent, selectionId: 'changed' })).toBe(false)
  expect(plan.includes('second', { ...dependent, targetImageId: 'c' })).toBe(false)
  expect(plan.includes('second', dependent)).toBe(true)
  plan.submitted('second', dependent)
  expect(plan.includes('third', dependent)).toBe(false)
})

it('does not reserve an invented instruction and allows unsubmitted parameter corrections', () => {
  const plan = createMaskedEditPlan(
    () => '修改 A',
    (id) => id,
  )
  const invented = { targetImageId: 'b', requestQuote: '修改 B' }
  plan.capture([{ id: 'invalid', name: 'editImage', arguments: {} }])
  plan.capture([{ id: 'corrected', name: 'editImage', arguments: { deferredEdits: [invented] } }])
  expect(plan.includes('corrected')).toBe(true)
  plan.submitted('corrected')
  expect(plan.includes('second', invented)).toBe(false)
})
