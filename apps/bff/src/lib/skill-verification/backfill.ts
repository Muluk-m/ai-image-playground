import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { VERIFICATION_DIR, VERIFICATION_RECORD_FILE } from './cases'
import {
  judgeVerificationRecord,
  parseVerificationRecord,
  type VerificationVerdict,
  type VerifiedStamp,
} from './record'

type Meta = Readonly<Record<string, unknown>>

/**
 * 按验证记录改写 `meta.json`：过线写 `verified`，不过线删掉它。其余字段原样保留、顺序不动。
 * 记录格式不对按不过线处理，原因就是格式错误。
 */
export function backfillVerified(
  meta: Meta,
  rawRecord: unknown,
): { readonly meta: Meta; readonly verdict: VerificationVerdict } {
  const parsed = parseVerificationRecord(rawRecord)
  const verdict: VerificationVerdict = parsed.ok
    ? judgeVerificationRecord(parsed.record)
    : { passed: false, reasons: parsed.errors.map((error) => `记录格式：${error}`) }
  const { verified: _previous, ...rest } = meta
  return { meta: verdict.passed ? { ...rest, verified: verdict.verified } : rest, verdict }
}

function isStamp(value: unknown): value is VerifiedStamp {
  if (typeof value !== 'object' || value === null) return false
  const stamp = value as Record<string, unknown>
  return (
    typeof stamp.date === 'string' &&
    typeof stamp.model === 'string' &&
    typeof stamp.score === 'number'
  )
}

/**
 * `meta.json` 的 `verified` 是不是由这份记录回填出来的：没有 `verified` 一律算一致；
 * 有的话记录必须存在、过线，且日期、模型、分数逐项相同。返回不一致的原因，空即一致。
 */
export function verifiedMismatches(meta: Meta, rawRecord: unknown | undefined): string[] {
  if (meta.verified === undefined) return []
  if (!isStamp(meta.verified)) return ['verified 不是 { date, model, score }']
  if (rawRecord === undefined) return ['写了 verified，但没有验证记录']
  const { verdict } = backfillVerified(meta, rawRecord)
  if (!verdict.passed) return ['写了 verified，但验证记录没过线', ...verdict.reasons]
  const expected = verdict.verified
  const actual = meta.verified
  return (['date', 'model', 'score'] as const).flatMap((field) =>
    expected[field] === actual[field]
      ? []
      : [`verified.${field} 是 ${actual[field]}，验证记录给的是 ${expected[field]}`],
  )
}

/** 一条技能目录的回填：读记录、改写 `meta.json`。没有记录时抛错，不动文件。 */
export function backfillSkillDirectory(directory: string): VerificationVerdict {
  const recordPath = join(directory, VERIFICATION_DIR, VERIFICATION_RECORD_FILE)
  if (!existsSync(recordPath)) throw new Error(`没有验证记录：${recordPath}`)
  const metaPath = join(directory, 'meta.json')
  const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as Meta
  const result = backfillVerified(meta, JSON.parse(readFileSync(recordPath, 'utf8')))
  writeFileSync(metaPath, `${JSON.stringify(result.meta, null, 2)}\n`)
  return result.verdict
}
