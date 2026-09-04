import type { BackgroundPreset, CompetitorBrief, ShotType } from '@image-playground/shared'
import type {
  RemixBrief,
  RemixProductAsset,
  RemixSetSettings,
  RemixShot,
  RemixShotCopy,
  RemixSourceKind,
} from '../types'
import { cameraToAngle, matchProductAsset } from './angleMatch'
import { backgroundBriefFromPreset, buildBackgroundSwapPrompt } from './backgroundPrompt'
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
  sourceKind: RemixSourceKind
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
  if (ctx.sourceKind === 'own') {
    return buildBackgroundSwapPrompt({ product: ctx.settings.product, brief: shot.brief })
  }
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
  sourceImageId: string,
  type: ShotType,
  brief: RemixBrief,
  copy: RemixShotCopy,
  images: { referenceImageId?: string; productImageId?: string },
  ctx: ShotContext,
): RemixShot {
  const draft: RemixShot = {
    id: crypto.randomUUID(),
    type,
    sourceImageId,
    brief,
    copy,
    prompt: '',
    promptEdited: false,
    enabled: false,
    ...(images.referenceImageId ? { referenceImageId: images.referenceImageId } : {}),
    ...(images.productImageId ? { productImageId: images.productImageId } : {}),
    taskIds: [],
  }
  return { ...draft, prompt: promptFor(draft, ctx), enabled: canGenerateShot(draft) }
}

export function createShot(
  sourceImageId: string,
  brief: CompetitorBrief,
  referenceImageId: string,
  ctx: ShotContext,
): RemixShot {
  const { shotType, suggestedTitle, ...rest } = brief
  return makeShot(
    sourceImageId,
    shotType,
    rest,
    { title: suggestedTitle ?? '', subtitle: brief.textZones[0] ?? '' },
    { referenceImageId, productImageId: ctx.productImageFor(rest.camera) },
    ctx,
  )
}

/** 分析不可用时的空白镜头：简报与提示词由人手填。 */
export function createBlankShot(sourceImageId: string, ctx: ShotContext): RemixShot {
  return makeShot(
    sourceImageId,
    'other',
    { ...EMPTY_BRIEF },
    { title: '', subtitle: '' },
    { referenceImageId: sourceImageId, productImageId: ctx.productImageFor('') },
    ctx,
  )
}

/** `own` 套按「图 × 风格」展开：原图既是要改的画面，也是它自己的产品底图。 */
export function expandOwnShots(
  imageIds: readonly string[],
  styles: readonly BackgroundPreset[],
  ctx: ShotContext,
): RemixShot[] {
  return imageIds.flatMap((imageId) =>
    styles.map((style) =>
      makeShot(
        imageId,
        'scene',
        backgroundBriefFromPreset(style),
        { title: '', subtitle: '' },
        { productImageId: imageId },
        ctx,
      ),
    ),
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

  if (ctx.sourceKind === 'competitor' && patch.brief?.camera !== undefined) {
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
