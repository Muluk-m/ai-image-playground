import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import { productionClipVideo } from '@image-playground/shared'
import { submitAgentGeneration } from '../../../../lib/agent/auto-submit'
import { saveGenerationDraft } from '../../../../lib/agent/confirmations'
import { resolveAgentModel } from '../../../../lib/agent/model-resolution'
import { bindProductionGeneration } from '../../../../lib/agent/production-generation-binding'
import {
  AGENT_IMAGE_FALLBACK_MODEL,
  type AgentToolContext,
  type AgentToolDetails,
  AgentToolError,
  agentModelImageCount,
  confirmedSubmissionText,
  type MaskedSubmission,
  noModelMessage,
  QUEUE_MEDIA_WORDS,
  type QueueMediaWords,
  type QueueTarget,
  type QueueTaskInput,
  queueArtifacts,
  queueParamsFor,
  requestedImageCount,
  withAspectRatio,
} from '../../contracts'

export {
  AGENT_IMAGE_FALLBACK_MODEL,
  confirmedSubmissionText,
  noModelMessage,
  type QueueTarget,
  type QueueTaskInput,
  queueArtifacts,
  resolveAgentModel,
}

/**
 * 拟好稿之后给模型的那句话。它不会在这一轮回到模型手里（拟稿即收尾，见 `turn.ts`），
 * 但会作为历史进下一轮：那时模型要知道的是「这次没有提交，也没有花钱，等用户确认」。
 */
/** 回执写明实际尺寸：模型只能照它说比例，不能凭用户原话断言。视频没有这一项。 */
function sizeText(size: string | undefined): string {
  if (size === undefined) return ''
  return size === 'auto' ? '，尺寸由模型自动决定' : `，尺寸 ${size}`
}

function draftText(words: QueueMediaWords, count: number, size?: string): string {
  return `已按用户要求拟好${words.verb}提示词（${count} ${words.unit}${sizeText(size)}），提示词已原样展示给用户，等他确认。这次调用没有提交任何任务，也没有产生任何费用。用户可以直接修改提示词再点「确认生成」，届时系统按他确认的那一份原样提交。不要说已经在生成或已经生成好，也不要描述成品的样子；不要为同一件事再拟一次稿。`
}

/**
 * 出图模式下提交完给模型的那句话。这一轮不会因此收尾，模型接着往下做，所以措辞要让它
 * 明白「这一张已经在跑、已经计费」，别再为同一件事提交第二次。
 */
function submittedText(words: QueueMediaWords, count: number, size?: string): string {
  return `已按用户要求提交${words.verb}任务（${count} ${words.unit}${sizeText(size)}），这次调用已经提交并计费，结果会显示在对话的产物卡片中。不要描述成品的样子，也不要为同一件事再提交一次；结果由系统在任务结束时告诉你。`
}

/**
 * 生成工具的唯一出口。对话模式下请求准备齐了（模型、提示词、输入图、遮罩、档位、张数）却
 * **不提交**，而是把这整份材料存成一份待确认的草稿，卡片停在「等待确认」；队列任务、预留与
 * 扣费都要等用户在卡上确认之后才发生（见 `confirmations.ts`）。
 *
 * 出图模式（`params.autoSubmit`）走同一份材料当场提交，卡片直接是「已提交」，这一轮不因此
 * 收尾，模型接着出下一张（见 `auto-submit.ts`）。额度领完、或者提交被拒（余额不够、配额用尽）
 * 都退回拟稿：稿子照样留给用户，不中断整轮。
 *
 * 门设在这一处而不是各工具入口：草稿里的提示词必须是真正会送进上游的那一句——遮罩编辑的执行
 * 指令由服务端按用户原文与选区拼出来，模型手里的只是摘要。准备做完再拟稿，用户看到、改到的
 * 才是真正会执行的东西。
 */
export async function draftQueueTask(
  context: AgentToolContext,
  input: QueueTaskInput,
  signal: AbortSignal | undefined,
): Promise<AgentToolResult<AgentToolDetails>> {
  if (context.experience === 'canvas')
    throw new AgentToolError(
      'invalid_params',
      '画布生成必须属于目标节点。请先用 createNodes 或 updateNodes 准备节点，再用 runNodes 发起运行；结果将保留在该节点，不会创建无主图片。',
    )
  const clarification =
    input.media === 'image'
      ? context.imageCombinations?.inspect(input.referenceIds ?? [], input.n ?? 1)
      : undefined
  if (clarification)
    return {
      content: [
        {
          type: 'text',
          text: '图片组合尚未确认，已请用户选择分别生成还是共同参考。没有创建任务或计费，等待用户作答。',
        },
      ],
      details: { clarification },
    }
  const words = QUEUE_MEDIA_WORDS[input.media]
  const review = input.review === true
  const target = input.target ?? resolveAgentModel(input.media, context.params?.model)
  if (!target) throw new AgentToolError('model_unavailable', noModelMessage(input.media))

  const hasSelection = context.images.masked
  if (hasSelection) context.maskedEditPlan?.protect()
  const maskedTurn = input.media === 'image' && (hasSelection || context.maskedEditPlan?.protected)
  if (maskedTurn && !input.inputImages?.length)
    throw new AgentToolError(
      'invalid_params',
      '本轮存在用户选区，请使用改图工具核对目标与参考，不能改为无参考生图',
    )
  // 批次身份只在遮罩轮上问；内容身份跟着这次编辑走，与本轮是不是遮罩轮无关。
  const submission: MaskedSubmission = {
    ...(maskedTurn
      ? {
          call: {
            toolCallId: input.toolCallId ?? '',
            ...(input.maskedOperation ? { operation: input.maskedOperation } : {}),
          },
        }
      : {}),
    ...(input.maskedContent ? { content: input.maskedContent } : {}),
  }
  const approval = context.maskedEditPlan?.approve(submission) ?? 'approved'
  if (approval === 'already-submitted')
    throw new AgentToolError(
      'invalid_params',
      '这个编辑操作已经拟过稿，请先检查候选；不要自行重复拟稿',
    )
  if (approval === 'outside-batch')
    throw new AgentToolError(
      'invalid_params',
      '本轮编辑计划已经执行，不能自行追加生成；请检查已有候选并等待用户指示',
    )

  if (signal?.aborted) throw new AgentToolError('cancelled', '这一轮被中止了')
  await context.assertExecution?.()
  const asked = input.media === 'image' ? requestedImageCount(input.n, context.params?.n) : 1
  const count = input.media === 'image' ? agentModelImageCount(target.model, asked) : 1
  // 模型单笔上限收紧了张数（AGENT_MODEL_IMAGE_MAX_N）：回执照实说，智能体才不会对用户说出错的张数。
  const capNote = count < asked ? `这个模型一次最多出 ${count} 张，已按 ${count} 张处理。` : ''
  // 计划随材料一起冻结：用户几分钟后才确认，那时这一轮的内存早已不在，唤醒轮要接的是提交那一刻的计划。
  const plan = context.maskedEditPlan?.carryAfter(submission)
  const bound = await bindProductionGeneration(context, input)
  const inputImages = bound?.inputImages ?? input.inputImages
  const video =
    input.video && bound
      ? productionClipVideo({
          video: input.video,
          references: bound.references.map((one) => ({
            reference: one.reference,
            usage: one.usage ?? 'reference',
          })),
        })
      : input.video
  const request = {
    prompt: input.prompt,
    device_id: context.deviceId,
    // 视频档位由 input.video 自己带，图片参数对它没有意义。
    ...(input.media === 'image'
      ? queueParamsFor(target.provider, withAspectRatio(context.params, input.aspectRatio))
      : {}),
    n: count,
    ...(inputImages?.length ? { input_images: [...inputImages] } : {}),
    ...(input.mask ? { mask: input.mask } : {}),
  }
  const imageSize = input.media === 'image' ? (request.size ?? 'auto') : undefined
  const draftSubmission = {
    ...(bound
      ? {
          production: bound.production,
          productionDraftRevision: 1,
          productionParams: context.params,
          productionReferences: bound.references,
        }
      : {}),
    review,
    ...(input.anchorObjectId ? { anchorObjectId: input.anchorObjectId } : {}),
    ...(plan ? { plan } : {}),
    ...(input.videoRecord ? { videoRecord: input.videoRecord } : {}),
  }

  if (!bound && context.autoSubmit?.take()) {
    const submitted = await submitAgentGeneration({
      conversationId: context.conversationId,
      turnId: context.turnId,
      toolCallId: input.toolCallId ?? '',
      userId: context.userId,
      media: input.media,
      provider: target.provider,
      model: target.model,
      request,
      ...(video ? { video } : {}),
      submission: draftSubmission,
    })
    if (submitted.kind === 'created') {
      context.maskedEditPlan?.submitted(submission)
      if (input.media === 'image') context.imageCombinations?.submitted(input.referenceIds ?? [])
      return {
        content: [{ type: 'text', text: submittedText(words, count, imageSize) + capNote }],
        details: {
          executedPrompt: input.prompt,
          job: submitted.job,
          ...(input.anchorObjectId ? { anchorObjectId: input.anchorObjectId } : {}),
        },
      }
    }
  }

  // 确认门拦下的调用：材料照样存成待确认的稿，但给模型的回执与当场提交时逐字相同——智能体不知道
  // 停过，这一轮在这次调用之后停住，用户确认后接着跑（见 `tool-gate.ts`）。
  const held = !bound && context.gate?.holds(input.toolCallId ?? '') === true
  await saveGenerationDraft({
    conversationId: context.conversationId,
    turnId: context.turnId,
    toolCallId: input.toolCallId ?? '',
    toolName: input.toolName,
    media: input.media,
    provider: target.provider,
    model: target.model,
    prompt: input.prompt,
    request,
    ...(video ? { video } : {}),
    submission: draftSubmission,
  })
  // 草稿真的落下了才登记：同一轮里模型不能为同一件事拟第二次稿，确认与否由用户决定。
  context.maskedEditPlan?.submitted(submission)
  if (input.media === 'image') context.imageCombinations?.submitted(input.referenceIds ?? [])
  const receipt =
    (held ? submittedText(words, count, imageSize) : draftText(words, count, imageSize)) + capNote
  return {
    content: [{ type: 'text', text: receipt }],
    details: {
      executedPrompt: input.prompt,
      awaitingConfirmation: true as const,
      ...(held ? { gated: true as const, gateReceipt: receipt } : {}),
      ...(bound ? { productionDraftRevision: 1 } : {}),
      ...(input.videoRecord ? { video: input.videoRecord } : {}),
      ...(input.anchorObjectId ? { anchorObjectId: input.anchorObjectId } : {}),
    },
  }
}
