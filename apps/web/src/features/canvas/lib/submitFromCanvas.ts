import { createShapeId, type Editor } from 'tldraw'
import { callImageApi } from '../../../lib/api'
import { clientProfileToApiProfile, getActiveApiProfile } from '../../../lib/apiProfiles'
import { addCompletedCanvasTask, useStore } from '../../../store'
import type { GenerationPlaceholderShape } from '../shapes/GenerationPlaceholderShapeUtil'
import {
  type CanvasTaskSpec,
  getCanvasTask,
  registerCanvasTask,
  removeCanvasTask,
  snapshotParams,
} from './canvasTaskRuntime'
import {
  errorMessage,
  markPlaceholderStatus,
  patchTaskMeta,
  readTaskMeta,
  settleGeneration,
  targetFromShape,
  toShapeMeta,
} from './placeholderShapeOps'
import { computePlaceholderTarget, fanOutTargets } from './placement'
import { rasterizeSelection } from './rasterizeSelection'

/**
 * 标注模式的指令前缀：把「带手绘标注的参考图」翻译成「按标注改、输出干净新图」。
 * 用户输入的具体修改要求（若有）拼在其后。
 */
const CANVAS_ANNOTATION_INSTRUCTION =
  '输入图是一张带有手绘标注（圈选 / 箭头等）的参考图。' +
  '请按照标注表达的修改意图生成一张全新的、干净的图片：' +
  '不要在输出中保留任何手绘标注线条；未被标注的区域尽量与原图保持一致。'

/**
 * 标注模式 prompt：指令前缀 + 修改要求（画布文字标注 annotationText 与输入框 userPrompt 合并）。
 * 两者都可能为空（只画了圈没写字）——此时仅用指令前缀，让模型按图形标注推断意图。
 */
function buildAnnotatedPrompt(annotationText: string, userPrompt: string): string {
  const requirement = [annotationText, userPrompt].filter(Boolean).join('\n')
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
async function launchCanvasTask(editor: Editor, spec: CanvasTaskSpec): Promise<void> {
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
  const placeholderId = createShapeId()
  const startedAt = Date.now()

  editor.createShape<GenerationPlaceholderShape>({
    id: placeholderId,
    type: 'generation-placeholder',
    x: spec.target.x,
    y: spec.target.y,
    props: { w: spec.target.w, h: spec.target.h, status: 'loading', message: '' },
    // 决策 2：恢复元数据（含参数 / profile 快照）存 shape.meta，随画布持久化；不含输入图。
    meta: toShapeMeta({
      taskId,
      clientRequestId,
      source: profile.source,
      prompt: spec.prompt,
      params: spec.params,
      profileView,
    }),
  })
  registerCanvasTask(taskId, spec)

  try {
    const result = await callImageApi({
      settings: useStore.getState().settings,
      prompt: spec.prompt,
      params: spec.params,
      inputImageDataUrls: spec.inputImageDataUrls,
      clientRequestId,
      // submit 成功即回填 bffRequestId 到占位框 meta 并持久化，供刷新后 resume（决策 2 / 7）。
      onQueueSubmitted: (requestId) => {
        patchTaskMeta(editor, placeholderId, { bffRequestId: requestId })
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
export async function submitFromCanvas(editor: Editor, userPrompt: string): Promise<void> {
  const { showToast, params } = useStore.getState()
  const trimmed = userPrompt.trim()

  const selection = await rasterizeSelection(editor)
  const inputImageDataUrls = selection?.dataUrls ?? []
  if (!trimmed && inputImageDataUrls.length === 0) {
    showToast('请输入提示词，或先在画布上选中图片', 'error')
    return
  }

  // 标注模式：注入「按标注改、输出干净图」指令 + 合并画布文字标注与输入框的修改要求。
  const prompt = selection?.annotated
    ? buildAnnotatedPrompt(selection.annotationText, trimmed)
    : trimmed

  // 参数快照：n 折叠为 1（上游不支持 n，前端 fan-out 拆任务，与工作台一致）。
  const specParams = snapshotParams()
  const base = computePlaceholderTarget(editor, selection?.bounds ?? null)
  for (const target of fanOutTargets(base, params.n)) {
    void launchCanvasTask(editor, { prompt, inputImageDataUrls, params: specParams, target })
  }
}

/**
 * 失效 / 错误态占位框的「重试」：删旧占位框，用**同参数**重新发起一个任务。
 * 同会话内输入图仍在内存运行态里（决策 2 的投影），可完整重发；
 * 刷新后运行态已清空 → 以空输入图（文生图）+ meta 参数快照尽力重发，诚实反映能力边界。
 */
export function retryCanvasTask(editor: Editor, shape: GenerationPlaceholderShape): void {
  const meta = readTaskMeta(shape)
  const runtime = getCanvasTask(meta.taskId)
  editor.deleteShape(shape.id)
  removeCanvasTask(meta.taskId)
  void launchCanvasTask(editor, {
    prompt: meta.prompt,
    inputImageDataUrls: runtime?.inputImageDataUrls ?? [],
    // meta.params 与 runtime spec 同源（launch 时一并写入），持久化的 meta 是权威。
    params: meta.params ?? snapshotParams(),
    target: runtime?.target ?? targetFromShape(shape),
  })
}
