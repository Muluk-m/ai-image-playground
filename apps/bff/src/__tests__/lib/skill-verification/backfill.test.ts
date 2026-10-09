import { afterAll, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  backfillSkillDirectory,
  backfillVerified,
  verifiedMismatches,
} from '../../../lib/skill-verification/backfill'

function passingRecord(model = 'gpt-image-2.5-sunburst') {
  return {
    skill: 'poster',
    reviewedAt: '2026-10-02',
    runs: ['a', 'b', 'c'].flatMap((id) =>
      [1, 2].map((run) => ({
        case: id,
        run,
        output: `${id}-${run}.png`,
        model,
        date: '2026-10-01',
        scores: { fidelity: 3, match: 3, quality: run === 1 ? 2 : 3 },
      })),
    ),
  }
}

function failingRecord() {
  const record = passingRecord()
  return {
    ...record,
    runs: record.runs.map((run) => ({ ...run, scores: { ...run.scores, fidelity: 1 } })),
  }
}

const STAMP = { date: '2026-10-02', model: 'gpt-image-2.5-sunburst', score: 2.83 }

describe('backfillVerified', () => {
  it('过线时写入 verified，其余字段原样、verified 排在最后', () => {
    const { meta, verdict } = backfillVerified({ icon: 'x', summary: 'y' }, passingRecord())
    expect(verdict.passed).toBe(true)
    expect(meta).toEqual({ icon: 'x', summary: 'y', verified: STAMP })
    expect(Object.keys(meta)).toEqual(['icon', 'summary', 'verified'])
  })

  it('不过线时删掉旧的 verified 并给出原因', () => {
    const { meta, verdict } = backfillVerified({ icon: 'x', verified: STAMP }, failingRecord())
    expect(meta).toEqual({ icon: 'x' })
    expect(verdict.passed).toBe(false)
    if (!verdict.passed) expect(verdict.reasons).toContain('a#1 主体保真 1 分，低于 2')
  })

  it('记录格式不对按不过线处理', () => {
    const { meta, verdict } = backfillVerified({ verified: STAMP }, { runs: 'x' })
    expect(meta).toEqual({})
    if (!verdict.passed) expect(verdict.reasons[0]).toStartWith('记录格式：')
  })
})

describe('verifiedMismatches', () => {
  it('没写 verified 总是一致', () => {
    expect(verifiedMismatches({}, undefined)).toEqual([])
  })

  it('与过线记录逐项相同才一致', () => {
    expect(verifiedMismatches({ verified: STAMP }, passingRecord())).toEqual([])
    expect(verifiedMismatches({ verified: STAMP }, passingRecord('other-model'))).toEqual([
      'verified.model 是 gpt-image-2.5-sunburst，验证记录给的是 other-model',
    ])
  })

  it('没有记录或记录没过线都不一致', () => {
    expect(verifiedMismatches({ verified: STAMP }, undefined)).toEqual([
      '写了 verified，但没有验证记录',
    ])
    expect(verifiedMismatches({ verified: STAMP }, failingRecord())[0]).toBe(
      '写了 verified，但验证记录没过线',
    )
    expect(verifiedMismatches({ verified: { date: 1 } }, passingRecord())).toEqual([
      'verified 不是 { date, model, score }',
    ])
  })
})

describe('backfillSkillDirectory', () => {
  const dirs: string[] = []
  afterAll(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true })
  })

  async function skillDir(record: unknown | undefined) {
    const dir = await mkdtemp(join(tmpdir(), 'skill-verify-'))
    dirs.push(dir)
    await writeFile(join(dir, 'meta.json'), JSON.stringify({ icon: 'x', summary: 'y' }))
    if (record !== undefined) {
      await mkdir(join(dir, 'verification'))
      await writeFile(join(dir, 'verification/record.json'), JSON.stringify(record))
    }
    return dir
  }

  it('按记录改写 meta.json，两格缩进加换行结尾', async () => {
    const dir = await skillDir(passingRecord())
    expect(backfillSkillDirectory(dir).passed).toBe(true)
    expect(await readFile(join(dir, 'meta.json'), 'utf8')).toBe(
      `${JSON.stringify({ icon: 'x', summary: 'y', verified: STAMP }, null, 2)}\n`,
    )
  })

  it('没有记录时抛错且不动 meta.json', async () => {
    const dir = await skillDir(undefined)
    expect(() => backfillSkillDirectory(dir)).toThrow('没有验证记录')
    expect(await readFile(join(dir, 'meta.json'), 'utf8')).toBe('{"icon":"x","summary":"y"}')
  })
})
