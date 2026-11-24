import {
  registerTaskSubmissionPlugin,
  type TaskSubmissionPlugin,
} from '../modules/execution/task-submission-plugins'

/**
 * 「这是不是一次遮罩提交」只在这里判一次：`preserve_outside_mask` 与 `masked_original_size`
 * 描述同一个判定，要么都写、要么都不写，由这一个返回值保证。
 * 判据是请求里有没有选区，不是谁发的：画布与工作台直发的局部重绘同样要圈外像素不变，
 * 按提交方分叉会让同一个功能在两条路径上行为不一致。
 * `prepareMaskedInput` 不合规时抛 `TypeError`，由调用方翻成 `invalid_input_image`。
 */
const maskedInputPlugin: TaskSubmissionPlugin = {
  id: 'masked-input',
  async transformInput(input) {
    const request = input.request
    if (!request.mask || input.video) return undefined
    const { prepareMaskedInput } = await import('../modules/agent/orchestration/masked/pure')
    const strict = await prepareMaskedInput(
      input.model,
      request.input_images?.[0] ?? '',
      request.mask,
    )
    const { output_compression: _compression, ...rest } = request
    return {
      request: {
        ...rest,
        input_images: [strict.source, ...request.input_images!.slice(1)],
        mask: strict.mask,
        size: strict.size,
        // 保护选区外像素要逐像素比对，有损格式与压缩会把它毁掉。
        output_format: 'png' as const,
        // 局部编辑要一张完全不透明的图：带透明度的结果既合成不回原图，也过不了对齐校验。
        extra: { ...rest.extra, background: 'opaque' },
      },
      facts: {
        preserve_outside_mask: true as const,
        masked_original_size: strict.originalSize,
        ...(strict.crop ? { masked_crop: strict.crop } : {}),
      },
    }
  },
}

const stageAuthorizationPlugin: TaskSubmissionPlugin = {
  id: 'stage-authorization',
  async afterTaskCreated(tx, { input, taskId, requestPayload, pricing, reservedCredits }) {
    if (!input.stageAuthorization) return
    const { consumeStageAuthorization } = await import('../modules/agent/orchestration')
    await consumeStageAuthorization(
      tx,
      input.userId,
      input.stageAuthorization,
      taskId,
      {
        model: input.model,
        quantity: pricing.quantity,
        unitMultiplier: pricing.unitMultiplier,
      },
      reservedCredits,
      {
        prompt: input.request.prompt,
        inputCount: requestPayload.input_images?.length ?? 0,
        // 指纹用归一化后的计价数量，和提案快照是同一个数。1.9 秒在带授权时已经收成合法档。
        ...(input.video
          ? {
              video: {
                durationSeconds: pricing.quantity,
                resolution: input.video.resolution,
                aspectRatio: input.video.aspect_ratio,
              },
            }
          : {}),
      },
      // 创作页分发层会给图片 prompt 钉防改写前缀 / 构图后缀，授权冻结的是原文。
      // 视频提交原样发冻结的 prompt，不放宽。
      input.video
        ? undefined
        : {
            provider: input.provider,
            model: input.model,
            ...(input.request.size ? { size: input.request.size } : {}),
          },
    )
  },
}

const projectArchivePlugin: TaskSubmissionPlugin = {
  id: 'project-archive',
  async beforeAdmission(tx, input) {
    if (!input.userId || !input.agent || input.video) return
    const { isCapabilityEnabled } = await import('../lib/capabilities')
    if (!isCapabilityEnabled('accounts:sync')) return
    const { lockMediaOwner } = await import('../lib/projectMedia')
    await lockMediaOwner(tx, input.userId)
  },
  async afterTaskCreated(tx, { input, taskId }) {
    if (!input.userId || !input.agent || input.video) return
    const { isCapabilityEnabled } = await import('../lib/capabilities')
    if (!isCapabilityEnabled('accounts:sync')) return
    const { reserveProjectOutputs } = await import('../lib/projectArchive')
    await reserveProjectOutputs(tx, {
      userId: input.userId,
      generationId: taskId,
      conversationId: input.agent.conversationId,
      turnId: input.agent.turnId,
      count: input.request.n ?? 1,
      ...(input.projectSlot ? { replaceObjectId: input.projectSlot } : {}),
    })
  },
}

const agentJobPlugin: TaskSubmissionPlugin = {
  id: 'agent-job',
  async afterTaskCreated(tx, { input, taskId, submittedAt }) {
    if (!input.agent?.job) return
    const { schema } = await import('../db/client')
    await tx.insert(schema.agent_jobs).values({
      task_id: taskId,
      conversation_id: input.agent.conversationId,
      turn_id: input.agent.turnId,
      tool_call_id: input.agent.job.toolCallId,
      wake_on_success: input.agent.job.wakeOnSuccess,
      plan: input.agent.job.plan ?? null,
      submitted_at: submittedAt,
    })
  },
}

const DEFAULT_TASK_SUBMISSION_PLUGINS: readonly TaskSubmissionPlugin[] = [
  maskedInputPlugin,
  stageAuthorizationPlugin,
  projectArchivePlugin,
  agentJobPlugin,
]

/**
 * 组合根注册内置的任务提交扩展插件（幂等）：
 * 保持 `modules/execution` 零依赖 `lib/agent/*`、`lib/projectArchive` 与 `agent_jobs` 表；
 * 仅静态导入无配置副作用的 `task-submission-plugins`，使单测辅助文件可在设置 env 前安全引入。
 */
export function registerDefaultTaskSubmissionPlugins(): void {
  for (const plugin of DEFAULT_TASK_SUBMISSION_PLUGINS) {
    registerTaskSubmissionPlugin(plugin)
  }
}

registerDefaultTaskSubmissionPlugins()
