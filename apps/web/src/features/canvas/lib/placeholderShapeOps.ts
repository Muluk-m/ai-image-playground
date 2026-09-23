import { i18next } from '../../../i18n'
import { getImageDimensions } from '../../../lib/canvasImage'
import type { CallApiResult } from '../../../lib/imageApiShared'
import type { CanvasEditor, CanvasTaskStatus, PlacedImage, PlaceholderView } from './editor'
import { Box } from './geometry'
import { fitToTarget, PLACEMENT_GAP, type PlacementTarget } from './placement'

/** 要放的一项。`id` 与 `video` 只属于这一项，`opts.meta` 是整批共用的溯源。 */
export type PlaceItem = Pick<
  PlacedImage,
  'dataUrl' | 'id' | 'video' | 'name' | 'groupId' | 'createdAt'
>

/** 统一的错误消息提取（画布任务终局共用）。 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 从占位框自身几何取放置目标（恢复 / 重试无内存运行态时的兜底）。 */
export function targetFromShape(view: PlaceholderView): PlacementTarget {
  return { x: view.x, y: view.y, w: view.w, h: view.h }
}

/** 占位框转为错误 / 失效态（不再无限 loading）。占位框已被删则安全 no-op。 */
export function markPlaceholderStatus(
  editor: CanvasEditor,
  id: string,
  status: Exclude<CanvasTaskStatus, 'loading'>,
  message: string,
): void {
  editor.updatePlaceholder(id, { status, message })
}

/**
 * 任务终局的单一收口（submit 与 recover 共用）：空结果 → 错误态；有结果 → 收掉占位框。
 * 调用方只负责「怎么拿到 result」，终局态判定统一在这里，避免两条路径各写一份。
 * 返回是否成功落图，供调用方决定是否落工作台历史（历史写入属任务层，不在本层做）。
 *
 * **二次加工（局部重绘 / 擦除 / 扩图）就地替换源图**，不另起一张：用户改的就是这一张，
 * 旁边再多一张等于每改一次画布就多一份垃圾。判据读占位框自己的 meta（随画布持久化），
 * 所以刷新后由恢复路径收尾时行为一致。
 */
export async function settleGeneration(
  editor: CanvasEditor,
  placeholderId: string,
  target: PlacementTarget,
  result: CallApiResult,
): Promise<boolean> {
  if (result.images.length === 0) {
    markPlaceholderStatus(
      editor,
      placeholderId,
      'error',
      i18next.t('placeholder.noImages', { ns: 'canvas' }),
    )
    return false
  }
  const placeholder = editor.getPlaceholder(placeholderId)
  const sourceId = placeholder?.meta.editSourceId
  const source = sourceId ? editor.getElement(sourceId) : undefined
  if (placeholder && source?.type === 'image' && result.images[0]) {
    const dimensions = await getImageDimensions(result.images[0])
    // 几何取占位框自己的：局部重绘时它与源图重合，扩图时它就是那个扩出来的框。
    editor.doc.replaceImageBitmap(source.id, result.images[0], {
      x: placeholder.x,
      y: placeholder.y,
      width: placeholder.w,
      height: placeholder.h,
      naturalWidth: dimensions.width,
      naturalHeight: dimensions.height,
      // 溯源跟着新位图走：重出、详情都按这一份查，留着旧的会指向一张已经不存在的图。
      meta: {
        ...source.meta,
        prompt: placeholder.meta.prompt,
        taskId: placeholder.meta.taskId,
      },
    })
    editor.deleteElement(placeholderId, { history: false })
    editor.setSelectedElements([source.id])
    return true
  }
  await placeResults(editor, placeholderId, target, result.images)
  return true
}

/**
 * 把 dataUrl 列表作为新的 image 元素放到画布并选中；结果落在视口外时平滑移动镜头带到眼前
 * （在视口内则不动镜头，避免打断用户正在进行的操作）。
 * - 尺寸：按各自的目标框 contain 适配（dataUrl 保留原始分辨率），不按原始像素落图
 * - 位置：居中于目标框
 * - meta（可选）写到每个 image 元素上，承载生成溯源（prompt 等）
 * 一件产物一个目标框，两者数量必须相等；调用方决定这些框是占位框的几何还是现算的空位。
 */
export async function placeImagesIntoTargets(
  editor: CanvasEditor,
  placing: readonly PlaceItem[],
  targets: readonly PlacementTarget[],
  opts: {
    meta?: Record<string, string>
    canPlace?: () => boolean
    /** 落完选中新元素（默认）。不选时用户手上的选区不被打断。 */
    select?: boolean
  } = {},
): Promise<void> {
  const sizes = await Promise.all(placing.map((one) => getImageDimensions(one.dataUrl)))
  if (opts.canPlace && !opts.canPlace()) return

  const items: PlacedImage[] = []
  for (let i = 0; i < placing.length; i++) {
    const one = placing[i]!
    // Cloud delivery can arrive while decoding; preserve its identity and user edits.
    if (one.id && editor.getElement(one.id)) continue
    const target = targets[i]!
    const { width, height } = sizes[i]
    const fitted = fitToTarget(width, height, target)
    items.push({
      dataUrl: one.dataUrl,
      x: target.x + (target.w - fitted.w) / 2,
      y: target.y + (target.h - fitted.h) / 2,
      width: fitted.w,
      height: fitted.h,
      naturalWidth: width,
      naturalHeight: height,
      name: one.name,
      groupId: one.groupId,
      createdAt: one.createdAt,
      ...(one.id ? { id: one.id } : {}),
      ...(one.video ? { video: one.video } : {}),
    })
  }
  const ids = editor.placeImages(items, opts.meta)
  if (ids.length === 0) return
  if (opts.select !== false) editor.setSelectedElements(ids)

  // 镜头反馈：结果完全在视口外（用户平移去了别处 / 恢复场景）时把镜头带过去，
  // 否则生成完了用户根本不知道图落在哪。视口内可见则不动。
  const placed = Box.Common(items.map((it) => new Box(it.x, it.y, it.width, it.height)))
  if (!editor.getViewportPageBounds().collides(placed)) {
    editor.scrollToElements(ids)
  }
}

/**
 * 单个目标框里放一批结果：多张按框宽分格沿水平排开，彼此留 PLACEMENT_GAP 间距。
 * 「一个占位框收一条 n>1 的任务」时用它（计费内置渠道的整批预留）。
 */
export function spreadTargets(target: PlacementTarget, count: number): PlacementTarget[] {
  return Array.from({ length: count }, (_, i) => ({
    ...target,
    x: target.x + i * (target.w + PLACEMENT_GAP),
  }))
}

/** 供「占位框替换为结果」与「工作台图片送进画布」两处复用（都不依赖占位框存在）。 */
export async function placeImagesOnCanvas(
  editor: CanvasEditor,
  placing: readonly PlaceItem[],
  target: PlacementTarget,
  opts: { meta?: Record<string, string>; canPlace?: () => boolean } = {},
): Promise<void> {
  await placeImagesIntoTargets(editor, placing, spreadTargets(target, placing.length), opts)
}

/**
 * 把生成结果放到画布并**删除**占位框：占位框还在就放在它的位置（选区右侧、垂直居中），
 * 已被用户删除则按 target 兜底放置，不抛错（决策 7 末行 / spec 占位框缺失）。
 * 结果元素的 meta 记录生成溯源（prompt），画布上事后可查这张图是怎么来的。
 */
async function placeResults(
  editor: CanvasEditor,
  placeholderId: string,
  target: PlacementTarget,
  dataUrls: string[],
): Promise<void> {
  const placeholder = editor.getPlaceholder(placeholderId)
  const anchor = placeholder ? targetFromShape(placeholder) : target
  const provenance = placeholder
    ? {
        prompt: placeholder.meta.prompt,
        taskId: placeholder.meta.taskId,
      }
    : undefined
  // 放置成功后才删占位框：中途失败（如图片解码）时它得留着，错误态才有处可标
  await placeImagesOnCanvas(
    editor,
    dataUrls.map((dataUrl) => ({ dataUrl })),
    anchor,
    { meta: provenance },
  )
  if (placeholder) editor.deleteElement(placeholderId)
}
