import { i18next } from '../../../i18n'
import { resumeGeneration } from '../../../lib/generationJob'
import { useStore } from '../../../store'
import { canvasGenerationSink, resumedCanvasJob } from './canvasGenerationSink'
import type { CanvasEditor } from './editor'
import { markPlaceholderStatus } from './placeholderShapeOps'
import { snapshotParams } from './submitFromCanvas'
import { resumeCanvasVideo } from './submitVideoFromCanvas'

/**
 * 画布挂载时扫描所有**运行态**占位框，按决策 7 收敛，杜绝僵尸 loading：
 * | 智能体占的位                      | 直接删掉，没有可续的画布任务    |
 * | builtin-edge + bffRequestId       | resume 续 poll，完成替换      |
 * | builtin-edge 仅 clientRequestId   | 标记「未确认，请手动重试」     |
 * | user-byok（无恢复能力）           | 标记失效 + 重试入口            |
 * 每个 loading 占位框要么被恢复继续，要么被转入 error/stale，绝不停在无对应任务的 loading。
 *
 * 续跑走的是与首次提交同一份生命周期（`resumeGeneration`），所以余额刷新、错误码映射、
 * 出片落图在两条路上必然一致——这三件事原先在这里各漏了一份。
 */
export function recoverCanvasTasks(editor: CanvasEditor): void {
  const sink = canvasGenerationSink(editor)
  for (const placeholder of editor.getPlaceholders()) {
    if (placeholder.status !== 'loading') continue
    const meta = placeholder.meta
    if (meta.cloudGeneration) continue

    if (meta.agent) {
      // 智能体的占位框只是那一轮的脚手架：这里没有 BFF 请求可续、画布上也没法重试，
      // 产物由智能体面板那条交付链路补送。留着它就是个永远转圈的空框。
      editor.deleteElement(placeholder.id, { history: false })
    } else if (meta.video && meta.bffRequestId) {
      void resumeCanvasVideo(editor, placeholder, meta.bffRequestId)
    } else if (meta.source === 'builtin-edge' && meta.bffRequestId) {
      // 参数优先用发起时的快照（随 meta 持久化），跨会话恢复保真；旧占位框无快照则当前参数兜底。
      const params = meta.params ?? snapshotParams()
      void resumeGeneration(
        {
          settings: useStore.getState().settings,
          prompt: meta.prompt,
          params,
          requestId: meta.bffRequestId,
        },
        resumedCanvasJob(placeholder, params),
        sink,
      )
    } else if (meta.source === 'builtin-edge') {
      // submit 未确认窗口：不自动重提交（决策 6），标记需手动重试。
      markPlaceholderStatus(
        editor,
        placeholder.id,
        'stale',
        i18next.t('placeholder.unconfirmed', { ns: 'canvas' }),
      )
    } else {
      // BYOK 不经 BFF、无跨会话恢复能力：诚实标失效并给重试，而非僵尸转圈。
      markPlaceholderStatus(
        editor,
        placeholder.id,
        'stale',
        i18next.t('placeholder.byokUnrecoverable', { ns: 'canvas' }),
      )
    }
  }
}
