import type { AuthUserView } from '@image-playground/shared'
import { findCatalogModel } from '@image-playground/shared/model-catalog'
import { Elysia, t } from 'elysia'
import { db } from '../db/client'
import { getChannels, isModelDisabled, resolveQueueModel } from '../lib/channels'
import { cliApiRoutes, cliError, cliSuccess } from '../lib/cli-api'
import { MEDIA_INPUT_PATTERN, resolveMediaInputs } from '../lib/mediaInputs'
import { loadPrivateBffOverlay } from '../lib/private-overlay'
import {
  type CreateQueueTaskOutcome,
  createQueueTask,
  findTaskByIdempotencyKey,
} from '../lib/taskSubmission'

const imageJobBody = t.Object({
  prompt: t.String({ minLength: 1, maxLength: 32_000 }),
  model: t.Optional(t.String({ minLength: 1, maxLength: 128 })),
  aspect_ratio: t.Optional(t.String({ minLength: 1, maxLength: 16 })),
  image_size: t.Optional(t.String({ minLength: 1, maxLength: 16 })),
  quality: t.Optional(t.String({ minLength: 1, maxLength: 16 })),
  input_images: t.Optional(
    t.Array(t.String({ pattern: `^data:[^;,]+;base64,|${MEDIA_INPUT_PATTERN}` }), { maxItems: 16 }),
  ),
  count: t.Optional(t.Integer({ minimum: 1, maximum: 1 })),
  max_credits: t.Optional(t.Integer({ minimum: 0, maximum: 2_147_483_647 })),
  idempotency_key: t.Optional(t.String({ minLength: 8, maxLength: 64 })),
})

type ImageJobBody = typeof imageJobBody.static

type NormalizedImageJob = {
  prompt: string
  model: string
  provider: 'gemini' | 'openai-compat'
  aspect_ratio: string
  image_size?: string
  quality?: string
  input_images?: string[]
  count: 1
  max_credits?: number
  idempotency_key?: string
}

function normalize(body: ImageJobBody): NormalizedImageJob | { error: string; details?: unknown } {
  const prompt = body.prompt.trim()
  if (!prompt) return { error: 'prompt is required' }
  const selected = resolveQueueModel('image', body.model)
  if (!selected) return { error: 'model is unavailable' }
  const catalog = findCatalogModel(selected.model)
  if (!catalog) return { error: 'model is unavailable' }
  const image = catalog.image
  const ratio = body.aspect_ratio ?? image.ratios[0]
  if (!image.ratios.includes(ratio as never))
    return { error: 'unsupported aspect_ratio', details: { available: image.ratios } }
  const tier = body.image_size ?? image.defaultTier
  if (!image.tiers.some((entry: { id: string }) => entry.id === tier))
    return {
      error: 'unsupported image_size',
      details: { available: image.tiers.map((entry: { id: string }) => entry.id) },
    }
  if (
    body.quality &&
    image.quality?.values &&
    !image.quality.values.includes(body.quality as never)
  )
    return { error: 'unsupported quality', details: { available: image.quality.values } }
  if (body.input_images && body.input_images.length > (catalog.image.references.max ?? 0))
    return { error: 'too many reference images' }
  if (body.input_images?.length && !image.operations.includes('edit'))
    return { error: 'model does not support reference images' }
  return {
    prompt,
    model: selected.model,
    provider: selected.provider,
    aspect_ratio: ratio,
    ...(body.quality ? { quality: body.quality } : {}),
    ...(body.input_images ? { input_images: [...body.input_images] } : {}),
    ...(tier ? { image_size: tier } : {}),
    count: 1,
    ...(body.max_credits !== undefined ? { max_credits: body.max_credits } : {}),
    ...(body.idempotency_key ? { idempotency_key: body.idempotency_key } : {}),
  }
}

async function accountData(user: AuthUserView) {
  const summary = await (await loadPrivateBffOverlay()).taskHooks.accountSummary?.({
    userId: user.id,
    now: Date.now(),
  })
  return {
    account: user,
    credits: summary?.credits ?? null,
    member: summary?.isMember ?? false,
    min_cli_version: '0.1.0',
  }
}

/** Models (of those given) this user may request at 4K; one transaction for the whole list. */
async function modelsAllowing4k(user: AuthUserView, models: string[]): Promise<Set<string>> {
  const canSubmitTask = (await loadPrivateBffOverlay()).taskHooks.canSubmitTask
  if (!canSubmitTask || !models.length) return new Set()
  return db.transaction(async (tx) => {
    const allowed = new Set<string>()
    for (const model of models)
      if (await canSubmitTask({ tx, userId: user.id, model, request: { image_size: '4K' } }))
        allowed.add(model)
    return allowed
  })
}

async function canUse4k(user: AuthUserView, model: string): Promise<boolean> {
  return (await modelsAllowing4k(user, [model])).has(model)
}

async function capabilityData(user: AuthUserView) {
  const imageModels = getChannels().flatMap((channel) =>
    channel.models.filter(
      (model) => (model.media ?? 'image') === 'image' && !isModelDisabled(model.id),
    ),
  )
  const allows4k = await modelsAllowing4k(
    user,
    imageModels
      .filter((model) => findCatalogModel(model.id)?.image.tiers.some((tier) => tier.id === '4K'))
      .map((model) => model.id),
  )
  const models = imageModels.map((model) => {
    const catalog = findCatalogModel(model.id)
    return {
      id: model.id,
      label: model.label,
      input_schema: {
        prompt: { type: 'string', required: true },
        aspect_ratio: catalog?.image.ratios ?? [],
        image_size:
          catalog?.image.tiers
            .filter((tier) => tier.id !== '4K' || allows4k.has(model.id))
            .map((tier) => tier.id) ?? [],
        quality: catalog?.image.quality?.values ?? [],
        reference_images_max: catalog?.image.references.max ?? 0,
      },
      price: { unit: 'credit', quote_required: true },
      duration_seconds: model.etaSeconds ?? null,
      limits: { count: 1, references: catalog?.image.references.max ?? 0 },
      default_model: false,
    }
  })
  const first = models[0]
  if (first) first.default_model = true
  return {
    account_id: user.id,
    models,
    default_model: first?.id ?? null,
    limits: {
      count: 1,
      max_reference_images: Math.max(0, ...models.map((model) => model.limits.references)),
    },
    server_authoritative: true,
  }
}

/** Shared front half of validate and create: normalize, gate 4K, resolve reference media. */
async function prepareImageJob(
  request: Request,
  body: ImageJobBody,
  user: AuthUserView,
): Promise<{ normalized: NormalizedImageJob; inputImages?: string[] } | Response> {
  const normalized = normalize({
    ...body,
    idempotency_key: body.idempotency_key ?? request.headers.get('idempotency-key') ?? undefined,
  })
  if ('error' in normalized)
    return cliError('INVALID_REQUEST', normalized.error, normalized.details)
  if (normalized.image_size === '4K' && !(await canUse4k(user, normalized.model)))
    return cliError('FORBIDDEN')
  const inputImages = await resolveMediaInputs(user.id, normalized.input_images, {
    masked: false,
    signal: request.signal,
  })
  return { normalized, inputImages }
}

function maxCreditsExceeded(required: number, maxCredits: number): Response {
  return cliError(
    'MAX_CREDITS_EXCEEDED',
    'The request exceeds max_credits',
    { required, max_credits: maxCredits },
    402,
  )
}

/** Rejections that map straight onto a CLI error; created/duplicate/idempotency are handled inline. */
function rejectedOutcome(
  outcome: Exclude<
    CreateQueueTaskOutcome,
    { kind: 'created' | 'duplicate_submission' | 'idempotency_conflict' }
  >,
): Response {
  switch (outcome.kind) {
    case 'idempotency_mismatch':
      return cliError('CONFLICT')
    case 'max_credits_exceeded':
      return maxCreditsExceeded(outcome.required, outcome.maxCredits)
    case 'insufficient_credits':
      return cliError(
        'INSUFFICIENT_CREDITS',
        'Insufficient credits',
        { required: outcome.required, available: outcome.available },
        402,
      )
    case 'object_storage_error':
      return cliError('INTERNAL_ERROR', undefined, undefined, 503)
    case 'private_billing_denied':
      return cliError(
        'PLAN_REQUIRED',
        'An active subscription is required for this image size',
        undefined,
        403,
      )
    case 'price_unavailable':
      return cliError('CAPABILITY_UNAVAILABLE')
    case 'authentication_required':
      return cliError('UNAUTHENTICATED')
    case 'quota_exceeded':
      return cliError('RATE_LIMITED')
    case 'invalid_prompt':
    case 'invalid_input_image':
      return cliError('INVALID_REQUEST')
    default:
      throw new Error('queue submission failed')
  }
}

/** External CLI API uses the existing unprefixed `/v1` boundary; website routes remain untouched. */
export const cliImageRoutes = new Elysia({ name: 'cli-image-routes' })
  .use(cliApiRoutes())
  .get('/v1/me', async ({ cliUser }) => cliSuccess(await accountData(cliUser)))
  .get('/v1/capabilities', async ({ cliUser }) => cliSuccess(await capabilityData(cliUser)))
  .post(
    '/v1/image-jobs/validate',
    async ({ request, body, cliUser }) => {
      const prepared = await prepareImageJob(request, body, cliUser)
      if (prepared instanceof Response) return prepared
      const { normalized, inputImages } = prepared
      const hooks = (await loadPrivateBffOverlay()).taskHooks
      const quote = hooks.quoteTask
        ? await db.transaction((tx) =>
            hooks.quoteTask!({
              tx,
              userId: cliUser.id,
              model: normalized.model,
              quantity: 1,
              unitMultiplier: 1,
            }),
          )
        : null
      if (
        quote &&
        normalized.max_credits !== undefined &&
        quote.estimatedCredits > normalized.max_credits
      )
        return maxCreditsExceeded(quote.estimatedCredits, normalized.max_credits)
      return cliSuccess({
        normalized: { ...normalized, ...(inputImages ? { input_images: inputImages } : {}) },
        quote: quote ? { estimated_credits: quote.estimatedCredits, pricing: quote.pricing } : null,
        holds: false,
      })
    },
    { body: imageJobBody },
  )
  .post(
    '/v1/image-jobs',
    async ({ request, body, cliUser }) => {
      const prepared = await prepareImageJob(request, body, cliUser)
      if (prepared instanceof Response) return prepared
      const { normalized, inputImages } = prepared
      const outcome = await createQueueTask({
        provider: normalized.provider,
        model: normalized.model,
        userId: cliUser.id,
        maxCredits: normalized.max_credits,
        request: {
          prompt: normalized.prompt,
          n: 1,
          aspect_ratio: normalized.aspect_ratio,
          ...(normalized.image_size ? { image_size: normalized.image_size } : {}),
          ...(normalized.quality ? { quality: normalized.quality } : {}),
          ...(inputImages ? { input_images: inputImages } : {}),
          ...(normalized.idempotency_key ? { client_request_id: normalized.idempotency_key } : {}),
        },
      })
      if (outcome.kind === 'created')
        return cliSuccess({
          job_id: outcome.taskId,
          status: 'queued',
          submitted_at: outcome.submittedAt,
        })
      if (outcome.kind === 'duplicate_submission')
        return cliSuccess({ job_id: outcome.taskId, status: 'queued' })
      if (outcome.kind === 'idempotency_conflict') {
        const key = normalized.idempotency_key
        const existing = key ? await findTaskByIdempotencyKey(key, cliUser.id) : null
        if (existing)
          return cliSuccess({
            job_id: existing.id,
            status: 'queued',
            submitted_at: existing.submitted_at,
          })
        return cliError('CONFLICT')
      }
      return rejectedOutcome(outcome)
    },
    { body: imageJobBody },
  )
