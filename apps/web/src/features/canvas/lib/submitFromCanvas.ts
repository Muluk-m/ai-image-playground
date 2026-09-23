import { requireAccount } from '../../../auth/loginPrompt'
import { i18next } from '../../../i18n'
import { callImageApi } from '../../../lib/api'
import { clientProfileToApiProfile, getActiveApiProfile } from '../../../lib/apiProfiles'
import { isClientCapabilityEnabled } from '../../../lib/clientCapabilities'
import {
  getPrivateSubmissionGuard,
  notifyPrivateSubmissionAccepted,
  notifyPrivateSubmissionError,
  notifyPrivateSubmissionSettled,
} from '../../../lib/privateOverlay'
import { taskErrorTypeOf } from '../../../lib/taskError'
import { addCompletedCanvasTask, useStore } from '../../../store'
import {
  type CanvasTaskSpec,
  getCanvasTask,
  registerCanvasTask,
  removeCanvasTask,
  snapshotParams,
} from './canvasTaskRuntime'
import type { CanvasEditor, PlaceholderView } from './editor'
import type { Box } from './geometry'
import {
  errorMessage,
  markPlaceholderStatus,
  settleGeneration,
  targetFromShape,
} from './placeholderShapeOps'
import { computePlaceholderTargets } from './placement'
import {
  analyzeSelection,
  type CanvasInputEntry,
  rasterizeEntry,
  rasterizeSelection,
} from './rasterizeSelection'
import { encodeRecipe, type RegenRecipe } from './regenRecipe'
import { retryCanvasVideo } from './submitVideoFromCanvas'

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
export async function launchCanvasTask(editor: CanvasEditor, spec: CanvasTaskSpec): Promise<void> {
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
  // 配方超长（涂了几百笔）就不写：半份配方会让重出拿着残缺的输入去生成，用户看不出来。
  const recipe = spec.recipe ? encodeRecipe(spec.recipe) : undefined
  const placeholderId = editor.createPlaceholder(spec.target, {
    taskId,
    clientRequestId,
    source: profile.source,
    prompt: spec.prompt,
    annotated: spec.annotated,
    inputCount: spec.inputImageDataUrls.length,
    ...(spec.editSourceId ? { editSourceId: spec.editSourceId } : {}),
    ...(spec.editKind ? { editKind: spec.editKind } : {}),
    ...(recipe ? { regen: recipe } : {}),
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
      ...(spec.maskDataUrl ? { maskDataUrl: spec.maskDataUrl } : {}),
      clientRequestId,
      // submit 成功即回填 bffRequestId 到占位框 meta 并持久化，供刷新后 resume（决策 2 / 7）。
      onQueueSubmitted: (requestId) => {
        editor.updatePlaceholder(placeholderId, { meta: { bffRequestId: requestId } })
        notifyPrivateSubmissionAccepted()
      },
      // 队列阶段写回占位框：长任务只写「生成中」会让人以为卡死了。
      onQueueStatus: (queuePhase) =>
        editor.updatePlaceholder(placeholderId, { meta: { queuePhase } }),
    })
    const placed = await settleGeneration(editor, placeholderId, spec.target, result)
    // 落图成功也**不释放**运行态：结果元素上的 `meta.taskId` 指着它，「重新生成」靠它原样再发。
    // 内存由 canvasTaskRuntime 的有界 LRU 兜住；失败态的占位框同样还留着它用于重试。
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
    notifyPrivateSubmissionError(err)
    // 内容安全拒绝：占位框上写可行动的那句，不糊上游英文原文（ADR 0006）。
    markPlaceholderStatus(
      editor,
      placeholderId,
      'error',
      taskErrorTypeOf(err) === 'content_policy'
        ? i18next.t('detail.contentPolicy', { ns: 'task' })
        : errorMessage(err),
    )
  } finally {
    notifyPrivateSubmissionSettled()
  }
}

/** 一批任务要发的东西（目标位置由 launchBatch 现算）。 */
type BatchSpec = Omit<CanvasTaskSpec, 'target'>

/**
 * 发起一批：计费内置渠道把 n>1 合成一个 BFF 任务，让积分预留覆盖整批；其余按张 fan-out。
 * 目标位置在每次发起前现算——占位框是同步建的，后一张自然避开前一张。
 */
function launchBatch(
  editor: CanvasEditor,
  spec: BatchSpec,
  anchor: Box | null,
  quantity: number,
  billed: boolean,
): void {
  if (billed && quantity > 1) {
    const [target] = computePlaceholderTargets(editor, anchor, 1)
    const params = { ...spec.params, n: quantity }
    void launchCanvasTask(editor, {
      ...spec,
      params,
      // 配方里的参数必须跟着这一批实际发的走，否则重出会变成另一个张数。
      ...(spec.recipe ? { recipe: { ...spec.recipe, params } } : {}),
      target: target!,
    })
    return
  }
  for (const target of computePlaceholderTargets(editor, anchor, quantity))
    void launchCanvasTask(editor, { ...spec, target })
}

/**
 * 创作模式统一生成入口（决策 4）：把选区内**每张图片各自**栅格化为独立参考图，
 * 凭数量决定文生图（空数组）或多图迭代（非空）——单一调用路径。发起即返回、支持并发。
 * BYOK 按图片 fan-out；计费内置渠道把完整数量作为一个 BFF 任务提交，确保服务端原子预留。
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
  const profile = getActiveApiProfile(useStore.getState().settings)
  const quantity = Math.max(1, params.n)
  const plan = analyzeSelection(editor)
  // 逐张模式只有在真有两张以上时才成立，一张图逐张就是普通的一次生成。
  const perImageEntries = opts.perImage && plan && plan.entries.length > 1 ? plan.entries : null
  const batches = perImageEntries?.length ?? 1
  // 内置渠道要经 BFF 的队列：没账号就只弹登录框，不建占位框也不 toast。
  if (profile.source === 'builtin-edge' && !requireAccount()) return
  const submissionGuard = getPrivateSubmissionGuard({
    model: clientProfileToApiProfile(profile).model,
    // 逐张模式一次要跑 张数 × n 张图，门禁要按整批的量判，否则积分不够时先发一半再报错。
    quantity: quantity * batches,
  })
  if (submissionGuard.blocked) {
    showToast(
      submissionGuard.disabledReason ?? i18next.t('submit.blocked', { ns: 'canvas' }),
      'error',
    )
    return
  }
  const trimmed = userPrompt.trim()
  const billed = profile.source === 'builtin-edge' && isClientCapabilityEnabled('billing:credits')
  const specParams = snapshotParams()

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
    for (const { entry, dataUrl } of usable)
      launchBatch(
        editor,
        {
          prompt,
          annotated: plan.annotated,
          inputImageDataUrls: [dataUrl],
          params: specParams,
          // 逐张模式每张各有自己的配方：重出时只重新栅格化它那一张源图。
          recipe: {
            v: 1,
            kind: 'generate',
            prompt,
            annotated: plan.annotated,
            params: specParams,
            entries: [{ imageId: entry.imageId, graphicIds: entry.graphicIds }],
          },
        },
        entry.box,
        quantity,
        billed,
      )
    // 少数几张栅格化不了：已发的照发，漏掉的说清楚，不假装整批都发了。
    if (usable.length < perImageEntries.length)
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

  // 重出配方：存「用了画布上哪几个元素」，不存那几 MB 位图。刷新后按当前画布重新栅格化。
  const recipe: RegenRecipe = {
    v: 1,
    kind: 'generate',
    prompt,
    annotated: selection?.annotated ?? false,
    params: specParams,
    entries: (selection?.entries ?? []).map((entry) => ({
      imageId: entry.imageId,
      graphicIds: entry.graphicIds,
    })),
  }
  launchBatch(
    editor,
    {
      recipe,
      prompt,
      annotated: selection?.annotated ?? false,
      inputImageDataUrls,
      params: specParams,
    },
    selection?.bounds ?? null,
    quantity,
    billed,
  )
}

/**
 * 失效 / 错误态占位框的「重试」：删旧占位框，用**同参数**重新发起一个任务。
 * 同会话内输入图仍在内存运行态里（决策 2 的投影），可完整重发；
 * 刷新后运行态已清空 → 以空输入图（文生图）+ meta 参数快照尽力重发，诚实反映能力边界。
 */
export function retryCanvasTask(editor: CanvasEditor, placeholder: PlaceholderView): void {
  const meta = placeholder.meta
  if (meta.video) return retryCanvasVideo(editor, placeholder)
  const activeProfile = getActiveApiProfile(useStore.getState().settings)
  const retryQuantity = Math.max(1, meta.params?.n ?? 1)
  // 重试同样要经队列，门槛与首次提交一致。
  if (activeProfile.source === 'builtin-edge' && !requireAccount()) return
  const submissionGuard = getPrivateSubmissionGuard({
    model: clientProfileToApiProfile(activeProfile).model,
    quantity: retryQuantity,
  })
  if (submissionGuard.blocked) {
    useStore
      .getState()
      .showToast(
        submissionGuard.disabledReason ?? i18next.t('submit.blocked', { ns: 'canvas' }),
        'error',
      )
    return
  }
  const runtime = getCanvasTask(meta.taskId)
  const inputImageDataUrls = runtime?.inputImageDataUrls ?? []

  // 守卫：原任务带输入图但运行态已随页面关闭清空（输入图刻意不持久化，决策 2/6）——
  // 此时静默重发会退化成文生图、产出与原意无关的垃圾结果。明确报错，让用户重新选图发起。
  if ((meta.inputCount ?? 0) > 0 && inputImageDataUrls.length === 0) {
    useStore.getState().showToast(i18next.t('submit.inputsLost', { ns: 'canvas' }), 'error')
    return
  }

  editor.deleteElement(placeholder.id)
  removeCanvasTask(meta.taskId)
  void launchCanvasTask(editor, {
    prompt: meta.prompt,
    annotated: meta.annotated ?? false,
    inputImageDataUrls,
    // 局部重绘重试必须把遮罩一起带回去：丢了它就是一次静默的整图重绘，
    // 与 :228 那条守卫防的是同一类事故。遮罩与输入图同在运行态，刷新后一起没，也被同一条守卫拦住。
    ...(runtime?.maskDataUrl ? { maskDataUrl: runtime.maskDataUrl } : {}),
    ...(meta.editSourceId ? { editSourceId: meta.editSourceId } : {}),
    ...(meta.editKind ? { editKind: meta.editKind } : {}),
    // meta.params 与 runtime spec 同源（launch 时一并写入），持久化的 meta 是权威。
    params: meta.params ?? snapshotParams(),
    // 几何一律读活占位框：用户可能已拖动 / 拉伸过错误态占位框，submit 时的 runtime.target 已过期。
    target: targetFromShape(placeholder),
  })
}
