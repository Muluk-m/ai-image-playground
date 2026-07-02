import type { Editor } from 'tldraw'
import { resumeQueueImageApi } from '../../../lib/api'
import { addCompletedCanvasTask, useStore } from '../../../store'
import type { GenerationPlaceholderShape } from '../shapes/GenerationPlaceholderShapeUtil'
import { snapshotParams } from './canvasTaskRuntime'
import {
  errorMessage,
  markPlaceholderStatus,
  readTaskMeta,
  settleGeneration,
  targetFromShape,
} from './placeholderShapeOps'

/** builtin-edge 且有 bffRequestId：用它续 poll（不重传输入图），完成替换占位框。 */
async function resumeOne(
  editor: Editor,
  shape: GenerationPlaceholderShape,
  bffRequestId: string,
): Promise<void> {
  const meta = readTaskMeta(shape)
  // 参数优先用发起时的快照（随 meta 持久化），跨会话恢复保真；旧占位框无快照则当前参数兜底。
  const params = meta.params ?? snapshotParams()
  try {
    const result = await resumeQueueImageApi(
      {
        settings: useStore.getState().settings,
        prompt: meta.prompt,
        params,
        // 恢复不重传输入图（决策 2 的关键支撑）。
        inputImageDataUrls: [],
      },
      bffRequestId,
    )
    const placed = await settleGeneration(editor, shape.id, targetFromShape(shape), result)
    // 恢复完成的生成同样落工作台历史（best-effort，内部吞错告警）；profile 用发起时快照保真。
    if (placed) {
      void addCompletedCanvasTask({
        prompt: meta.prompt,
        params,
        images: result.images,
        profile: meta.profileView,
      })
    }
  } catch (err) {
    markPlaceholderStatus(editor, shape.id, 'error', errorMessage(err))
  }
}

/**
 * 画布挂载时扫描所有**运行态**占位框，按决策 7 收敛，杜绝僵尸 loading：
 * | builtin-edge + bffRequestId       | resume 续 poll，完成替换      |
 * | builtin-edge 仅 clientRequestId   | 标记「未确认，请手动重试」     |
 * | user-byok（无恢复能力）           | 标记失效 + 重试入口            |
 * 每个 loading 占位框要么被恢复继续，要么被转入 error/stale，绝不停在无对应任务的 loading。
 */
export function recoverCanvasTasks(editor: Editor): void {
  const placeholders = editor
    .getCurrentPageShapes()
    .filter((s): s is GenerationPlaceholderShape => s.type === 'generation-placeholder')

  for (const shape of placeholders) {
    if (shape.props.status !== 'loading') continue
    const meta = readTaskMeta(shape)

    if (meta.source === 'builtin-edge' && meta.bffRequestId) {
      void resumeOne(editor, shape, meta.bffRequestId)
    } else if (meta.source === 'builtin-edge') {
      // submit 未确认窗口：不自动重提交（决策 6），标记需手动重试。
      markPlaceholderStatus(editor, shape.id, 'stale', '任务未确认，请手动重试')
    } else {
      // BYOK 不经 BFF、无跨会话恢复能力：诚实标失效并给重试，而非僵尸转圈。
      markPlaceholderStatus(editor, shape.id, 'stale', 'BYOK 任务无法跨会话恢复，请重试')
    }
  }
}
