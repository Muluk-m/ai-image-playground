import { expect, it } from 'bun:test'
import {
  createMaskedEditPlan,
  type MaskedEditContent,
  mergeMaskedPlanCarries,
} from '../../../lib/agent/masked-plan'

const CONTENT: MaskedEditContent = {
  imageIds: ['target', 'reference'],
  selectionBindings: [
    { imageId: 'target', selectionId: 'selection-target' },
    { imageId: 'reference', selectionId: 'selection-reference' },
  ],
  quote: '把圈中头枕降低',
}

it('does not grant a new paid batch after an interjection or a different request quote', () => {
  const plan = createMaskedEditPlan(
    () => '修改选区颜色',
    (id) => id,
  )
  plan.capture([{ id: 'first', name: 'editImage', arguments: {} }])
  expect(plan.approve({ call: { toolCallId: 'first' } })).toBe('approved')
  plan.submitted({ call: { toolCallId: 'first' } })
  plan.interjected()
  plan.capture([{ id: 'retry', name: 'editImage', arguments: {} }])
  expect(plan.approve({ call: { toolCallId: 'first' } })).toBe('outside-batch')
  expect(
    plan.approve({
      call: { toolCallId: 'retry', operation: { targetImageId: 'a', requestQuote: '颜色' } },
    }),
  ).toBe('outside-batch')
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
  plan.submitted({ call: { toolCallId: 'first' } })
  plan.capture([{ id: 'second', name: 'editImage', arguments: {} }])
  const second = (operation: typeof dependent) =>
    plan.approve({ call: { toolCallId: 'second', operation } })
  expect(second({ ...dependent, n: 2 })).toBe('outside-batch')
  expect(second({ ...dependent, selectionId: 'changed' })).toBe('outside-batch')
  expect(second({ ...dependent, targetImageId: 'c' })).toBe('outside-batch')
  expect(second(dependent)).toBe('approved')
  plan.submitted({ call: { toolCallId: 'second', operation: dependent } })
  expect(plan.approve({ call: { toolCallId: 'third', operation: dependent } })).toBe(
    'outside-batch',
  )
})

it('does not reserve an invented instruction and allows unsubmitted parameter corrections', () => {
  const plan = createMaskedEditPlan(
    () => '修改 A',
    (id) => id,
  )
  const invented = { targetImageId: 'b', requestQuote: '修改 B' }
  plan.capture([{ id: 'invalid', name: 'editImage', arguments: {} }])
  plan.capture([{ id: 'corrected', name: 'editImage', arguments: { deferredEdits: [invented] } }])
  expect(plan.approve({ call: { toolCallId: 'corrected' } })).toBe('approved')
  plan.submitted({ call: { toolCallId: 'corrected' } })
  expect(plan.approve({ call: { toolCallId: 'second', operation: invented } })).toBe(
    'outside-batch',
  )
})

it('tells a repeat of the same edit apart from a call outside the batch', () => {
  const plan = createMaskedEditPlan(
    () => '把圈中头枕降低',
    (id) => id,
  )
  plan.capture([
    { id: 'first', name: 'editImage', arguments: {} },
    { id: 'same-again', name: 'editImage', arguments: {} },
  ])
  expect(plan.approve({ call: { toolCallId: 'first' }, content: CONTENT })).toBe('approved')
  plan.submitted({ call: { toolCallId: 'first' }, content: CONTENT })
  // 批次认得这次调用，内容认得出它做的是同一件事——两句话里该说的是后面那句。
  expect(plan.approve({ call: { toolCallId: 'same-again' }, content: CONTENT })).toBe(
    'already-submitted',
  )
  // 绑定的先后顺序不是身份的一部分。
  expect(
    plan.approve({
      call: { toolCallId: 'same-again' },
      content: { ...CONTENT, selectionBindings: [...CONTENT.selectionBindings!].reverse() },
    }),
  ).toBe('already-submitted')
  // 换一段原文就是另一件事；批次里还有名额就该放行。
  expect(
    plan.approve({
      call: { toolCallId: 'same-again' },
      content: { ...CONTENT, quote: '换个颜色' },
    }),
  ).toBe('approved')
  // 同一份内容、批次外的调用：先回答「这条提过了」，模型该去看候选。
  expect(plan.approve({ call: { toolCallId: 'unknown' }, content: CONTENT })).toBe(
    'already-submitted',
  )
  expect(plan.approve({ call: { toolCallId: 'unknown' } })).toBe('outside-batch')
})

it('does not remember an operation whose task was never created', () => {
  const plan = createMaskedEditPlan(
    () => '把圈中头枕降低',
    (id) => id,
  )
  plan.capture([{ id: 'first', name: 'editImage', arguments: {} }])
  expect(plan.approve({ call: { toolCallId: 'first' }, content: CONTENT })).toBe('approved')
  // 提交被上游拒了，没有 submitted()：批次名额与这条内容都不该被占掉。
  expect(plan.approve({ call: { toolCallId: 'first' }, content: CONTENT })).toBe('approved')
})

it('keeps a submitted edit submitted across an interjection', () => {
  const plan = createMaskedEditPlan(
    () => '把圈中头枕降低',
    (id) => id,
  )
  plan.capture([{ id: 'first', name: 'editImage', arguments: {} }])
  plan.submitted({ call: { toolCallId: 'first' }, content: CONTENT })
  plan.interjected()
  plan.capture([{ id: 'second', name: 'editImage', arguments: {} }])
  expect(plan.approve({ call: { toolCallId: 'second' }, content: CONTENT })).toBe(
    'already-submitted',
  )
  expect(plan.approve({ call: { toolCallId: 'second' } })).toBe('outside-batch')
})

it('remembers submitted content without locking a batch that never spent anything', () => {
  const plan = createMaskedEditPlan(
    () => '把圈中头枕降低',
    (id) => id,
  )
  plan.capture([{ id: 'first', name: 'editImage', arguments: {} }])
  // 非遮罩轮的提交只登记内容，不冻结批次。
  plan.submitted({ content: CONTENT })
  expect(plan.approve({ content: CONTENT })).toBe('already-submitted')
  plan.capture([{ id: 'second', name: 'editImage', arguments: {} }])
  expect(plan.approve({ call: { toolCallId: 'second' } })).toBe('approved')
})

it('hands the wake turn the plan it left off with: submitted content and remaining deferred edits', () => {
  const authorization = '先修改 A，再修改 B，最后修改 C'
  const plan = createMaskedEditPlan(
    () => authorization,
    (id) => id,
    true,
  )
  const b = { targetImageId: 'b', requestQuote: '再修改 B' }
  const c = { targetImageId: 'c', requestQuote: '最后修改 C' }
  plan.capture([{ id: 'first', name: 'editImage', arguments: { deferredEdits: [b, c] } }])
  const first = { call: { toolCallId: 'first' }, content: CONTENT }
  const carried = plan.carryAfter(first)
  expect(carried).toMatchObject({ authorization, protected: true })

  // 唤醒轮：批次早已冻结，只剩列明的后续编辑；提交过的内容不能再付一次费。
  const wake = createMaskedEditPlan(
    () => carried.authorization,
    (id) => id,
    false,
    carried,
  )
  expect(wake.protected).toBe(true)
  wake.capture([{ id: 'wake-call', name: 'editImage', arguments: {} }])
  expect(wake.approve({ call: { toolCallId: 'wake-call' }, content: CONTENT })).toBe(
    'already-submitted',
  )
  expect(wake.approve({ call: { toolCallId: 'wake-call' } })).toBe('outside-batch')
  const second = { call: { toolCallId: 'wake-call', operation: b } }
  expect(wake.approve(second)).toBe('approved')

  // 再下一次唤醒只剩 C。
  const next = createMaskedEditPlan(
    () => '',
    (id) => id,
    false,
    wake.carryAfter(second),
  )
  expect(next.approve({ call: { toolCallId: 'x', operation: b } })).toBe('outside-batch')
  expect(next.approve({ call: { toolCallId: 'x', operation: c } })).toBe('approved')
})

it('merges the plans of one batch: every submitted content, the deferred edits of the last', () => {
  const base = { authorization: '原话', protected: false }
  expect(mergeMaskedPlanCarries([])).toBeUndefined()
  expect(
    mergeMaskedPlanCarries([
      { ...base, contents: ['a'], deferred: ['x', 'y'] },
      { ...base, protected: true, contents: ['a', 'b'], deferred: ['y'] },
    ]),
  ).toEqual({ ...base, protected: true, contents: ['a', 'b'], deferred: ['y'] })
})
