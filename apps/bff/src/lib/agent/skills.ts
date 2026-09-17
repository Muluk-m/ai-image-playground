import { realpath, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import {
  BACKGROUND_CONTEXT,
  formatSkillInvocation,
  loadSkills,
} from '@earendil-works/pi-agent-core'
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node'
import type { AgentMode, AgentSkillSummary } from '@image-playground/shared'
import { log } from '../logger'

/**
 * 技能（Agent Skill）：一份写在 `SKILL.md` 里的专业流程指引，按 agentskills.io 的目录约定放在
 * `apps/bff/skills/<mode|shared>/<skill-name>/`。加载用框架自带的 loader，读全文与读附属文件
 * 由我们自己的 `loadSkill` 工具做——模型手上没有任何文件系统工具。
 *
 * 三层渐进式加载：系统提示词只放 name + description（每条几十个 token），正文要模型自己调
 * `loadSkill` 才进上下文，附属文件再多走一次。
 */

/** 一条加载好的技能。`directory` 只给服务端读附属文件用，任何进模型的文本里都不许出现。 */
export interface AgentSkill {
  /** Agent Skills 标准的 kebab-case 标识，与父目录同名。模型和 `/name` 都按它认。 */
  readonly name: string
  /**
   * 给人看的名字，取正文第一个一级标题。标准把 `name` 钉死成 kebab-case，界面上直接显示
   * 它就是一串英文，所以标题另取一处——不改标准，也不多一个 frontmatter 字段。
   */
  readonly title: string
  readonly description: string
  readonly content: string
  /** 磁盘上这个技能的目录，附属文件只在它里面找。 */
  readonly directory: string
}

/** 正文的第一个一级标题就是这条技能的人类标题；没有就退回 kebab-case 的 name。 */
export function agentSkillTitle(content: string, name: string): string {
  const heading = /^#[ \t]+(.+?)[ \t]*$/m.exec(content)
  return heading?.[1] || name
}

/** 附属文件的大小上限：技能正文与参考资料是给模型读的散文，不是数据集。 */
export const AGENT_SKILL_FILE_MAX_BYTES = 64 * 1024

/**
 * 给模型看的技能位置。**不是磁盘路径**：服务器绝对路径泄露给模型没有任何用处，
 * 还会诱导它去猜一个它根本调不到的文件读工具。
 */
export function agentSkillLocation(skill: { readonly name: string }): string {
  return `skill://${skill.name}/SKILL.md`
}

/** 技能目录的默认位置：`apps/bff/skills`，相对本文件解析——镜像里 cwd 是 `/app`，不能靠它。 */
export function defaultAgentSkillsRoot(): string {
  return join(import.meta.dir, '../../../skills')
}

type SkillIndex = Readonly<Record<AgentMode, readonly AgentSkill[]>>

const EMPTY_INDEX: SkillIndex = { image: [], video: [] }

let root = defaultAgentSkillsRoot()
let index: SkillIndex = EMPTY_INDEX
let loading: Promise<SkillIndex> | undefined

function directoryOf(filePath: string): string {
  const at = filePath.lastIndexOf(sep)
  return at <= 0 ? filePath : filePath.slice(0, at)
}

/** 同名技能只留先到的那个：`<mode>/` 覆盖 `shared/`，两边同名时按 mode 专属的算。 */
function dedupe(skills: readonly AgentSkill[]): AgentSkill[] {
  const seen = new Set<string>()
  return skills.filter((skill) => {
    if (seen.has(skill.name)) return false
    seen.add(skill.name)
    return true
  })
}

/**
 * 这次读盘是不是完整地读完了。文件系统这一刻不给读（权限、挂载还没就绪、镜像层还在解压）
 * 与「这个部署本来就没有技能」长得一模一样，所以把它们分开：不完整的那次不许进缓存。
 */
const RETRYABLE_DIAGNOSTICS: ReadonlySet<string> = new Set([
  'file_info_failed',
  'list_failed',
  'read_failed',
])

interface LoadedSkills {
  readonly skills: AgentSkill[]
  /** 整棵树都读到了；false 表示这次的结果只是当下能读到的那部分。 */
  readonly complete: boolean
}

async function loadFrom(dirs: readonly string[]): Promise<LoadedSkills> {
  const env = new NodeExecutionEnv({ cwd: root })
  const result = await loadSkills(env, [...dirs], BACKGROUND_CONTEXT)
  let complete = true
  for (const diagnostic of result.diagnostics) {
    if (RETRYABLE_DIAGNOSTICS.has(diagnostic.code)) complete = false
    log.warn(
      { event: 'agent.skill_diagnostic', code: diagnostic.code, path: diagnostic.path },
      diagnostic.message,
    )
  }
  return {
    complete,
    skills: result.skills
      .filter((skill) => !skill.disableModelInvocation)
      .map((skill) => ({
        name: skill.name,
        title: agentSkillTitle(skill.content, skill.name),
        description: skill.description,
        content: skill.content,
        directory: directoryOf(skill.filePath),
      })),
  }
}

/** 技能根目录在不在。不在是「这个部署没有技能」，在却空着是「有人漏了什么」。 */
async function rootExists(): Promise<boolean> {
  try {
    return (await stat(root)).isDirectory()
  } catch {
    return false
  }
}

interface LoadOutcome {
  readonly index: SkillIndex
  readonly complete: boolean
}

async function loadIndex(): Promise<LoadOutcome> {
  try {
    const shared = join(root, 'shared')
    const [image, video] = await Promise.all([
      loadFrom([join(root, 'image'), shared]),
      loadFrom([join(root, 'video'), shared]),
    ])
    const next = { image: dedupe(image.skills), video: dedupe(video.skills) }
    const complete = image.complete && video.complete
    const counts = { image: next.image.length, video: next.video.length }
    if (complete && counts.image + counts.video === 0 && (await rootExists())) {
      // 镜像漏打包 `apps/bff/skills` 与「这个部署本来就没有技能」长得一模一样：
      // 目录在、却一条都读不出来，只有这条日志分得开。
      log.error(
        { event: 'agent.skills_empty', root },
        'agent skills directory exists but holds no usable skill',
      )
    } else {
      log.info({ event: 'agent.skills_loaded', ...counts, complete }, 'agent skills loaded')
    }
    return { index: next, complete }
  } catch (thrown) {
    // 技能是加分项，不是服务的起跑线：读不出来就当这个部署此刻没有技能，别让 BFF 起不来。
    log.error({ event: 'agent.skills_load_failed', err: thrown }, 'agent skills not loaded')
    return { index: EMPTY_INDEX, complete: false }
  }
}

/**
 * 加载一次并缓存。起轮前和 BFF 启动时都会叫它，重复调用共享同一次读盘。
 * **只有完整读完的那次才进缓存**：否则文件系统一次不给读，这个进程到死都没有技能。
 */
export function ensureAgentSkills(): Promise<SkillIndex> {
  loading ??= loadIndex().then((outcome) => {
    index = outcome.index
    if (!outcome.complete) loading = undefined
    return outcome.index
  })
  return loading
}

/** 这个 mode 看得见的技能。`ensureAgentSkills()` 之前一律是空的。 */
export function agentSkills(mode: AgentMode): readonly AgentSkill[] {
  return index[mode]
}

export function findAgentSkill(mode: AgentMode, name: string): AgentSkill | undefined {
  return index[mode].find((skill) => skill.name === name)
}

export function agentSkillSummaries(mode: AgentMode): AgentSkillSummary[] {
  return index[mode].map(({ name, title, description }) => ({ name, title, description }))
}

/** 测试注入目录用的接缝：换根目录并丢掉缓存，下一次 `ensureAgentSkills()` 重新读盘。 */
export function setAgentSkillsRootForTesting(next: string | null): void {
  root = next ?? defaultAgentSkillsRoot()
  index = EMPTY_INDEX
  loading = undefined
}

/**
 * 技能全文进上下文的那一段。复用框架的格式，但位置换成虚拟路径。
 * `extra` 是用户在 `/skill-name` 后面跟着写的其余文字。
 */
export function agentSkillInvocation(skill: AgentSkill, extra?: string): string {
  return formatSkillInvocation(
    {
      name: skill.name,
      description: skill.description,
      content: skill.content,
      filePath: agentSkillLocation(skill),
    },
    extra?.trim() || undefined,
  )
}

export type AgentSkillFileFailure =
  | { readonly kind: 'unknown-skill' }
  | { readonly kind: 'escapes-skill' }
  | { readonly kind: 'too-large' }
  | { readonly kind: 'unreadable' }

export type AgentSkillFileResult =
  | { readonly kind: 'ok'; readonly text: string }
  | AgentSkillFileFailure

/**
 * 读技能目录里的附属文件。**路径穿越在这里挡死**：绝对路径、`..`、软链指出去，
 * 规范化之后只要不在这个技能自己的目录里就一律拒绝，不给「读到什么算什么」留缝。
 */
export async function readAgentSkillFile(
  mode: AgentMode,
  name: string,
  file: string,
): Promise<AgentSkillFileResult> {
  const skill = findAgentSkill(mode, name)
  if (!skill) return { kind: 'unknown-skill' }
  const base = resolve(skill.directory)
  const target = resolve(base, file)
  if (target === base || !target.startsWith(base + sep)) return { kind: 'escapes-skill' }
  let real: string
  let realBase: string
  try {
    // 规范化之后再量一次：`resolve` 不解软链，指出去的软链会从字面上看起来仍在目录里。
    ;[real, realBase] = await Promise.all([realpath(target), realpath(base)])
  } catch {
    return { kind: 'unreadable' }
  }
  if (real === realBase || !real.startsWith(realBase + sep)) return { kind: 'escapes-skill' }
  try {
    const handle = Bun.file(real)
    if (handle.size > AGENT_SKILL_FILE_MAX_BYTES) return { kind: 'too-large' }
    return { kind: 'ok', text: await handle.text() }
  } catch {
    return { kind: 'unreadable' }
  }
}
