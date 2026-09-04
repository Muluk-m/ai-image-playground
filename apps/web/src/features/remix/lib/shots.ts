import type { CompetitorBrief, ShotType } from '@image-playground/shared'
import type {
  RemixBrief,
  RemixProductAsset,
  RemixSetSettings,
  RemixShot,
  RemixShotCopy,
} from '../types'
import { cameraToAngle, matchProductAsset } from './angleMatch'
import { buildShotPrompt, isRenderableShotType } from './prompt'

const EMPTY_BRIEF: RemixBrief = {
  composition: '',
  camera: '',
  lighting: '',
  background: '',
  props: [],
  textZones: [],
  palette: [],
  productBox: null,
}

export interface ShotContext {
  settings: RemixSetSettings
  /** 机位 → 同角度底图的 imageId，缺角度时 undefined。 */
  productImageFor: (camera: string) => string | undefined
}

export interface RemixShotPatch {
  type?: ShotType
  brief?: Partial<RemixBrief>
  copy?: Partial<RemixShotCopy>
  prompt?: string
  enabled?: boolean
}

/** 缺底图或不生图的镜头不能勾选：角度不匹配时模型会改产品，尺寸图生不出来。 */
export function canGenerateShot(shot: RemixShot): boolean {
  return isRenderableShotType(shot.type) && Boolean(shot.productImageId)
}

export function productImageResolver(
  productAssets: readonly RemixProductAsset[],
  imageIdOf: (assetId: string) => string | undefined,
): (camera: string) => string | undefined {
  return (camera) => {
    const match = matchProductAsset(cameraToAngle(camera), productAssets)
    return match ? imageIdOf(match.assetId) : undefined
  }
}

function promptFor(shot: Pick<RemixShot, 'type' | 'brief' | 'copy'>, ctx: ShotContext): string {
  return buildShotPrompt({
    type: shot.type,
    product: ctx.settings.product,
    brief: shot.brief,
    copy: shot.copy,
    level: ctx.settings.level,
    language: ctx.settings.language,
  })
}

function makeShot(
  competitorImageId: string,
  type: ShotType,
  brief: RemixBrief,
  copy: RemixShotCopy,
  referenceImageId: string,
  ctx: ShotContext,
): RemixShot {
  const productImageId = ctx.productImageFor(brief.camera)
  const draft: RemixShot = {
    id: crypto.randomUUID(),
    type,
    competitorImageId,
    brief,
    copy,
    prompt: '',
    promptEdited: false,
    enabled: false,
    referenceImageId,
    ...(productImageId ? { productImageId } : {}),
    status: 'pending',
  }
  return { ...draft, prompt: promptFor(draft, ctx), enabled: canGenerateShot(draft) }
}

export function createShot(
  competitorImageId: string,
  brief: CompetitorBrief,
  referenceImageId: string,
  ctx: ShotContext,
): RemixShot {
  const { shotType, suggestedTitle, ...rest } = brief
  return makeShot(
    competitorImageId,
    shotType,
    rest,
    { title: suggestedTitle ?? '', subtitle: brief.textZones[0] ?? '' },
    referenceImageId,
    ctx,
  )
}

/** 分析不可用时的空白镜头：简报与提示词由人手填。 */
export function createBlankShot(competitorImageId: string, ctx: ShotContext): RemixShot {
  return makeShot(
    competitorImageId,
    'other',
    { ...EMPTY_BRIEF },
    { title: '', subtitle: '' },
    competitorImageId,
    ctx,
  )
}

export function applyShotPatch(
  shot: RemixShot,
  patch: RemixShotPatch,
  ctx: ShotContext,
): RemixShot {
  const next: RemixShot = {
    ...shot,
    type: patch.type ?? shot.type,
    brief: { ...shot.brief, ...patch.brief },
    copy: { ...shot.copy, ...patch.copy },
  }

  if (patch.brief?.camera !== undefined) {
    const productImageId = ctx.productImageFor(next.brief.camera)
    if (productImageId) next.productImageId = productImageId
    else delete next.productImageId
  }

  if (patch.prompt !== undefined) {
    next.prompt = patch.prompt
    next.promptEdited = true
  } else if (!next.promptEdited) {
    next.prompt = promptFor(next, ctx)
  }

  next.enabled = (patch.enabled ?? next.enabled) && canGenerateShot(next)
  return next
}

/** 重新生成提示词：手改的标记一并撤销，之后简报改动重新生效。 */
export function regenerateShotPrompt(shot: RemixShot, ctx: ShotContext): RemixShot {
  return { ...shot, prompt: promptFor(shot, ctx), promptEdited: false }
}
