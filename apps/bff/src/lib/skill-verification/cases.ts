import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { isObject } from '../type-guards'
import { VERIFICATION_CASE_COUNT } from './record'

/**
 * 技能的固定测试输入：技能目录下 `verification/cases.json`。
 *
 * ```json
 * { "cases": [{ "id": "mug", "prompt": "用 {asset1} 出一张主图", "inputs": { "asset1": ["shared:product-mug.webp"] } }] }
 * ```
 *
 * - `inputs` 的键是技能 `meta.json` 声明的素材位 key（预置模板没写 `inputs` 时是 `asset1..N`）。
 * - 图片写文件名：`shared:<文件>` 取公共素材 `skills/_verification/fixtures/`，
 *   不带前缀的取这条技能自己的 `verification/` 目录。只许文件名，不许路径。
 * - `prompt` 是用户那一句话，不带 `/技能名`；`{key}` 处换成这个位的 `[image N]`。
 */

export const VERIFICATION_DIR = 'verification'
export const VERIFICATION_CASES_FILE = 'cases.json'
export const VERIFICATION_RECORD_FILE = 'record.json'
/** 公共素材目录，相对技能根目录。以 `_` 开头：加载器只读 `image/`、`video/`、`shared/`。 */
export const VERIFICATION_FIXTURES_DIR = join('_verification', 'fixtures')
export const SHARED_FIXTURE_PREFIX = 'shared:'

/** 一个素材位：与 #997 约定的 `meta.json` `inputs` 同形，只取验证要用的三项。 */
export interface DeclaredInput {
  readonly key: string
  readonly required: boolean
  readonly multiple: boolean
}

export interface VerificationCase {
  readonly id: string
  readonly prompt: string
  readonly inputs: Readonly<Record<string, readonly string[]>>
}

const KEY_RE = /^[a-z][a-z0-9-]*$/
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(webp|png|jpe?g)$/
const PLACEHOLDER_RE = /\{([a-z][a-z0-9-]*)\}/g

/**
 * 从 `meta.json` 读出素材位：写了 `inputs` 用它；预置模板没写时按 `template.slotCount`
 * 派生 `asset1..N`（必填、可多图，与目录接口的派生规则一致）；都没有就是没有位。
 */
export function declaredInputs(meta: unknown): DeclaredInput[] {
  if (!isObject(meta)) return []
  if (Array.isArray(meta.inputs)) {
    return meta.inputs.flatMap((one) =>
      isObject(one) && typeof one.key === 'string' && KEY_RE.test(one.key)
        ? [{ key: one.key, required: one.required !== false, multiple: one.multiple === true }]
        : [],
    )
  }
  const slotCount = isObject(meta.template) ? meta.template.slotCount : undefined
  if (Number.isInteger(slotCount) && (slotCount as number) > 0)
    return Array.from({ length: slotCount as number }, (_, at) => ({
      key: `asset${at + 1}`,
      required: true,
      multiple: true,
    }))
  return []
}

/** 去掉 `shared:` 前缀后的文件名。 */
export function fixtureFileName(ref: string): string {
  return ref.startsWith(SHARED_FIXTURE_PREFIX) ? ref.slice(SHARED_FIXTURE_PREFIX.length) : ref
}

/** 一张测试输入图的磁盘位置。 */
export function resolveFixture(skillsRoot: string, skillDirectory: string, ref: string): string {
  return ref.startsWith(SHARED_FIXTURE_PREFIX)
    ? join(skillsRoot, VERIFICATION_FIXTURES_DIR, fixtureFileName(ref))
    : join(skillDirectory, VERIFICATION_DIR, ref)
}

/** 技能根目录下 `image/` 里在 `verification/` 中放了 `file` 的那些技能名。 */
export function imageSkillsWithVerificationFile(skillsRoot: string, file: string): string[] {
  return readdirSync(join(skillsRoot, 'image')).filter((name) =>
    existsSync(join(skillsRoot, 'image', name, VERIFICATION_DIR, file)),
  )
}

export type ParsedCases =
  | { readonly ok: true; readonly cases: readonly VerificationCase[] }
  | { readonly ok: false; readonly errors: readonly string[] }

/**
 * 校验 `cases.json`。`fileExists` 收的是 {@link resolveFixture} 解析出的路径，测试里可以换掉。
 */
export function parseVerificationCases(
  raw: unknown,
  inputs: readonly DeclaredInput[],
  locate: (ref: string) => string,
  fileExists: (path: string) => boolean,
): ParsedCases {
  const errors: string[] = []
  if (!isObject(raw) || !Array.isArray(raw.cases)) return { ok: false, errors: ['缺少 cases 数组'] }
  if (raw.cases.length !== VERIFICATION_CASE_COUNT)
    errors.push(`需要 ${VERIFICATION_CASE_COUNT} 组测试输入，写了 ${raw.cases.length} 组`)
  const declared = new Map(inputs.map((one) => [one.key, one]))
  const ids = new Set<string>()
  raw.cases.forEach((one, at) => {
    const where = `cases[${at}]`
    if (!isObject(one)) {
      errors.push(`${where} 不是对象`)
      return
    }
    if (typeof one.id !== 'string' || !KEY_RE.test(one.id))
      errors.push(`${where}.id 不是 kebab-case`)
    else if (ids.has(one.id)) errors.push(`${where}.id 重复：${one.id}`)
    else ids.add(one.id)
    const prompt = typeof one.prompt === 'string' ? one.prompt.trim() : ''
    if (prompt === '') errors.push(`${where}.prompt 为空`)
    if (prompt.startsWith('/')) errors.push(`${where}.prompt 不要带 /技能名，跑图脚本会加`)
    if (!isObject(one.inputs)) {
      errors.push(`${where}.inputs 不是对象`)
      return
    }
    const used = new Set([...prompt.matchAll(PLACEHOLDER_RE)].map(([, key]) => key))
    for (const key of used)
      if (!(key in one.inputs)) errors.push(`${where}.prompt 引用了没给图的位 {${key}}`)
    for (const input of inputs)
      if (input.required && !(input.key in one.inputs))
        errors.push(`${where}.inputs 缺必填位 ${input.key}`)
    for (const [key, refs] of Object.entries(one.inputs)) {
      const input = declared.get(key)
      if (!input) {
        errors.push(`${where}.inputs.${key} 不是这条技能声明的位`)
        continue
      }
      if (!used.has(key)) errors.push(`${where}.prompt 没有用到位 {${key}}`)
      if (!Array.isArray(refs) || refs.length === 0) {
        errors.push(`${where}.inputs.${key} 需要至少一张图`)
        continue
      }
      if (!input.multiple && refs.length > 1) errors.push(`${where}.inputs.${key} 这个位只收一张图`)
      for (const ref of refs) {
        if (typeof ref !== 'string' || !FILE_RE.test(fixtureFileName(ref))) {
          errors.push(`${where}.inputs.${key} 里的 ${String(ref)} 不是合法的图片文件名`)
          continue
        }
        if (!fileExists(locate(ref as string)))
          errors.push(`${where}.inputs.${key} 里的 ${ref} 不存在`)
      }
    }
  })
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, cases: raw.cases as VerificationCase[] }
}

/** 一组测试输入发给智能体的那一轮：文字与按 `[image N]` 编号排好的图。 */
export interface CaseTurn {
  readonly text: string
  readonly images: readonly { readonly key: string; readonly ref: string }[]
}

/**
 * 把一组测试输入变成一条 `/技能名 …` 消息。图按位在 `inputs` 里出现的顺序编号，
 * `{key}` 换成这个位的全部 `[image N]`，与界面上填位后发出去的样子一致。
 */
export function caseTurn(skill: string, one: VerificationCase): CaseTurn {
  const images: { key: string; ref: string }[] = []
  const tokens = new Map<string, string>()
  for (const [key, refs] of Object.entries(one.inputs)) {
    const numbers = refs.map((ref) => {
      images.push({ key, ref })
      return `[image ${images.length}]`
    })
    tokens.set(key, numbers.join(' '))
  }
  const prompt = one.prompt.trim().replace(PLACEHOLDER_RE, (whole, key: string) => {
    return tokens.get(key) ?? whole
  })
  return { text: `/${skill} ${prompt}`, images }
}
