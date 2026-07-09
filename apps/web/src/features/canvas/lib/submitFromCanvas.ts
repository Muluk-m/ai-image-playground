import { callImageApi } from '../../../lib/api'
import { clientProfileToApiProfile, getActiveApiProfile } from '../../../lib/apiProfiles'
import { addCompletedCanvasTask, useStore } from '../../../store'
import {
  type CanvasTaskSpec,
  getCanvasTask,
  registerCanvasTask,
  removeCanvasTask,
  snapshotParams,
} from './canvasTaskRuntime'
import type { CanvasEditor, PlaceholderView } from './editor'
import {
  errorMessage,
  markPlaceholderStatus,
  settleGeneration,
  targetFromShape,
} from './placeholderShapeOps'
import { computePlaceholderTarget, fanOutTargets } from './placement'
import { analyzeSelection, rasterizeSelection } from './rasterizeSelection'

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

/**
 * 起一个画布生成任务：**同步**建 loading 占位框 + 登记内存运行态（第一个 await 之前完成，
 * 所以占位框立即出现、调用方 `void` 一下即返回），随后异步跑生成。submit / retry 共用此入口，
 * 保证占位 / 并发 / 恢复语义一致。底层复用 `callImageApi`（不改协议），全程不抛。
 * 成功后把结果落进工作台历史（addCompletedCanvasTask），画布生成同样可收藏 / 检索 / 复用。
 */
async function launchCanvasTask(editor: CanvasEditor, spec: CanvasTaskSpec): Promise<void> {
  // 发起时快照 profile 身份：生成可长达数分钟，完成时用户可能已切 profile，
  // 落历史用快照保真（与 params 快照同一决策）。
  const profile = getActiveApiProfile(useStore.getState().settings)
  const view = clientProfileToApiProfile(profile)
  const profileView = {
    apiProvider: view.provider,
    apiProfileId: view.id,
    apiProfileName: view.name,
    apiModel: view.model,
  }
  const taskId = crypto.randomUUID()
  const clientRequestId = crypto.randomUUID()
  const startedAt = Date.now()

  // 决策 2：恢复元数据（含参数 / profile 快照）存元素 customData，随画布持久化；不含输入图。
  const placeholderId = editor.createPlaceholder(spec.target, {
    taskId,
    clientRequestId,
    source: profile.source,
    prompt: spec.prompt,
    annotated: spec.annotated,
    inputCount: spec.inputImageDataUrls.length,
    params: spec.params,
    profileView,
  })
  registerCanvasTask(taskId, spec)

  try {
    const result = await callImageApi({
      settings: useStore.getState().settings,
      prompt: buildApiPrompt(spec.annotated, spec.prompt),
      params: spec.params,
      inputImageDataUrls: spec.inputImageDataUrls,
      clientRequestId,
      // submit 成功即回填 bffRequestId 到占位框 meta 并持久化，供刷新后 resume（决策 2 / 7）。
      onQueueSubmitted: (requestId) => {
        editor.updatePlaceholder(placeholderId, { meta: { bffRequestId: requestId } })
      },
    })
    const placed = await settleGeneration(editor, placeholderId, spec.target, result)
    // 落工作台历史（best-effort，addCompletedCanvasTask 内部吞错告警）。
    if (placed) {
      void addCompletedCanvasTask({
        prompt: spec.prompt,
        params: spec.params,
        images: result.images,
        elapsed: Date.now() - startedAt,
        profile: profileView,
      })
    }
  } catch (err) {
    markPlaceholderStatus(editor, placeholderId, 'error', errorMessage(err))
  } finally {
    removeCanvasTask(taskId)
  }
}

/**
 * 创作模式统一生成入口（决策 4）：把选区内**每张图片各自**栅格化为独立参考图，
 * 凭数量决定文生图（空数组）或多图迭代（非空）——单一调用路径。发起即返回、支持并发。
 * params.n > 1 时 fan-out 成 n 个独立任务（与工作台一致），占位框水平排开各自出图。
 * 全程通过占位框 + toast 反馈，不抛出。
 */
export async function submitFromCanvas(editor: CanvasEditor, userPrompt: string): Promise<void> {
  const { showToast, params } = useStore.getState()
  const trimmed = userPrompt.trim()

  const selection = await rasterizeSelection(editor)
  // 守卫：选中了图片但栅格化全部失败 → 明确报错，绝不静默降级成文生图。
  if (!selection && analyzeSelection(editor)) {
    showToast('选中图片处理失败，请重试', 'error')
    return
  }
  const inputImageDataUrls = selection?.dataUrls ?? []
  if (!trimmed && inputImageDataUrls.length === 0) {
    showToast('请输入提示词，或先在画布上选中图片', 'error')
    return
  }

  // 人话需求：画布文字标注与输入框合并。指令样板在发起时才注入（buildApiPrompt），不进历史。
  const prompt = selection?.annotated
    ? [selection.annotationText, trimmed].filter(Boolean).join('\n')
    : trimmed

  // 参数快照：n 折叠为 1（上游不支持 n，前端 fan-out 拆任务，与工作台一致）。
  const specParams = snapshotParams()
  const base = computePlaceholderTarget(editor, selection?.bounds ?? null)
  for (const target of fanOutTargets(base, params.n)) {
    void launchCanvasTask(editor, {
      prompt,
      annotated: selection?.annotated ?? false,
      inputImageDataUrls,
      params: specParams,
      target,
    })
  }
}

/**
 * 失效 / 错误态占位框的「重试」：删旧占位框，用**同参数**重新发起一个任务。
 * 同会话内输入图仍在内存运行态里（决策 2 的投影），可完整重发；
 * 刷新后运行态已清空 → 以空输入图（文生图）+ meta 参数快照尽力重发，诚实反映能力边界。
 */
export function retryCanvasTask(editor: CanvasEditor, placeholder: PlaceholderView): void {
  const meta = placeholder.meta
  const runtime = getCanvasTask(meta.taskId)
  const inputImageDataUrls = runtime?.inputImageDataUrls ?? []

  // 守卫：原任务带输入图但运行态已随页面关闭清空（输入图刻意不持久化，决策 2/6）——
  // 此时静默重发会退化成文生图、产出与原意无关的垃圾结果。明确报错，让用户重新选图发起。
  if ((meta.inputCount ?? 0) > 0 && inputImageDataUrls.length === 0) {
    useStore
      .getState()
      .showToast('原任务的输入图已随页面关闭丢失，请重新选中图片后发起生成', 'error')
    return
  }

  editor.deleteElement(placeholder.id)
  removeCanvasTask(meta.taskId)
  void launchCanvasTask(editor, {
    prompt: meta.prompt,
    annotated: meta.annotated ?? false,
    inputImageDataUrls,
    // meta.params 与 runtime spec 同源（launch 时一并写入），持久化的 meta 是权威。
    params: meta.params ?? snapshotParams(),
    // 几何一律读活占位框：用户可能已拖动 / 拉伸过错误态占位框，submit 时的 runtime.target 已过期。
    target: targetFromShape(placeholder),
  })
}
