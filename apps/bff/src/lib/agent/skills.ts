import { realpath, stat } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import {
  BACKGROUND_CONTEXT,
  formatSkillInvocation,
  loadSkills,
} from '@earendil-works/pi-agent-core'
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node'
import {
  type AgentMode,
  type AgentSkillSummary,
  type AgentSkillTemplate,
  DEFAULT_AGENT_SKILL_ICON,
  LOOK_PURPOSES,
  LOOK_SKILL_NAME_PREFIX,
  type LookPurpose,
  lookSkillName,
} from '@image-playground/shared'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { db, schema } from '../../db/client'
import { isCapabilityEnabled } from '../capabilities'
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
  /** 磁盘上这个技能的目录，附属文件只在它里面找。用户自建的模板不在磁盘上，这里是空串。 */
  readonly directory: string
  /** 界面用的 lucide 图标名，来自 `meta.json`；**不进任何给模型的文本**。 */
  readonly icon: string
  /** 界面用的一句话简介，来自 `meta.json`；空串表示没写。**不进任何给模型的文本**。 */
  readonly summary: string
  /**
   * 这条技能同时是一条**预置模板**时才有（见 CONTEXT.md「预置模板」）。
   * **不进任何给模型的文本**：模板正文照常由 `loadSkill` 读，这几项只供界面排卡片。
   */
  readonly template?: AgentSkillTemplateMeta
}

/**
 * `meta.json` 里那段模板标记。图片写文件名，就在这个技能自己的目录里——
 * 发给前端的那一份（{@link AgentSkillTemplate}）才把它们换成地址。
 */
export interface AgentSkillTemplateMeta {
  readonly purpose: LookPurpose
  /** 钉死的模型。 */
  readonly model: string
  /** 钉死的尺寸。 */
  readonly size: string
  /** 需要几条素材填进去。 */
  readonly slotCount: number
  readonly cover: string
  /** 参考图文件名，顺序即界面上的顺序。 */
  readonly references: readonly string[]
}

/**
 * 技能的界面元数据，放在技能目录的 `meta.json` 里。
 *
 * **为什么不写进 frontmatter**：Agent Skills 标准的 frontmatter 只有 `name` 与 `description`，
 * 框架的 `loadSkills` 也不保留额外字段——塞进去等于加一条只有我们认的方言，还拿不回来。
 * 旁路文件读不到就整条回退，技能本身照常可用。
 */
export interface AgentSkillMeta {
  readonly icon: string
  readonly summary: string
  /** 有它就说明这条技能是一条预置模板；写坏了会被丢掉，技能本身不受影响。 */
  readonly template?: AgentSkillTemplateMeta
}

/** 技能目录里那份界面元数据的文件名。 */
export const AGENT_SKILL_META_FILE = 'meta.json'

const FALLBACK_META: AgentSkillMeta = { icon: DEFAULT_AGENT_SKILL_ICON, summary: '' }

/** lucide 图标名的形状：kebab-case。写成 `Clapperboard` 这种前端映射表里查不到。 */
const ICON_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * 读一个技能目录的 `meta.json`。**读不到、解析不了、字段不合规都只是回退**：
 * 图标退到默认值、简介退成空串（界面自己回退到 description），技能一条都不丢。
 */
async function loadSkillMeta(directory: string, name: string): Promise<AgentSkillMeta> {
  const path = join(directory, AGENT_SKILL_META_FILE)
  let parsed: unknown
  try {
    parsed = JSON.parse(await Bun.file(path).text())
  } catch (thrown) {
    log.warn(
      { event: 'agent.skill_meta_unreadable', skill: name, path, err: thrown },
      'agent skill meta.json missing or unparsable; falling back to defaults',
    )
    return FALLBACK_META
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    log.warn(
      { event: 'agent.skill_meta_invalid', skill: name, path },
      'agent skill meta.json is not an object',
    )
    return FALLBACK_META
  }
  const raw = parsed as { icon?: unknown; summary?: unknown; template?: unknown }
  const icon = typeof raw.icon === 'string' ? raw.icon.trim() : ''
  const summary = typeof raw.summary === 'string' ? raw.summary.trim() : ''
  if (!ICON_NAME_RE.test(icon)) {
    log.warn(
      { event: 'agent.skill_meta_invalid', skill: name, path, field: 'icon' },
      'agent skill meta.json has no usable kebab-case icon name',
    )
  }
  if (!summary) {
    log.warn(
      { event: 'agent.skill_meta_invalid', skill: name, path, field: 'summary' },
      'agent skill meta.json has no usable summary',
    )
  }
  const template = await loadTemplateMeta(directory, name, raw.template)
  return {
    icon: ICON_NAME_RE.test(icon) ? icon : DEFAULT_AGENT_SKILL_ICON,
    summary,
    ...(template ? { template } : {}),
  }
}

/** 模板图片的文件名形状：只认这个目录里的图片文件，路径与非图片一律不认。 */
const TEMPLATE_IMAGE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|jpe?g|webp)$/i

/**
 * 读 `meta.json` 里的模板标记。**写坏了只丢标记，不丢技能**：那条退回成普通技能，模型照常
 * 读得到，只是不出现在模板页上。图片当场验在不在——模板页上挂一张取不到的封面，比这条模板
 * 干脆不出现更难查。
 */
async function loadTemplateMeta(
  directory: string,
  name: string,
  raw: unknown,
): Promise<AgentSkillTemplateMeta | undefined> {
  if (raw === undefined) return undefined
  const drop = (field: string, files?: readonly string[]): undefined => {
    log.warn(
      { event: 'agent.skill_template_invalid', skill: name, field, ...(files ? { files } : {}) },
      'agent skill template marker dropped; skill stays, template does not',
    )
    return undefined
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return drop('template')
  const value = raw as Record<string, unknown>
  const purpose = LOOK_PURPOSES.find((one) => one === value.purpose)
  if (!purpose) return drop('purpose')
  const model = typeof value.model === 'string' ? value.model.trim() : ''
  if (!model) return drop('model')
  const size = typeof value.size === 'string' ? value.size.trim() : ''
  if (!size) return drop('size')
  const slotCount = typeof value.slotCount === 'number' ? value.slotCount : 0
  if (!Number.isInteger(slotCount) || slotCount < 1) return drop('slotCount')
  const cover = typeof value.cover === 'string' ? value.cover.trim() : ''
  if (!TEMPLATE_IMAGE_RE.test(cover)) return drop('cover')
  const listed = Array.isArray(value.references) ? value.references : []
  if (listed.some((one) => typeof one !== 'string' || !TEMPLATE_IMAGE_RE.test(one)))
    return drop('references')
  const references = listed as string[]
  const files = [cover, ...references]
  const present = await Promise.all(files.map((file) => Bun.file(join(directory, file)).exists()))
  const missing = files.filter((_, at) => !present[at])
  if (missing.length > 0) return drop('files', missing)
  return { purpose, model, size, slotCount, cover, references }
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
  const skills = await Promise.all(
    result.skills
      .filter((skill) => !skill.disableModelInvocation)
      .map(async (skill) => {
        const directory = directoryOf(skill.filePath)
        const meta = await loadSkillMeta(directory, skill.name)
        return {
          name: skill.name,
          title: agentSkillTitle(skill.content, skill.name),
          description: skill.description,
          content: skill.content,
          directory,
          icon: meta.icon,
          summary: meta.summary,
          ...(meta.template ? { template: meta.template } : {}),
        }
      }),
  )
  return { complete, skills }
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
  return index[mode].map(agentSkillSummary)
}

/** 一条技能发给界面的那一份。模板的图片在这里换成地址：前端拼不出这条路，也不该拼。 */
function agentSkillSummary(skill: AgentSkill): AgentSkillSummary {
  const { name, title, description, icon, summary, template } = skill
  return {
    name,
    title,
    description,
    icon,
    summary,
    ...(template
      ? {
          template: {
            purpose: template.purpose,
            model: template.model,
            size: template.size,
            slotCount: template.slotCount,
            body: skill.content,
            coverUrl: agentSkillFileUrl(name, template.cover),
            referenceUrls: template.references.map((file) => agentSkillFileUrl(name, file)),
          } satisfies AgentSkillTemplate,
        }
      : {}),
  }
}

/** 技能目录里那张图片的公开地址。模板的封面与参考图只从这里取。 */
export function agentSkillFileUrl(name: string, file: string): string {
  return `/api/agent/skills/${encodeURIComponent(name)}/files/${encodeURIComponent(file)}`
}

/**
 * 这一轮看得见的技能：内置的，加上这个用户自建的模板。
 *
 * **模板只属于出图轮**：它是一套出图效果，钉的是出图模型与尺寸；内置模板同样只放在 `image/` 下，
 * 用户自建的那些也按同一条规矩，视频轮一条都不列。
 */
export function visibleAgentSkills(
  mode: AgentMode,
  audience: AgentTurnAudience,
): readonly AgentSkill[] {
  return mode === 'image' ? [...index[mode], ...audience.looks] : index[mode]
}

/**
 * 界面要的那一份清单：内置技能，加上这个用户自建的模板。模板对这个用户来说就是技能，
 * 所以 `/` 菜单、模板页与这一轮的模型读的是同一份，可见规则也是同一条。
 */
export async function listAgentSkillSummaries(
  mode: AgentMode,
  userId: string | null,
): Promise<AgentSkillSummary[]> {
  const looks = mode === 'image' ? await userLookSkills(userId) : []
  return visibleAgentSkills(mode, { userId, looks }).map(agentSkillSummary)
}

/**
 * 这一轮谁在看。技能清单与工具清单都按它裁：登录用户看得见自己的模板，设备用户一条都没有。
 * 起轮前取一次，本轮之后处处按这一份算——`<available_skills>` 与 `/look-<id>` 才不会各说各的。
 */
export interface AgentTurnAudience {
  /** 登录用户；device-only 用户为 null。 */
  readonly userId: string | null
  /** 这个用户自建的模板，已经是技能的样子。 */
  readonly looks: readonly AgentSkill[]
}

/** 没有登录用户的那一轮：没有模板，也没有只有登录用户才有的工具。 */
export const ANONYMOUS_AUDIENCE: AgentTurnAudience = { userId: null, looks: [] }

/** 起轮前取一次这个用户的模板。取不到不算错：这一轮就当他没有模板。 */
export async function loadAgentTurnAudience(userId: string | null): Promise<AgentTurnAudience> {
  return { userId, looks: await userLookSkills(userId) }
}

/**
 * 一次最多带这么多条模板。常驻上下文里每条都要花掉名字与描述那几十个 token，`/` 菜单也排不下
 * 更多。超出的那些并没有消失：`/look-<id>` 与 `loadSkill` 按 id 直取，不看这份清单。
 */
export const AGENT_LOOK_SKILL_LIMIT = 40

/** 合成技能只要这几列，正文之外的同步列一列都不读。 */
const lookColumns = {
  id: schema.user_looks.id,
  name: schema.user_looks.name,
  description: schema.user_looks.description,
  body: schema.user_looks.body,
  model: schema.user_looks.model,
  size: schema.user_looks.size,
  slotCount: schema.user_looks.slot_count,
}

/** 墓碑行的内容列全空，所以除了 id 都可空；合成技能前逐列验。 */
interface LookRow {
  readonly id: string
  readonly name: string | null
  readonly description: string | null
  readonly body: string | null
  readonly model: string | null
  readonly size: string | null
  readonly slotCount: number | null
}

/** 这个用户自建的模板，最近用过的在前。读不出来只是这一轮没有模板，不该把整轮拖垮。 */
async function userLookSkills(userId: string | null): Promise<AgentSkill[]> {
  if (!userId || !isCapabilityEnabled('accounts:sync')) return []
  try {
    const rows = await db
      .select(lookColumns)
      .from(schema.user_looks)
      .where(and(eq(schema.user_looks.user_id, userId), isNull(schema.user_looks.deleted_at)))
      // 没用过的按改动时间排；`last_used_at` 为空时 DESC 会把它们顶到最前面。
      .orderBy(
        desc(sql`coalesce(${schema.user_looks.last_used_at}, ${schema.user_looks.updated_at})`),
      )
      .limit(AGENT_LOOK_SKILL_LIMIT)
    return rows.flatMap((row) => lookSkill(row) ?? [])
  } catch (thrown) {
    log.warn(
      { event: 'agent.user_looks_unreadable', userId, err: thrown },
      'user looks not loaded; this turn has none',
    )
    return []
  }
}

/** 单条模板。按 id 直取，不受清单条数限制：用户点名的那条一定读得到。 */
async function readUserLook(userId: string, id: string): Promise<AgentSkill | undefined> {
  if (!isCapabilityEnabled('accounts:sync')) return undefined
  try {
    const [row] = await db
      .select(lookColumns)
      .from(schema.user_looks)
      .where(
        and(
          eq(schema.user_looks.user_id, userId),
          eq(schema.user_looks.id, id),
          isNull(schema.user_looks.deleted_at),
        ),
      )
      .limit(1)
    return row ? lookSkill(row) : undefined
  } catch (thrown) {
    log.warn(
      { event: 'agent.user_look_unreadable', userId, look: id, err: thrown },
      'user look not loaded; treating it as unknown',
    )
    return undefined
  }
}

/**
 * 按名字找这一轮能用的技能：先内置，再看是不是这个用户的模板。
 * `loadSkill` 与 `/name` 都走它，两条路才认同一份清单，可见规则与
 * {@link visibleAgentSkills} 同一条（模板只属于出图轮）。
 */
export async function resolveAgentSkill(
  mode: AgentMode,
  name: string,
  userId: string | null,
): Promise<AgentSkill | undefined> {
  const builtin = findAgentSkill(mode, name)
  if (builtin || mode !== 'image' || !userId || !name.startsWith(LOOK_SKILL_NAME_PREFIX))
    return builtin
  return readUserLook(userId, name.slice(LOOK_SKILL_NAME_PREFIX.length))
}

/**
 * 用户模板合成出来的那份 `SKILL.md`。它不在磁盘上，但形状与磁盘上的技能一样：
 * frontmatter 记名字与描述，正文前面补一行钉死的模型 / 尺寸 / 素材位——
 * 模型照着正文干活时，这三样必须跟正文在同一段文字里，否则它会自己挑一个模型的参数去写。
 */
export function lookSkillContent(look: {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly body: string
  readonly model: string | null
  readonly size: string | null
  readonly slotCount: number | null
}): string {
  // frontmatter 与标题只吃一行：正文里的换行进了 YAML 就是一份读不出来的 frontmatter。
  const pinned =
    look.model && look.size && look.slotCount !== null
      ? [`模型：${look.model} · 尺寸：${look.size} · 素材位：${look.slotCount}`, '']
      : []
  return [
    '---',
    `name: ${lookSkillName(look.id)}`,
    `description: ${look.description.replace(/\s+/g, ' ').trim()}`,
    '---',
    '',
    `# ${look.name.replace(/\s+/g, ' ').trim()}`,
    '',
    ...pinned,
    look.body.trim(),
  ].join('\n')
}

/**
 * 一条模板在技能体系里的样子。内容列在活记录上不为空（库里有 CHECK），真读到空的就当这条
 * 不存在——宁可少一条模板，也不要给模型一份空指引让它照着编。
 */
function lookSkill(row: LookRow): AgentSkill | undefined {
  const { id, name, description, body } = row
  if (!name || !description || !body) return undefined
  return {
    name: lookSkillName(id),
    title: name,
    description,
    content: lookSkillContent({ ...row, name, description, body }),
    // 用户模板不在磁盘上：没有附属文件，也不该有人拿它去读文件。
    directory: '',
    icon: DEFAULT_AGENT_SKILL_ICON,
    summary: '',
  }
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
  /** 只有取字节那一路会给：这个名字不是图片，别的东西不从这条路发出去。 */
  | { readonly kind: 'not-an-image' }

export type AgentSkillFileResult =
  | { readonly kind: 'ok'; readonly text: string }
  | AgentSkillFileFailure

/**
 * 附属文件落在哪。**路径穿越在这里挡死**：绝对路径、`..`、软链指出去，
 * 规范化之后只要不在这个技能自己的目录里就一律拒绝，不给「读到什么算什么」留缝。
 */
async function resolveAgentSkillFile(
  mode: AgentMode,
  name: string,
  file: string,
): Promise<{ readonly kind: 'ok'; readonly path: string } | AgentSkillFileFailure> {
  const skill = findAgentSkill(mode, name)
  // 用户自建的模板没有目录：正文是合成的，附属文件一份都没有。
  if (!skill?.directory) return { kind: 'unknown-skill' }
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
  return { kind: 'ok', path: real }
}

/** 读技能目录里的附属文件，给模型看的那一份，所以有散文的大小上限。 */
export async function readAgentSkillFile(
  mode: AgentMode,
  name: string,
  file: string,
): Promise<AgentSkillFileResult> {
  const located = await resolveAgentSkillFile(mode, name, file)
  if (located.kind !== 'ok') return located
  try {
    const handle = Bun.file(located.path)
    if (handle.size > AGENT_SKILL_FILE_MAX_BYTES) return { kind: 'too-large' }
    return { kind: 'ok', text: await handle.text() }
  } catch {
    return { kind: 'unreadable' }
  }
}

/** 图片的大小上限。图片不给模型读，所以不受那 64 KB 约束；这一条只挡「有人往技能目录里倒数据」。 */
export const AGENT_SKILL_IMAGE_MAX_BYTES = 8 * 1024 * 1024

const SKILL_IMAGE_CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
}

export type AgentSkillBytesResult =
  /** `Uint8Array<ArrayBuffer>`：直接当 `Response` 的 body 发得出去。 */
  | { readonly kind: 'ok'; readonly bytes: Uint8Array<ArrayBuffer>; readonly contentType: string }
  | AgentSkillFileFailure

/**
 * 技能目录里那张图片的字节：预置模板的封面与参考图走这一路。**只发图片**——
 * 同一个目录里还有给模型读的正文，按扩展名先卡死，路径守卫与读文本那一路同一份。
 */
export async function readAgentSkillFileBytes(
  mode: AgentMode,
  name: string,
  file: string,
): Promise<AgentSkillBytesResult> {
  const contentType = SKILL_IMAGE_CONTENT_TYPES[extname(file).toLowerCase()]
  if (!contentType) return { kind: 'not-an-image' }
  const located = await resolveAgentSkillFile(mode, name, file)
  if (located.kind !== 'ok') return located
  try {
    const handle = Bun.file(located.path)
    if (handle.size > AGENT_SKILL_IMAGE_MAX_BYTES) return { kind: 'too-large' }
    return { kind: 'ok', bytes: new Uint8Array(await handle.arrayBuffer()), contentType }
  } catch {
    return { kind: 'unreadable' }
  }
}
