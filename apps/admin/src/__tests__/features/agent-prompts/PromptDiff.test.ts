import { describe, expect, it } from 'vitest'
import { diffPrompts } from '../../../features/agent-prompts/PromptDiff'

describe('diffPrompts', () => {
  it('highlights Chinese substitutions while retaining shared context', () => {
    expect(diffPrompts('一只绿色杯子', '一只蓝色杯子')).toEqual([
      { kind: 'same', text: '一只' },
      { kind: 'removed', text: '绿' },
      { kind: 'added', text: '蓝' },
      { kind: 'same', text: '色杯子' },
    ])
  })
  it.each([
    ['', '新增'],
    ['删掉', ''],
    ['same\ntext', 'same\ntext'],
    ['a  green cup\n白底', 'a blue cup\n白底'],
    ['<script>alert(1)</script>', '<b>cup</b>'],
    ['甲'.repeat(1000), '乙'.repeat(1000)],
  ])('preserves every character when reconstructing either side', (before, after) => {
    const parts = diffPrompts(before, after)
    expect(
      parts
        .filter((part) => part.kind !== 'added')
        .map((part) => part.text)
        .join(''),
    ).toBe(before)
    expect(
      parts
        .filter((part) => part.kind !== 'removed')
        .map((part) => part.text)
        .join(''),
    ).toBe(after)
  })
  it('bounds work for long unrelated prompts', () => {
    expect(diffPrompts('甲'.repeat(1000), '乙'.repeat(1000))).toHaveLength(2)
  })
})
