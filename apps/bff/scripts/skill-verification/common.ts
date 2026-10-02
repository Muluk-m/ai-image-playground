import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  declaredInputs,
  imageSkillsWithVerificationFile,
  parseVerificationCases,
  resolveFixture,
  VERIFICATION_CASES_FILE,
  VERIFICATION_DIR,
  VERIFICATION_RECORD_FILE,
  type VerificationCase,
} from '../../src/lib/skill-verification/cases'

/** 随仓库发的技能目录。脚本按自身位置解析，不依赖 cwd。 */
export const SKILLS_ROOT = join(import.meta.dir, '../../skills')
/** 跑图产出的根目录（gitignored）：每次跑图一个子目录。 */
export const RUNS_ROOT = join(import.meta.dir, '../../.verification-runs')

/** 跑图只覆盖图片技能：视频技能的验证另起（见 #995 Out of Scope）。 */
export function imageSkillDirectory(skill: string): string {
  const directory = join(SKILLS_ROOT, 'image', skill)
  if (!existsSync(join(directory, 'SKILL.md'))) throw new Error(`没有这条图片技能：${skill}`)
  return directory
}

/** 磁盘上写了测试输入的那些图片技能。 */
export const skillsWithCases = () =>
  imageSkillsWithVerificationFile(SKILLS_ROOT, VERIFICATION_CASES_FILE)

/** 写了验证记录的那些图片技能。 */
export const skillsWithRecords = () =>
  imageSkillsWithVerificationFile(SKILLS_ROOT, VERIFICATION_RECORD_FILE)

export interface SkillVerificationSetup {
  readonly skill: string
  readonly directory: string
  /** 预置模板钉死的模型；普通技能缺席，跑图用部署默认模型。 */
  readonly model?: string
  readonly cases: readonly VerificationCase[]
  readonly locate: (ref: string) => string
}

/** 读一条技能的 `meta.json` 与 `cases.json` 并校验；不合规直接抛，脚本不带着坏输入去花钱。 */
export function loadSkillSetup(skill: string): SkillVerificationSetup {
  const directory = imageSkillDirectory(skill)
  const meta: unknown = JSON.parse(readFileSync(join(directory, 'meta.json'), 'utf8'))
  const casesPath = join(directory, VERIFICATION_DIR, VERIFICATION_CASES_FILE)
  if (!existsSync(casesPath)) throw new Error(`${skill} 还没有测试输入：${casesPath}`)
  const locate = (ref: string) => resolveFixture(SKILLS_ROOT, directory, ref)
  const parsed = parseVerificationCases(
    JSON.parse(readFileSync(casesPath, 'utf8')),
    declaredInputs(meta),
    locate,
    existsSync,
  )
  if (!parsed.ok) throw new Error(`${skill} 的测试输入不合规：\n  ${parsed.errors.join('\n  ')}`)
  const template = (meta as { template?: { model?: unknown } }).template
  const model = typeof template?.model === 'string' ? template.model : undefined
  return { skill, directory, cases: parsed.cases, locate, ...(model ? { model } : {}) }
}

/** `--name value` 与 `--flag` 两种参数，其余按位置收集。 */
export function parseArgs(argv: readonly string[]): {
  readonly flags: ReadonlyMap<string, string | true>
  readonly positional: readonly string[]
} {
  const flags = new Map<string, string | true>()
  const positional: string[] = []
  for (let at = 0; at < argv.length; at++) {
    const arg = argv[at]!
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const next = argv[at + 1]
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(arg.slice(2), next)
      at++
    } else flags.set(arg.slice(2), true)
  }
  return { flags, positional }
}
