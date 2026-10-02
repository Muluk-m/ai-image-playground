import { isObject } from '../type-guards'

/**
 * 技能效果验证记录（见 `apps/bff/skills/_verification/README.md`）。
 *
 * 一条技能用 3 组固定测试输入、每组跑 2 次，得到 6 张图；维护者给每张图按三项各打 1–3 分。
 * 记录落在技能目录的 `verification/record.json`，`meta.json` 的 `verified` 只能由一份过线的
 * 记录回填——判据只有 {@link judgeVerificationRecord} 这一处。
 */

/** 三项评分，顺序即对比页上的顺序。 */
export const VERIFICATION_CRITERIA = ['fidelity', 'match', 'quality'] as const

export type VerificationCriterion = (typeof VERIFICATION_CRITERIA)[number]

export const VERIFICATION_CRITERION_LABELS: Readonly<Record<VerificationCriterion, string>> = {
  fidelity: '主体保真',
  match: '效果符合描述',
  quality: '无明显瑕疵',
}

/** 每条技能固定几组测试输入。 */
export const VERIFICATION_CASE_COUNT = 3
/** 每组测试输入跑几次。 */
export const VERIFICATION_RUNS_PER_CASE = 2
/** 主体保真至少几分算「过」。 */
export const VERIFICATION_FIDELITY_MIN = 2
/** 全部分数的平均分至少多少算过线。 */
export const VERIFICATION_AVERAGE_MIN = 2.5

export type VerificationScores = Readonly<Record<VerificationCriterion, number>>

/** 一次跑图：哪组输入的第几次、产出在哪、用的哪个模型、哪天跑的，以及评分。 */
export interface VerificationRun {
  readonly case: string
  /** 第几次，从 1 起。 */
  readonly run: number
  /** 产出图：相对 `.verification-runs/` 的路径（`<跑图目录>/<技能>/<文件>`）或地址；没出图是 null。 */
  readonly output: string | null
  /** 这次实际出图的生成模型；查不到时是 {@link UNKNOWN_MODEL}，这样的记录不能过线。 */
  readonly model: string
  /** 跑图日期，YYYY-MM-DD。 */
  readonly date: string
  /** 没出图时的原因（`no_output`、上游错误码等）。 */
  readonly error?: string
  /** 维护者的评分；没打分时缺席。 */
  readonly scores?: VerificationScores
}

export interface VerificationRecord {
  readonly skill: string
  /** 打分完成的日期，YYYY-MM-DD；回填 `verified.date` 用它。 */
  readonly reviewedAt?: string
  readonly runs: readonly VerificationRun[]
}

/** `meta.json` 里的 `verified`，与 #997 约定的形状一致。 */
export interface VerifiedStamp {
  readonly date: string
  readonly model: string
  readonly score: number
}

export type VerificationVerdict =
  | { readonly passed: true; readonly verified: VerifiedStamp }
  | { readonly passed: false; readonly reasons: readonly string[] }

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** 查不到实际模型时记的占位。`verified.model` 要拿去比对钉死模型，占位不能当真。 */
export const UNKNOWN_MODEL = 'unknown'

/** 本地时区的 YYYY-MM-DD：跑图日期与打分日期都按维护者所在时区记。 */
export function localIsoDate(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

function isScore(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 3
}

export type ParsedRecord =
  | { readonly ok: true; readonly record: VerificationRecord }
  | { readonly ok: false; readonly errors: readonly string[] }

/** 校验 `record.json` 的形状。只管格式；过没过线归 {@link judgeVerificationRecord}。 */
export function parseVerificationRecord(raw: unknown): ParsedRecord {
  const errors: string[] = []
  if (!isObject(raw)) return { ok: false, errors: ['记录不是一个 JSON 对象'] }
  if (typeof raw.skill !== 'string' || raw.skill === '') errors.push('skill 缺失')
  if (raw.reviewedAt !== undefined && !isIsoDate(raw.reviewedAt))
    errors.push('reviewedAt 不是 YYYY-MM-DD')
  if (!Array.isArray(raw.runs)) {
    errors.push('runs 不是数组')
    return { ok: false, errors }
  }
  raw.runs.forEach((run, at) => {
    const where = `runs[${at}]`
    if (!isObject(run)) {
      errors.push(`${where} 不是对象`)
      return
    }
    if (typeof run.case !== 'string' || run.case === '') errors.push(`${where}.case 缺失`)
    if (!Number.isInteger(run.run) || (run.run as number) < 1)
      errors.push(`${where}.run 不是正整数`)
    if (run.output !== null && (typeof run.output !== 'string' || run.output === ''))
      errors.push(`${where}.output 只能是非空字符串或 null`)
    if (typeof run.model !== 'string' || run.model === '') errors.push(`${where}.model 缺失`)
    if (!isIsoDate(run.date)) errors.push(`${where}.date 不是 YYYY-MM-DD`)
    if (run.error !== undefined && typeof run.error !== 'string')
      errors.push(`${where}.error 不是字符串`)
    if (run.scores !== undefined) {
      if (!isObject(run.scores)) errors.push(`${where}.scores 不是对象`)
      else
        for (const criterion of VERIFICATION_CRITERIA)
          if (!isScore(run.scores[criterion]))
            errors.push(`${where}.scores.${criterion} 不是 1–3 的整数`)
    }
  })
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, record: raw as unknown as VerificationRecord }
}

/** 平均分保留两位小数：写进 `meta.json` 的是摘要，不是原始浮点。 */
function roundScore(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * 过线判据，全仓库只此一处：3 组 × 2 次共 6 张图都出图且都打了分，6 张的主体保真都 ≥ 2，
 * 全部 18 个分数的平均 ≥ 2.5，6 次用的是同一个模型，并且写了打分日期。
 */
export function judgeVerificationRecord(record: VerificationRecord): VerificationVerdict {
  const reasons: string[] = []
  const expected = VERIFICATION_CASE_COUNT * VERIFICATION_RUNS_PER_CASE
  const cases = new Set(record.runs.map((run) => run.case))
  if (cases.size !== VERIFICATION_CASE_COUNT)
    reasons.push(`需要 ${VERIFICATION_CASE_COUNT} 组测试输入，记录里有 ${cases.size} 组`)
  for (const one of cases) {
    const indexes = record.runs
      .filter((run) => run.case === one)
      .map((run) => run.run)
      .sort((a, b) => a - b)
    const want = Array.from({ length: VERIFICATION_RUNS_PER_CASE }, (_, at) => at + 1)
    if (indexes.join(',') !== want.join(','))
      reasons.push(
        `第 ${one} 组应有第 ${want.join('、')} 次，记录里是 ${indexes.join('、') || '无'}`,
      )
  }
  if (record.runs.length !== expected)
    reasons.push(`需要 ${expected} 张图，记录里有 ${record.runs.length} 次`)

  const scores: number[] = []
  for (const run of record.runs) {
    const label = `${run.case}#${run.run}`
    if (run.output === null) {
      reasons.push(`${label} 没出图${run.error ? `（${run.error}）` : ''}`)
      continue
    }
    if (!run.scores) {
      reasons.push(`${label} 还没打分`)
      continue
    }
    if (run.scores.fidelity < VERIFICATION_FIDELITY_MIN)
      reasons.push(`${label} 主体保真 ${run.scores.fidelity} 分，低于 ${VERIFICATION_FIDELITY_MIN}`)
    for (const criterion of VERIFICATION_CRITERIA) scores.push(run.scores[criterion])
  }

  const models = [...new Set(record.runs.map((run) => run.model))]
  if (models.includes(UNKNOWN_MODEL)) reasons.push('有一次查不到实际出图的模型')
  if (models.length > 1) reasons.push(`${expected} 次用了不同的模型：${models.join('、')}`)
  if (!record.reviewedAt) reasons.push('没有打分日期 reviewedAt')

  const average = scores.length > 0 ? scores.reduce((sum, one) => sum + one, 0) / scores.length : 0
  if (scores.length > 0 && average < VERIFICATION_AVERAGE_MIN)
    reasons.push(`平均分 ${roundScore(average)}，低于 ${VERIFICATION_AVERAGE_MIN}`)

  const model = models.length === 1 && models[0] !== UNKNOWN_MODEL ? models[0] : undefined
  if (reasons.length > 0 || !record.reviewedAt || !model) return { passed: false, reasons }
  return {
    passed: true,
    verified: { date: record.reviewedAt, model, score: roundScore(average) },
  }
}
