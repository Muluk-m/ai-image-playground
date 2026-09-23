import { i18next } from '../../../i18n'
import { clientProfileToApiProfile, getActiveApiProfile } from '../../../lib/apiProfiles'
import { startGeneration } from '../../../lib/generationJob'
import { useStore } from '../../../store'
import type { TaskParams } from '../../../types'
import {
  type CanvasEditKind,
  type CanvasJobContext,
  type CanvasJobHandle,
  type CanvasPlacement,
  canvasGenerationSink,
  recallCanvasInputs,
  releaseCanvasInputs,
} from './canvasGenerationSink'
import type { CanvasEditor, PlaceholderView } from './editor'
import { targetFromShape } from './placeholderShapeOps'
import type { PlacementTarget } from './placement'
import {
  analyzeSelection,
  type CanvasInputEntry,
  rasterizeEntry,
  rasterizeSelection,
} from './rasterizeSelection'
import { retryCanvasVideo } from './submitVideoFromCanvas'

/**
 * 当前全局参数的画布任务快照：`n` 折叠为 1。数量由发起层单独说（生成栏按输入框里的份数，
 * 二次加工与重试一律一份），扇出拆不拆由 `generationJob` 按渠道能力决定。
 */
export function snapshotParams(): TaskParams {
  return { ...useStore.getState().params, n: 1 }
}

/**
 * 一次画布生成任务的完整描述：人话需求 + 输入图 + 参数快照 + 放置目标。
 * 二次加工（抠图 / 扩图 / 局部重绘 / 整图改）与重试都从这个入口发起。
 */
export interface CanvasTaskSpec {
  /** 人话需求（画布文字标注 + 输入框合并）。标注指令样板在发起时才注入，不存这里。 */
  prompt: string
  /** 是否标注模式：发起时决定是否注入「按标注改、输出干净图」指令前缀。 */
  annotated: boolean
  inputImageDataUrls: string[]
  /**
   * 局部重绘的遮罩（不透明 = 保留、透明 = 可重绘），与 `inputImageDataUrls[0]` 逐像素同尺寸。
   * 与输入图一样不持久化：它只为「同会话内重试」而留在内存运行态里。
   */
  maskDataUrl?: string
  /** 二次加工的源图元素 id：处理期间那张卡片上盖遮罩，刷新后也要认得出来。 */
  editSourceId?: string
  /** 二次加工的种类，决定卡片与占位框上写什么。 */
  editKind?: CanvasEditKind
  /** 发起时的参数快照。 */
  params: TaskParams
  target: PlacementTarget
}

/**
 * 标注模式的指令前缀：把「带手绘标注的参考图」翻译成「按标注改、输出干净新图」。
 * 用户输入的具体修改要求（若有）拼在其后。
 */
const CANVAS_ANNOTATION_INSTRUCTION =
  '部分输入图带有手绘标注（圈选 / 箭头等）。' +
  '请按照标注表达的修改意图生成一张全新的、干净的图片：' +
  '不要在输出中保留任何手绘标注线条；未被标注的区域尽量与原图保持一致。'

/**
 * 发给上游的最终 prompt：标注模式注入指令前缀。**发起时才注入**——spec/meta/历史里
 * 只存人话需求（requirement），指令样板是实现细节，不进历史（否则详情弹窗被样板撑爆、
 * 「复用配置」也会把样板复制回输入框）。requirement 可为空（只画了圈没写字）。
 */
function buildApiPrompt(annotated: boolean, requirement: string): string {
  if (!annotated) return requirement
  return requirement
    ? `${CANVAS_ANNOTATION_INSTRUCTION}\n修改要求：${requirement}`
    : CANVAS_ANNOTATION_INSTRUCTION
}

/** 一批要发的东西（落在哪由 placement 说）。 */
interface CanvasBatch {
  prompt: string
  annotated: boolean
  inputImageDataUrls: string[]
  maskDataUrl?: string
  editSourceId?: string
  editKind?: CanvasEditKind
  placement: CanvasPlacement
}

/**
 * 画布发起的唯一出口：把一批变体交给生成任务 module。门禁按整批的量判一次、扇出按渠道
 * 能力拆、幂等键逐条新铸、overlay 通知与错误码映射都在 module 里；这里只说「发什么、落在哪」。
 * 返回是否受理（门禁拦下时为 false，反馈已经给过），重试据此决定要不要收掉旧占位框。
 */
function launch(editor: CanvasEditor, batches: CanvasBatch[], params: TaskParams): boolean {
  // 发起时快照 profile 身份：生成可长达数分钟，完成时用户可能已切 profile，落历史用快照保真。
  const profile = getActiveApiProfile(useStore.getState().settings)
  const view = clientProfileToApiProfile(profile)
  const profileView = {
    apiProvider: view.provider,
    apiProfileId: view.id,
    apiProfileName: view.name,
    apiModel: view.model,
  }
  const handles = startGeneration<CanvasJobHandle, CanvasJobContext>(
    {
      settings: useStore.getState().settings,
      profile,
      params,
      variants: batches.map((batch) => ({
        prompt: buildApiPrompt(batch.annotated, batch.prompt),
        inputImageDataUrls: batch.inputImageDataUrls,
        ...(batch.maskDataUrl ? { maskDataUrl: batch.maskDataUrl } : {}),
        context: {
          prompt: batch.prompt,
          annotated: batch.annotated,
          source: profile.source,
          profileView,
          ...(batch.editSourceId ? { editSourceId: batch.editSourceId } : {}),
          ...(batch.editKind ? { editKind: batch.editKind } : {}),
          placement: batch.placement,
        },
      })),
    },
    canvasGenerationSink(editor),
  )
  return handles.length > 0
}

/**
 * 起一个画布生成任务：占位框在第一个 await 之前就出现（调用方发完即可返回），随后异步跑生成。
 * 二次加工与重试共用此入口，保证占位 / 并发 / 恢复语义一致。返回是否受理。
 */
export function launchCanvasTask(editor: CanvasEditor, spec: CanvasTaskSpec): boolean {
  return launch(
    editor,
    [
      {
        prompt: spec.prompt,
        annotated: spec.annotated,
        inputImageDataUrls: spec.inputImageDataUrls,
        ...(spec.maskDataUrl ? { maskDataUrl: spec.maskDataUrl } : {}),
        ...(spec.editSourceId ? { editSourceId: spec.editSourceId } : {}),
        ...(spec.editKind ? { editKind: spec.editKind } : {}),
        placement: { target: spec.target },
      },
    ],
    spec.params,
  )
}

/**
 * 创作模式统一生成入口（决策 4）：把选区内**每张图片各自**栅格化为独立参考图，
 * 凭数量决定文生图（空数组）或多图迭代（非空）——单一调用路径。发起即返回、支持并发。
 *
 * `perImage`：选中的每张图各起一个任务（同一句提示词逐张跑），而不是把它们并成一次多图迭代。
 * 这是「把这 12 张都改成 3:4」这类批量活的入口；结果各自落在源图附近，失败也只失败那一张。
 * 全程通过占位框 + toast 反馈，不抛出。
 */
export async function submitFromCanvas(
  editor: CanvasEditor,
  userPrompt: string,
  opts: { perImage?: boolean } = {},
): Promise<void> {
  const { showToast, params } = useStore.getState()
  const plan = analyzeSelection(editor)
  // 逐张模式只有在真有两张以上时才成立，一张图逐张就是普通的一次生成。
  const perImageEntries = opts.perImage && plan && plan.entries.length > 1 ? plan.entries : null
  const trimmed = userPrompt.trim()
  // 数量走 params.n：门禁按整批判、扇出按渠道能力拆，两件事都在 module 里。
  const batchParams = { ...snapshotParams(), n: Math.max(1, params.n) }

  if (perImageEntries && plan) {
    const rasterized = await Promise.all(
      perImageEntries.map(async (entry) => ({
        entry,
        dataUrl: await rasterizeEntry(editor, entry),
      })),
    )
    const usable = rasterized.filter(
      (one): one is { entry: CanvasInputEntry; dataUrl: string } => one.dataUrl !== null,
    )
    if (usable.length === 0) {
      showToast(i18next.t('submit.rasterizeFailed', { ns: 'canvas' }), 'error')
      return
    }
    // 人话需求：画布文字标注与输入框合并（与合并模式同一条规则）。
    const prompt = plan.annotated
      ? [plan.annotationText, trimmed].filter(Boolean).join('\n')
      : trimmed
    const accepted = launch(
      editor,
      usable.map(({ entry, dataUrl }) => ({
        prompt,
        annotated: plan.annotated,
        inputImageDataUrls: [dataUrl],
        placement: { anchor: entry.box },
      })),
      batchParams,
    )
    // 少数几张栅格化不了：已发的照发，漏掉的说清楚，不假装整批都发了。
    if (accepted && usable.length < perImageEntries.length)
      showToast(i18next.t('submit.rasterizePartial', { ns: 'canvas' }), 'info')
    return
  }

  const selection = await rasterizeSelection(editor)
  // 守卫：选中了图片但栅格化全部失败 → 明确报错，绝不静默降级成文生图。
  if (!selection && plan) {
    showToast(i18next.t('submit.rasterizeFailed', { ns: 'canvas' }), 'error')
    return
  }
  const inputImageDataUrls = selection?.dataUrls ?? []
  if (!trimmed && inputImageDataUrls.length === 0) {
    showToast(i18next.t('submit.emptyInput', { ns: 'canvas' }), 'error')
    return
  }

  // 人话需求：画布文字标注与输入框合并。指令样板在发起时才注入（buildApiPrompt），不进历史。
  const prompt = selection?.annotated
    ? [selection.annotationText, trimmed].filter(Boolean).join('\n')
    : trimmed

  launch(
    editor,
    [
      {
        prompt,
        annotated: selection?.annotated ?? false,
        inputImageDataUrls,
        placement: { anchor: selection?.bounds ?? null },
      },
    ],
    batchParams,
  )
}

/**
 * 失效 / 错误态占位框的「重试」：用**同参数**重新发起一个任务，受理了才收掉旧占位框
 * （门禁拦下时旧框得留着，否则用户连重试入口都没了）。
 * 同会话内输入图仍在内存运行态里（决策 2 的投影），可完整重发；刷新后运行态已清空，
 * 由下面那条守卫拦住，不静默退化成文生图。
 */
export function retryCanvasTask(editor: CanvasEditor, placeholder: PlaceholderView): void {
  const meta = placeholder.meta
  if (meta.video) return retryCanvasVideo(editor, placeholder)
  const retained = recallCanvasInputs(meta.taskId)
  const inputImageDataUrls = retained?.inputImageDataUrls ?? []

  // 守卫：原任务带输入图但运行态已随页面关闭清空（输入图刻意不持久化，决策 2/6）——
  // 此时静默重发会退化成文生图、产出与原意无关的垃圾结果。明确报错，让用户重新选图发起。
  if ((meta.inputCount ?? 0) > 0 && inputImageDataUrls.length === 0) {
    useStore.getState().showToast(i18next.t('submit.inputsLost', { ns: 'canvas' }), 'error')
    return
  }

  const accepted = launchCanvasTask(editor, {
    prompt: meta.prompt,
    annotated: meta.annotated ?? false,
    inputImageDataUrls,
    // 局部重绘重试必须把遮罩一起带回去：丢了它就是一次静默的整图重绘，
    // 与上面那条守卫防的是同一类事故。遮罩与输入图同在运行态，刷新后一起没，也被同一条守卫拦住。
    ...(retained?.maskDataUrl ? { maskDataUrl: retained.maskDataUrl } : {}),
    ...(meta.editSourceId ? { editSourceId: meta.editSourceId } : {}),
    ...(meta.editKind ? { editKind: meta.editKind } : {}),
    // meta.params 与运行态同源（发起时一并写入），持久化的 meta 是权威。
    params: meta.params ?? snapshotParams(),
    // 几何一律读活占位框：用户可能已拖动 / 拉伸过错误态占位框，发起时的目标框已过期。
    target: targetFromShape(placeholder),
  })
  if (!accepted) return
  editor.deleteElement(placeholder.id)
  releaseCanvasInputs(meta.taskId)
}
