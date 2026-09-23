import { PROJECT_META_VALUE_MAX_CHARS } from '@image-playground/shared'
import { i18next } from '../../../i18n'
import { resolveMediaSource } from '../../../lib/cloudMedia'
import { prepareMaskTargetDataUrl } from '../../../lib/maskPreprocess'
import type { TaskParams } from '../../../types'
import type { EditRect } from '../rectEditStore'
import type { CanvasTaskSpec } from './canvasTaskRuntime'
import type { CanvasEditor } from './editor'
import { buildOutpaintInputs } from './imageRectEdit'
import { exportMaskDataUrl, type MaskStroke } from './inpaintMask'
import { rasterizeEntry } from './rasterizeSelection'

/**
 * 「这张图是怎么来的」的**配方**，写在结果元素的 meta 上随画布持久化。
 *
 * 刷新后内存运行态就空了，而输入图与遮罩位图有好几 MB，刻意不进持久化（决策 2 / 6）。
 * 所以这里存的不是产物而是**做法**：用了画布上哪几个元素、什么参数、涂了哪几笔。
 * 重出时按当前画布把输入重新造一遍——元素还在就能重出，被删了就诚实地说不行。
 *
 * 代价是语义从「逐字节重放」变成「同一份配方再做一次」：源图在这期间被改过，
 * 重出的结果会跟着变。同一次打开里仍然走内存里的原始 spec，那条路径是精确重放。
 */
export interface RegenRecipe {
  v: 1
  kind: 'generate' | 'inpaint' | 'erase' | 'outpaint' | 'cutout'
  /** 人话需求，不含发起时才注入的指令样板。 */
  prompt: string
  annotated: boolean
  params: TaskParams
  /** 输入来自画布上的哪些元素：一张图 + 压在它上面的图形标注。 */
  entries: Array<{ imageId: string; graphicIds: string[] }>
  /** 局部重绘 / 擦除的涂抹笔画（页面坐标，几 KB）。 */
  strokes?: MaskStroke[]
  /** 扩图的编辑框（元素局部显示单位）。 */
  rect?: EditRect
  /** 面板里附过一张本地上传的参考图。它没法随画布存，带着它的那次生成重出不了。 */
  hadUpload?: true
}

/** 坐标留一位小数就够画笔用了；不裁的话一条长笔画能把 meta 撑爆。 */
function trimStrokes(strokes: readonly MaskStroke[]): MaskStroke[] {
  return strokes.map((stroke) => ({
    tool: stroke.tool,
    width: Math.round(stroke.width * 10) / 10,
    points: stroke.points.map((point) => ({
      x: Math.round(point.x * 10) / 10,
      y: Math.round(point.y * 10) / 10,
    })),
  }))
}

/**
 * 序列化进 meta。超过云端项目的单值上限就**不写**——写一半的配方比没有配方更坏：
 * 重出时会拿着残缺的输入去生成，用户看不出来。
 */
export function encodeRecipe(recipe: RegenRecipe): string | undefined {
  const encoded = JSON.stringify(
    recipe.strokes ? { ...recipe, strokes: trimStrokes(recipe.strokes) } : recipe,
  )
  return encoded.length <= PROJECT_META_VALUE_MAX_CHARS ? encoded : undefined
}

export function decodeRecipe(raw: string | undefined): RegenRecipe | undefined {
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw) as RegenRecipe
    return parsed?.v === 1 && Array.isArray(parsed.entries) ? parsed : undefined
  } catch {
    return undefined
  }
}

/** 配方里点名的元素是不是都还在画布上。少一个就重出不了，别等到提交才发现。 */
export function recipeSourcesPresent(editor: CanvasEditor, recipe: RegenRecipe): boolean {
  return recipe.entries.every((entry) => editor.getElement(entry.imageId)?.type === 'image')
}

/**
 * 按配方把一次提交重新造出来。输入图当场从画布栅格化，遮罩按笔画 / 编辑框重算，
 * 所以两者的尺寸与彼此的对应关系都是现算的，不依赖任何存下来的位图。
 */
export async function rebuildSpecFromRecipe(
  editor: CanvasEditor,
  recipe: RegenRecipe,
): Promise<Omit<CanvasTaskSpec, 'target'>> {
  const gone = () => new Error(i18next.t('regenerate.sourceGone', { ns: 'canvas' }))
  const base = {
    prompt: recipe.prompt,
    annotated: recipe.annotated,
    params: recipe.params,
  }

  if (recipe.kind === 'generate') {
    const inputs: string[] = []
    for (const entry of recipe.entries) {
      const box = editor.getElementPageBounds(entry.imageId)
      if (!box) throw gone()
      const graphicIds = entry.graphicIds.filter((id) => editor.getElement(id))
      const dataUrl = await rasterizeEntry(editor, { imageId: entry.imageId, box, graphicIds })
      if (!dataUrl) throw gone()
      inputs.push(dataUrl)
    }
    return { ...base, inputImageDataUrls: inputs }
  }

  const sourceId = recipe.entries[0]?.imageId
  const element = sourceId ? editor.getElement(sourceId) : undefined
  if (element?.type !== 'image') throw gone()
  const source = await resolveMediaSource(editor.doc.files[element.fileId] ?? '', 'original')

  if (recipe.kind === 'outpaint') {
    if (!recipe.rect) throw gone()
    const natural = { width: element.naturalWidth ?? 0, height: element.naturalHeight ?? 0 }
    if (!natural.width || !natural.height) throw gone()
    const built = await buildOutpaintInputs(source, recipe.rect, element, natural)
    return {
      ...base,
      inputImageDataUrls: [built.source],
      maskDataUrl: built.mask,
      editSourceId: element.id,
      editKind: 'outpaint',
    }
  }

  // 抠图整图重画，没有遮罩也没有笔画：源图还在就能原样再做一次。
  if (recipe.kind === 'cutout') {
    return {
      ...base,
      inputImageDataUrls: [source],
      editSourceId: element.id,
      editKind: 'cutout',
    }
  }

  if (!recipe.strokes?.length) throw gone()
  const prepared = await prepareMaskTargetDataUrl(source)
  const maskDataUrl = await exportMaskDataUrl(
    element,
    { width: prepared.width, height: prepared.height },
    recipe.strokes,
  )
  return {
    ...base,
    inputImageDataUrls: [prepared.dataUrl],
    maskDataUrl,
    editSourceId: element.id,
    editKind: recipe.kind,
  }
}
