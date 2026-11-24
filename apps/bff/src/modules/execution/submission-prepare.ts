import type { PersistedSubmitRequest } from '@image-playground/shared'
import { DEFAULT_IMAGE_MODERATION, shapeQueuePrompt } from '@image-playground/shared'
import { modelCapabilities } from '../../lib/channels'
import { archiveInputImages, ObjectStorageError } from '../../lib/imageArchive'
import { objectStore } from '../../lib/objectStore'
import { commandHash } from './submission-idempotency'
import {
  alignImageTier,
  alignStageSubmission,
  degradeImage26Alignment,
  type ImageTierAlignment,
} from './submission-tier'
import {
  assertTaskSubmissionPluginRegistered,
  type CreateQueueTaskInput,
  MissingTaskSubmissionPluginError,
  transformSubmissionInput,
} from './task-submission-plugins'

/**
 * 一条已经归档好输入的提交，只在 execution 模块内流转（见 `submitPrepared`）。
 * 档位决定随准备结果冻结：提交时沿用准备那一刻的会员位与收口后的请求，不再重查，
 * 准备和提交之间会员开通或到期不会让两边的请求对不上。4K 门禁仍在提交事务里按当时的会员资格判。
 */
export interface PreparedQueueTask {
  readonly taskId: string
  readonly requestHash: string
  readonly requestPayload: PersistedSubmitRequest
  readonly alignment: ImageTierAlignment
}

/**
 * Read, transform and archive image bytes before acquiring caller transaction locks.
 * Prompt shaping stays here, after image/mask preparation, so mask-specific prompt notes are retained.
 * 预先准备的入口（批量执行、自动提交、灵感套用）的 `entry` 一律让 GPT 收到非会员上限，见 `resolveImageTier`。
 */
export async function prepareQueueTask(input: CreateQueueTaskInput) {
  const identity = await alignImageTier(alignStageSubmission(input))
  const billed = await degradeImage26Alignment(identity)
  return prepareAlignedQueueTask(billed, identity.input)
}

export async function prepareAlignedQueueTask(
  alignment: ImageTierAlignment,
  identity?: CreateQueueTaskInput,
) {
  const { input } = alignment
  if (input.request.mask && !input.video) {
    assertTaskSubmissionPluginRegistered('masked-input')
  }
  const id = crypto.randomUUID()
  let requestPayload: PersistedSubmitRequest
  try {
    const transformed = await transformSubmissionInput(input)
    const baseRequest = transformed.request
    const capabilities = modelCapabilities(input.model)
    const shaping =
      input.promptShaping && !input.video
        ? {
            original_prompt: input.promptShaping.originalPrompt,
            provider: input.provider,
            model: input.model,
            ...(baseRequest.size ? { size: baseRequest.size } : {}),
            ...(input.request.no_rewrite !== undefined
              ? { no_rewrite: input.request.no_rewrite }
              : {}),
            ratio_via_prompt:
              input.promptShaping.ratioViaPrompt ??
              Boolean(baseRequest.size && capabilities && !capabilities.includes('size')),
          }
        : undefined
    const request = shaping
      ? {
          ...baseRequest,
          prompt: shapeQueuePrompt({ prompt: baseRequest.prompt, facts: shaping }),
        }
      : baseRequest
    requestPayload = {
      ...(await archiveInputImages(id, request)),
      ...(input.video ? { video: input.video } : {}),
      ...transformed.facts,
      ...(shaping ? { prompt_shaping: shaping } : {}),
    }
    // The request body cannot opt into (or out of) the server's execution contract.
    delete requestPayload.strict_image_request
    if (input.strictImageRequest) requestPayload.strict_image_request = true
  } catch (error) {
    await discardArchivedInputs(id)
    if (error instanceof MissingTaskSubmissionPluginError) throw error
    if (error instanceof TypeError) {
      return { kind: 'invalid_input_image' as const, message: error.message }
    }
    return {
      kind: 'object_storage_error' as const,
      message:
        error instanceof ObjectStorageError ? error.message : 'Object storage input archive failed',
    }
  }
  if (input.provider === 'openai-compat' && !input.video) {
    requestPayload.moderation ??= DEFAULT_IMAGE_MODERATION
  }

  return {
    kind: 'prepared' as const,
    prepared: {
      taskId: id,
      requestHash: commandHash(identity ?? input),
      requestPayload,
      alignment,
    },
  }
}

/** 没有任务行引用这个前缀了；删不掉也只是留个孤儿，由 bucket lifecycle 收。 */
export async function discardArchivedInputs(taskId: string): Promise<void> {
  try {
    await objectStore().deletePrefix(`${taskId}/in/`)
  } catch {
    // Bucket lifecycle cleanup removes any orphan.
  }
}
