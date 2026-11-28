import type { LOOK_PURPOSES } from '../sync-protocol'

/**
 * 技能没写 `meta.json`、或写坏了时用的图标。技能不会因此被丢掉，只是长得一样。
 * 前端的白名单映射表必须收着它，否则回退还得再回退一次。
 */
export const DEFAULT_AGENT_SKILL_ICON = 'sparkles'

/** 模板（look）的用途。取值表只在同步协议里存一份，这里派生成联合类型。 */
export type LookPurpose = (typeof LOOK_PURPOSES)[number]

/** 用户自建模板在技能体系里的名字前缀：一条模板就是一条名叫 `look-<id>` 的技能。 */
export const LOOK_SKILL_NAME_PREFIX = 'look-'

/** 模板 id 与技能标识之间只有这一条换算，浏览器端与服务端共用它，`/look-<id>` 才对得上。 */
export function lookSkillName(id: string): string {
  return `${LOOK_SKILL_NAME_PREFIX}${id}`
}

/**
 * 这条技能同时是一条**预置模板**时随清单一起发的那几项（见 CONTEXT.md「预置模板」）。
 * 缺席即这条技能只是流程指引，不是模板。
 *
 * 模型不从这里读正文：它照常调 `loadSkill`。这一份是给界面的——模板页排卡片，
 * 出图模式在本地按 `body` 装配请求（用户自建的模板正文本来就在本机，只有预置的要跟着发）。
 */
export interface AgentSkillTemplate {
  readonly purpose: LookPurpose
  /** 钉死的模型；不在当前 channel 清单里时界面标「需重新调试」。 */
  readonly model: string
  /** 钉死的尺寸，与出图参数同一套写法。 */
  readonly size: string
  /** 需要几条素材填进去。 */
  readonly slotCount: number
  /** 技能正文（frontmatter 之后的 markdown，按 `## N.` 分节）。 */
  readonly body: string
  /** 封面图地址，直接 GET 取字节。 */
  readonly coverUrl: string
  /** 参考图地址，顺序与技能目录里写的一致。 */
  readonly referenceUrls: readonly string[]
}

/**
 * 起手句的分组（见 CONTEXT.md「场景」）。取值固定，界面按它排场景按钮，文案在前端语料里。
 * 与换背景语境里的「场景」不是一回事。
 */
export const AGENT_SKILL_SCENES = ['ecommerce', 'poster', 'scene-character', 'look'] as const

export type AgentSkillScene = (typeof AGENT_SKILL_SCENES)[number]

/** 运营在 `meta.json` 里写的中英两份文案；英文缺席时界面回退中文。 */
export interface AgentLocalizedText {
  readonly 'zh-CN': string
  readonly en?: string
}

/**
 * 技能声明的一个**素材位**（见 CONTEXT.md「素材位」）：一个位代表一个主体。
 * 预置模板没写时由 `slotCount` 派生成 `asset1..N`。
 */
export interface AgentSkillInput {
  /** 稳定标识，起手句里写成 `{key}` 引用它。 */
  readonly key: string
  readonly label: AgentLocalizedText
  readonly required: boolean
  /** 能不能放同一主体的多张图。 */
  readonly multiple: boolean
}

/**
 * 技能声明的一条**起手句**（见 CONTEXT.md「起手句」）。文字里的 `{key}` 是素材位引用，
 * 只能引用这条技能声明过的位。
 */
export interface AgentSkillStarter {
  readonly text: AgentLocalizedText
  /** 填进输入框后自动选中的那个示例词；必须出现在对应语言的 `text` 里。 */
  readonly highlight?: AgentLocalizedText
}

/** 起手句文字里的素材位引用：`{key}`。服务端校验与界面拆分共用这一条。 */
export const AGENT_SKILL_INPUT_REF_RE = /\{([A-Za-z0-9_-]+)\}/g

/** 这份文案按界面语言该取哪一种：英文缺席或为空时回退中文。 */
export function localizedTextLocale(
  text: AgentLocalizedText,
  language: string,
): keyof AgentLocalizedText {
  return language.startsWith('en') && text.en ? 'en' : 'zh-CN'
}

/** 文案按界面语言取一份：英文缺席或为空时回退中文。 */
export function localizedText(text: AgentLocalizedText, language: string): string {
  return text[localizedTextLocale(text, language)] ?? text['zh-CN']
}

/**
 * 技能清单端点给前端的那一份：标识、标题、「何时用」，外加界面用的图标与一句话简介。
 * `name` 是 Agent Skills 标准的 kebab-case 标识，服务端只认它；`title` 是给人看的那个名字。
 *
 * `icon` / `summary` 来自技能目录里的 `meta.json`，**只走界面**：它们不进系统提示词、
 * 不进任何给模型的文本（见 `apps/bff/src/lib/agent/turn-input.ts` 的 `<available_skills>`）。
 */
export interface AgentSkillSummary {
  readonly name: string
  readonly title: string
  readonly description: string
  /** lucide 图标名，kebab-case。前端按白名单映射成组件，不认识的名字回退默认图标。 */
  readonly icon: string
  /** 写给用户的一句话简介；空串表示这条技能没写，界面回退到去掉「何时用：」的 description。 */
  readonly summary: string
  /** 这条技能同时是一条预置模板时才有；缺席即它只是流程指引。 */
  readonly template?: AgentSkillTemplate
  /** 素材位声明，始终在：预置模板没写时已由 `slotCount` 派生好。 */
  readonly inputs: readonly AgentSkillInput[]
  /** 起手句；引用了未声明素材位的那些已在服务端丢掉。 */
  readonly starters: readonly AgentSkillStarter[]
  /** 起手句归在哪个场景下；缺席即不进场景引导。 */
  readonly scene?: AgentSkillScene
  /**
   * 服务端算好的「已验证」：有验证记录且记录的模型就是这条技能此刻会用的模型。
   * 界面只露出为 true 的技能的起手句，自己不判断。
   */
  readonly verified: boolean
}

/**
 * 读取技能读到了什么。`found` 是机器可读的那一位：面板据它决定这一行说「读取技能」还是
 * 「没找到技能」，不靠匹配工具返回的文案。
 */
export interface AgentSkillOutcome {
  readonly label: string
  readonly found: boolean
  /**
   * 这条技能的图标名，与 `/` 菜单用同一张白名单映射表。老消息里没有这一位（这个字段是后加的），
   * 没找到技能的那次也没有——两种情况界面都退回默认图标。
   */
  readonly icon?: string
  /**
   * 读到的那条技能的标识与附属文件路径：回放历史时照它把正文重新读回来，模型不必每轮再读一遍。
   * 只有读到了才有；老消息里没有这两位，回放就只剩一行摘要。
   */
  readonly name?: string
  readonly file?: string
}
