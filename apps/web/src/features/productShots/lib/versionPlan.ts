import {
  type BgSceneType,
  buildBackgroundPrompt,
  DEFAULT_BG_SWAP_MODE,
  type ProductBox,
  type PromptLanguage,
} from '@image-playground/shared'
import type { RemixBrief, RemixProductDescription, RemixShotCopy } from '../../../lib/shotTypes'
import type { ProductShotVersion } from '../types'
import { buildRemixPrompt, DEFAULT_REMIX_LEVEL } from './remixPlan'

/** 重算提示词要的任务级设定；动作、档位与简报由版本自己带。 */
export interface VersionPlanContext {
  product: RemixProductDescription
  language: PromptLanguage
  preference: string
  sceneType: BgSceneType
}

/** 抽屉里能改的东西。给了 `prompt` 就是手改，其余是简报字段。 */
export interface VersionPlanPatch {
  plan?: string
  productBox?: ProductBox | null
  brief?: Partial<RemixBrief>
  copy?: Partial<RemixShotCopy>
  prompt?: string
}

/** 按版本当前的字段重算提示词。借创意重做的旧记录没有简报，重算不出来就留原文。 */
export function versionPrompt(version: ProductShotVersion, ctx: VersionPlanContext): string {
  const mode = version.mode ?? DEFAULT_BG_SWAP_MODE
  if (mode !== 'remix') {
    return buildBackgroundPrompt({
      plan: version.plan,
      sceneType: ctx.sceneType,
      inventory: version.inventory ?? [],
      preference: ctx.preference,
      language: ctx.language,
      mode,
    })
  }
  if (!version.brief) return version.prompt
  return buildRemixPrompt({
    // 旧记录没记镜型，按不带图上文案的一般镜型重算。
    shotType: version.shotType ?? 'other',
    brief: version.brief,
    copy: version.copy ?? { title: '', subtitle: '' },
    product: ctx.product,
    level: version.level ?? DEFAULT_REMIX_LEVEL,
    language: ctx.language,
  })
}

export function editVersionPlan(
  version: ProductShotVersion,
  patch: VersionPlanPatch,
  ctx: VersionPlanContext,
): ProductShotVersion {
  const next: ProductShotVersion = {
    ...version,
    plan: patch.plan ?? version.plan,
    ...(patch.productBox !== undefined ? { productBox: patch.productBox } : {}),
    ...(version.brief && patch.brief ? { brief: { ...version.brief, ...patch.brief } } : {}),
    ...(patch.copy ? { copy: { title: '', subtitle: '', ...version.copy, ...patch.copy } } : {}),
  }

  if (patch.prompt !== undefined) return { ...next, prompt: patch.prompt, promptEdited: true }
  if (next.promptEdited) return next
  return { ...next, prompt: versionPrompt(next, ctx) }
}

/** 重置为 AI 版本：手改标记一并撤销，之后简报改动重新生效。 */
export function resetVersionPrompt(
  version: ProductShotVersion,
  ctx: VersionPlanContext,
): ProductShotVersion {
  return { ...version, prompt: versionPrompt(version, ctx), promptEdited: false }
}
