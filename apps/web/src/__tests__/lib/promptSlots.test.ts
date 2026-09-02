import { describe, expect, it } from 'vitest'
import {
  expandPromptSlots,
  getPromptSlotBatchSize,
  getPromptSlotNames,
  getUnfilledPromptSlots,
  parseSlotValueLines,
  splitTextIntoSlotParts,
} from '../../lib/promptSlots'

describe('prompt slots parsing', () => {
  it('reads slot names in order without duplicates', () => {
    expect(getPromptSlotNames('把 {背景} 换成 {背景}，角度 {角度}')).toEqual(['背景', '角度'])
  })

  it('ignores braces holding whitespace or nothing, and takes the innermost pair', () => {
    expect(getPromptSlotNames('{有 空格} {} {{嵌套}} {好的}')).toEqual(['嵌套', '好的'])
  })

  it('splits text into slot parts keeping surrounding text', () => {
    expect(splitTextIntoSlotParts('背景是{背景}。')).toEqual([
      { type: 'text', text: '背景是' },
      { type: 'slot', text: '{背景}', name: '背景' },
      { type: 'text', text: '。' },
    ])
  })

  it('parses one value per line and drops blank lines', () => {
    expect(parseSlotValueLines('浴室\n\n  客厅  \n\n厨房\n')).toEqual(['浴室', '客厅', '厨房'])
  })
})

describe('prompt slots expansion', () => {
  it('returns the prompt unchanged when it has no slot', () => {
    expect(expandPromptSlots('一只猫', {})).toEqual(['一只猫'])
    expect(getPromptSlotBatchSize('一只猫', {})).toBe(1)
  })

  it('replaces every occurrence of a slot with each value', () => {
    expect(expandPromptSlots('{背景}里的猫，背景是{背景}', { 背景: ['浴室', '厨房'] })).toEqual([
      '浴室里的猫，背景是浴室',
      '厨房里的猫，背景是厨房',
    ])
  })

  it('expands multiple slots as a cartesian product with the first slot varying slowest', () => {
    expect(
      expandPromptSlots('{场景}-{角度}', { 场景: ['浴室', '厨房'], 角度: ['正面', '俯视'] }),
    ).toEqual(['浴室-正面', '浴室-俯视', '厨房-正面', '厨房-俯视'])
    expect(
      getPromptSlotBatchSize('{场景}-{角度}', { 场景: ['浴室', '厨房'], 角度: ['正面', '俯视'] }),
    ).toBe(4)
  })

  it('ignores stored values whose slot is no longer in the prompt', () => {
    expect(expandPromptSlots('{场景}', { 场景: ['浴室'], 角度: ['正面', '俯视'] })).toEqual([
      '浴室',
    ])
  })

  it('reports unfilled slots and expands to nothing while any slot is unfilled', () => {
    expect(getUnfilledPromptSlots('{场景}-{角度}', { 场景: ['浴室'] })).toEqual(['角度'])
    expect(getPromptSlotBatchSize('{场景}-{角度}', { 场景: ['浴室'] })).toBe(0)
    expect(expandPromptSlots('{场景}-{角度}', { 场景: ['浴室'] })).toEqual([])
  })
})
