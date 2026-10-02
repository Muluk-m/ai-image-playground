import { describe, expect, it } from 'bun:test'
import {
  judgeVerificationRecord,
  parseVerificationRecord,
  type VerificationRecord,
  type VerificationRun,
} from '../../../lib/skill-verification/record'

function run(
  caseId: string,
  index: number,
  scores: [number, number, number] | null = [3, 3, 3],
  extra: Partial<VerificationRun> = {},
): VerificationRun {
  return {
    case: caseId,
    run: index,
    output: `runs/${caseId}-${index}.png`,
    model: 'gpt-image-2.5-sunburst',
    date: '2026-10-01',
    ...(scores ? { scores: { fidelity: scores[0], match: scores[1], quality: scores[2] } } : {}),
    ...extra,
  }
}

function record(runs: VerificationRun[], reviewedAt: string | null = '2026-10-02') {
  return { skill: 'poster', ...(reviewedAt ? { reviewedAt } : {}), runs } as VerificationRecord
}

const SIX = ['a', 'b', 'c'].flatMap((id) => [run(id, 1), run(id, 2)])

describe('judgeVerificationRecord', () => {
  it('6 张满分过线，回填日期、模型与平均分', () => {
    expect(judgeVerificationRecord(record(SIX))).toEqual({
      passed: true,
      verified: { date: '2026-10-02', model: 'gpt-image-2.5-sunburst', score: 3 },
    })
  })

  it('平均恰好 2.5 算过线，分数保留两位小数', () => {
    // 18 个分数：9 个 3、9 个 2 → 平均 2.5。
    const runs = ['a', 'b', 'c'].flatMap((id) => [run(id, 1, [3, 3, 2]), run(id, 2, [2, 2, 3])])
    const verdict = judgeVerificationRecord(record(runs))
    expect(verdict).toEqual({
      passed: true,
      verified: { date: '2026-10-02', model: 'gpt-image-2.5-sunburst', score: 2.5 },
    })
  })

  it('平均低于 2.5 不过线', () => {
    const runs = ['a', 'b', 'c'].flatMap((id) => [run(id, 1, [2, 2, 3]), run(id, 2, [2, 3, 2])])
    const verdict = judgeVerificationRecord(record(runs))
    expect(verdict.passed).toBe(false)
    if (!verdict.passed) expect(verdict.reasons.join()).toContain('平均分 2.33')
  })

  it('任一张主体保真 1 分就不过线，即使平均分够', () => {
    const runs = [...SIX.slice(0, 5), run('c', 2, [1, 3, 3])]
    const verdict = judgeVerificationRecord(record(runs))
    expect(verdict.passed).toBe(false)
    if (!verdict.passed) expect(verdict.reasons).toContain('c#2 主体保真 1 分，低于 2')
  })

  it('缺图、没打分、少一次都不过线', () => {
    const noOutput = [...SIX.slice(0, 5), run('c', 2, null, { output: null, error: 'no_output' })]
    const unscored = [...SIX.slice(0, 5), run('c', 2, null)]
    for (const runs of [noOutput, unscored, SIX.slice(0, 5)])
      expect(judgeVerificationRecord(record(runs)).passed).toBe(false)
    const verdict = judgeVerificationRecord(record(noOutput))
    if (!verdict.passed) expect(verdict.reasons).toContain('c#2 没出图（no_output）')
  })

  it('同一组跑了两次第 1 次不算凑够 2 次', () => {
    const runs = [...SIX.slice(0, 5), run('c', 1)]
    expect(judgeVerificationRecord(record(runs)).passed).toBe(false)
  })

  it('6 次模型不一致不过线', () => {
    const runs = [...SIX.slice(0, 5), run('c', 2, [3, 3, 3], { model: 'other-model' })]
    expect(judgeVerificationRecord(record(runs)).passed).toBe(false)
  })

  it('没写打分日期不过线', () => {
    expect(judgeVerificationRecord(record(SIX, null)).passed).toBe(false)
  })
})

describe('parseVerificationRecord', () => {
  it('合法记录原样通过', () => {
    expect(parseVerificationRecord(record(SIX))).toEqual({ ok: true, record: record(SIX) })
  })

  it('分数越界、日期不对、字段缺失都报出来', () => {
    const parsed = parseVerificationRecord({
      skill: 'poster',
      reviewedAt: '2026-13-01',
      runs: [{ case: 'a', run: 0, output: '', model: '', date: 'x', scores: { fidelity: 4 } }],
    })
    expect(parsed.ok).toBe(false)
    if (!parsed.ok)
      expect(parsed.errors).toEqual([
        'reviewedAt 不是 YYYY-MM-DD',
        'runs[0].run 不是正整数',
        'runs[0].output 只能是非空字符串或 null',
        'runs[0].model 缺失',
        'runs[0].date 不是 YYYY-MM-DD',
        'runs[0].scores.fidelity 不是 1–3 的整数',
        'runs[0].scores.match 不是 1–3 的整数',
        'runs[0].scores.quality 不是 1–3 的整数',
      ])
  })

  it('不是对象直接拒绝', () => {
    expect(parseVerificationRecord([]).ok).toBe(false)
  })
})
