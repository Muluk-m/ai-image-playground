import { i18next } from '../../../i18n'
import type {
  GenerationReference,
  GenerationSink,
  GenerationUnit,
} from '../../../lib/generationJob'
import { removeKeyedBackgroundFromDataUrl } from '../../../lib/transparentImage'
import { addCompletedCanvasTask, type CanvasProfileSnapshot, useStore } from '../../../store'
import type { TaskParams } from '../../../types'
import type { CanvasEditor, CanvasTaskMeta, PlaceholderView } from './editor'
import type { Box } from './geometry'
import { markPlaceholderStatus, settleGeneration, targetFromShape } from './placeholderShapeOps'
import { computePlaceholderTargets, type PlacementTarget } from './placement'

/**
 * 画布这一侧的生成宿主：占位框。`generationJob` 定好发几条、带什么幂等键、什么时候通知
 * overlay；这里只管「一条任务在画布上长什么样」——建占位框、回填恢复元数据、出片落图、
 * 失败就地标错。发起、重试、刷新后续跑都走这一份，三条路的占位语义因此必然一致。
 */

/** 二次加工的种类，决定卡片与占位框上写什么。 */
export type CanvasEditKind = NonNullable<CanvasTaskMeta['editKind']>

/**
 * 一条画布任务的**不可持久化**输入：输入图与遮罩（图片任务）、首尾帧（视频任务）。
 * 它刻意不进 `shape.meta`（决策 2 / 6：数 MB 的 data URL 不该随画布持久化），
 * 所以只够「同一次打开里的重试 / 重新生成」用；刷新后这张表清空，续跑只认 `bffRequestId`。
 *
 * 图片与视频原本各存一张 Map，是同一个概念的两份实现，这里合成一张**有界 LRU**：
 * 只留最近 RETAINED_TASKS 条，读一次算一次新（反复重出同一张图时别被后面几次挤掉）。
 */
export interface CanvasTaskInputs {
  inputImageDataUrls: string[]
  maskDataUrl?: string
}

const RETAINED_TASKS = 8
const retained = new Map<string, CanvasTaskInputs>()

export function retainCanvasInputs(taskId: string, inputs: CanvasTaskInputs): void {
  retained.set(taskId, inputs)
  while (retained.size > RETAINED_TASKS) {
    const oldest = retained.keys().next()
    if (oldest.done) break
    retained.delete(oldest.value)
  }
}

export function recallCanvasInputs(taskId: string): CanvasTaskInputs | undefined {
  const inputs = retained.get(taskId)
  // 读一次就挪到队尾。
  if (inputs) {
    retained.delete(taskId)
    retained.set(taskId, inputs)
  }
  return inputs
}

export function releaseCanvasInputs(taskId: string): void {
  retained.delete(taskId)
}

/** 这一条落在哪：已知目标框（二次加工 / 重试 / 续跑），或者从锚点现算一个空位（生成栏）。 */
export type CanvasPlacement = { target: PlacementTarget } | { anchor: Box | null }

/** `generationJob` 不看、原样交回 `open` 的东西：占位框 meta 与落图位置要用的那些。 */
export interface CanvasJobContext {
  /** 人话需求（不含指令样板）：进 meta、进工作台历史，不是送给上游的那句。 */
  prompt: string
  annotated: boolean
  source: CanvasTaskMeta['source']
  /** 发起时的 profile 身份快照：生成可长达数分钟，完成时用户可能已切 profile。 */
  profileView: CanvasProfileSnapshot
  editSourceId?: string
  editKind?: CanvasEditKind
  placement: CanvasPlacement
}

/** 一条画布任务在画布上的身份。出片与标错都只认它。 */
export interface CanvasJobHandle {
  placeholderId: string
  taskId: string
  target: PlacementTarget
  /** 人话需求，落工作台历史用。 */
  prompt: string
  params: TaskParams
  profileView: CanvasProfileSnapshot
  editKind?: CanvasEditKind
  /** 发起时刻；续跑的占位框没有（跨会话算不出真实耗时），历史里就不写耗时。 */
  startedAt?: number
}

/** 刷新后续跑：占位框已经在画布上了，直接认回一条任务。 */
export function resumedCanvasJob(
  placeholder: PlaceholderView,
  params: TaskParams,
): CanvasJobHandle {
  const meta = placeholder.meta
  return {
    placeholderId: placeholder.id,
    taskId: meta.taskId,
    target: targetFromShape(placeholder),
    prompt: meta.prompt,
    params,
    profileView: meta.profileView as CanvasProfileSnapshot,
    ...(meta.editKind ? { editKind: meta.editKind } : {}),
  }
}

/**
 * 抠图的后半程：模型只负责把背景换成纯色，真正的透明是在本地键出来的。
 *
 * 键失败（拿回来的背景不够纯、或者画布读不出像素）就**留着那张原图**并说一句：
 * 这一次已经花掉了积分，把它当失败扔掉比给一张还带背景的图更坏——用户至少能看到
 * 发生了什么，再决定重不重来。与工作台那条路的口径一致（store.ts `storeGeneratedImages`）。
 */
async function keyOutBackground(images: string[]): Promise<string[]> {
  let failed = false
  const out = await Promise.all(
    images.map(async (dataUrl) => {
      try {
        return await removeKeyedBackgroundFromDataUrl(dataUrl)
      } catch {
        failed = true
        return dataUrl
      }
    }),
  )
  if (failed)
    useStore.getState().showToast(i18next.t('cutout.keyFailed', { ns: 'canvas' }), 'error')
  return out
}

export function canvasGenerationSink(
  editor: CanvasEditor,
): GenerationSink<CanvasJobHandle, CanvasJobContext> {
  return {
    /**
     * 同步建 loading 占位框 + 登记内存运行态（第一个 await 之前完成，所以占位框立即出现）。
     * 决策 2：恢复元数据（含参数 / profile 快照）存元素 customData，随画布持久化；不含输入图。
     */
    open(unit: GenerationUnit<CanvasJobContext>): CanvasJobHandle {
      const { placement, ...context } = unit.context
      const target =
        'target' in placement
          ? placement.target
          : computePlaceholderTargets(editor, placement.anchor, 1)[0]!
      const taskId = crypto.randomUUID()
      const placeholderId = editor.createPlaceholder(target, {
        taskId,
        clientRequestId: unit.clientRequestId,
        source: context.source,
        prompt: context.prompt,
        annotated: context.annotated,
        inputCount: unit.inputImageDataUrls.length,
        ...(context.editSourceId ? { editSourceId: context.editSourceId } : {}),
        ...(context.editKind ? { editKind: context.editKind } : {}),
        params: unit.params,
        profileView: context.profileView,
      })
      retainCanvasInputs(taskId, {
        inputImageDataUrls: unit.inputImageDataUrls,
        ...(unit.maskDataUrl ? { maskDataUrl: unit.maskDataUrl } : {}),
      })
      return {
        placeholderId,
        taskId,
        target,
        prompt: context.prompt,
        params: unit.params,
        profileView: context.profileView,
        ...(context.editKind ? { editKind: context.editKind } : {}),
        startedAt: Date.now(),
      }
    },

    /** 受理即回填并持久化，供刷新后 resume（决策 2 / 7）。自定义服务商那条路画布走不到。 */
    accepted(handle: CanvasJobHandle, reference: GenerationReference): void {
      if (reference.kind !== 'queue') return
      editor.updatePlaceholder(handle.placeholderId, {
        meta: { bffRequestId: reference.requestId },
      })
    },

    /** 队列阶段写回占位框：长任务只写「生成中」会让人以为卡死了。 */
    progress(handle, queuePhase) {
      editor.updatePlaceholder(handle.placeholderId, { meta: { queuePhase } })
    },

    async delivered(handle, result) {
      const images =
        handle.editKind === 'cutout' ? await keyOutBackground(result.images) : result.images
      const placed = await settleGeneration(editor, handle.placeholderId, handle.target, {
        ...result,
        images,
      })
      // 落图成功也**不释放**运行态：结果元素上的 `meta.taskId` 指着它，「重新生成」靠它原样再发。
      // 内存由上面的有界 LRU 兜住；失败态的占位框同样还留着它用于重试。
      // 落工作台历史（best-effort，addCompletedCanvasTask 内部吞错告警）。
      if (placed) {
        void addCompletedCanvasTask({
          prompt: handle.prompt,
          params: handle.params,
          images,
          ...(handle.startedAt ? { elapsed: Date.now() - handle.startedAt } : {}),
          profile: handle.profileView,
        })
      }
    },

    failed(handle, failure) {
      markPlaceholderStatus(editor, handle.placeholderId, 'error', failure.text)
    },
  }
}
