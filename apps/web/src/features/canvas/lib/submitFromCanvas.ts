import { createShapeId, type Editor } from 'tldraw'
import { callImageApi } from '../../../lib/api'
import { getActiveApiProfile } from '../../../lib/apiProfiles'
import { useStore } from '../../../store'
import type { GenerationPlaceholderShape } from '../shapes/GenerationPlaceholderShapeUtil'
import {
  type CanvasTaskSpec,
  getCanvasTask,
  registerCanvasTask,
  removeCanvasTask,
} from './canvasTaskRuntime'
import {
  errorMessage,
  markPlaceholderStatus,
  patchTaskMeta,
  readTaskMeta,
  settleGeneration,
  targetFromShape,
} from './placeholderShapeOps'
import { computePlaceholderTarget } from './placement'
import { rasterizeSelection } from './rasterizeSelection'

/**
 * 起一个画布生成任务：**同步**建 loading 占位框 + 登记内存运行态（第一个 await 之前完成，
 * 所以占位框立即出现、调用方 `void` 一下即返回），随后异步跑生成。submit / retry 共用此入口，
 * 保证占位 / 并发 / 恢复语义一致。底层复用 `callImageApi`（不改协议），全程不抛。
 */
async function launchCanvasTask(editor: Editor, spec: CanvasTaskSpec): Promise<void> {
  const source = getActiveApiProfile(useStore.getState().settings).source
  const taskId = crypto.randomUUID()
  const clientRequestId = crypto.randomUUID()
  const placeholderId = createShapeId()

  editor.createShape<GenerationPlaceholderShape>({
    id: placeholderId,
    type: 'generation-placeholder',
    x: spec.target.x,
    y: spec.target.y,
    props: { w: spec.target.w, h: spec.target.h, status: 'loading', message: '' },
    // 决策 2：恢复元数据存 shape.meta，随画布持久化；不含输入图。
    meta: { taskId, clientRequestId, source, prompt: spec.prompt },
  })
  registerCanvasTask(taskId, spec)

  try {
    const result = await callImageApi({
      settings: useStore.getState().settings,
      prompt: spec.prompt,
      // n 由上游拆分语义决定：queue 路径按 n=1 单张下发（与工作台 fan-out 一致）。
      params: { ...useStore.getState().params, n: 1 },
      inputImageDataUrls: spec.inputImageDataUrls,
      clientRequestId,
      // submit 成功即回填 bffRequestId 到占位框 meta 并持久化，供刷新后 resume（决策 2 / 7）。
      onQueueSubmitted: (requestId) => {
        patchTaskMeta(editor, placeholderId, { bffRequestId: requestId })
      },
    })
    await settleGeneration(editor, placeholderId, spec.target, result)
  } catch (err) {
    markPlaceholderStatus(editor, placeholderId, 'error', errorMessage(err))
  } finally {
    removeCanvasTask(taskId)
  }
}

/**
 * 创作模式统一生成入口（决策 4）：把选区内**每张图片各自**栅格化为独立参考图，
 * 凭数量决定文生图（空数组）或多图迭代（非空）——单一调用路径。发起即返回、支持并发。
 * 全程通过占位框 + toast 反馈，不抛出。
 */
export async function submitFromCanvas(editor: Editor, userPrompt: string): Promise<void> {
  const { showToast } = useStore.getState()
  const trimmed = userPrompt.trim()

  const selection = await rasterizeSelection(editor)
  const inputImageDataUrls = selection?.dataUrls ?? []
  if (!trimmed && inputImageDataUrls.length === 0) {
    showToast('请输入提示词，或先在画布上选中图片', 'error')
    return
  }

  const target = computePlaceholderTarget(editor, selection?.bounds ?? null)
  void launchCanvasTask(editor, { prompt: trimmed, inputImageDataUrls, target })
}

/**
 * 失效 / 错误态占位框的「重试」：删旧占位框，用**同参数**重新发起一个任务。
 * 同会话内输入图仍在内存运行态里（决策 2 的投影），可完整重发；
 * 刷新后运行态已清空 → 以空输入图（文生图）尽力重发，诚实反映能力边界。
 */
export function retryCanvasTask(editor: Editor, shape: GenerationPlaceholderShape): void {
  const meta = readTaskMeta(shape)
  const runtime = getCanvasTask(meta.taskId)
  editor.deleteShape(shape.id)
  removeCanvasTask(meta.taskId)
  void launchCanvasTask(editor, {
    prompt: meta.prompt,
    inputImageDataUrls: runtime?.inputImageDataUrls ?? [],
    target: runtime?.target ?? targetFromShape(shape),
  })
}
