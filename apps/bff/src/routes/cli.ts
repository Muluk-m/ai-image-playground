import { Elysia, t } from 'elysia'
import {
  CLI_CLIENT_ID,
  createDeviceAuthorization,
  decideDeviceAuthorization,
  describeDeviceAuthorization,
  exchangeDeviceCode,
  listCliConnections,
  refreshCliToken,
  revokeCliConnection,
  revokeCliToken,
} from '../lib/cli/auth'
import {
  cliApiEnabled,
  cliBoundary,
  createCliRateLimiter,
  requireScope,
  withMediaErrors,
} from '../lib/cli/boundary'
import { CliRequestError, cliSuccess } from '../lib/cli/envelope'
import {
  assertReferenceMedia,
  availableImageModels,
  CLI_PROMPT_MAX_CHARS,
  imageCapabilities,
  normalizeImageRequest,
  previewImageRequest,
  toSubmitRequest,
} from '../lib/cli/images'
import { cancelJob, getJob, JOB_LIST_MAX, listJobs, recordCliJob } from '../lib/cli/jobs'
import {
  artifactDownload,
  completeReferenceMedia,
  getArtifact,
  getMedia,
  listReferenceMedia,
  MEDIA_LIST_MAX,
  mediaDownload,
  reserveReferenceMedia,
} from '../lib/cli/media'
import { log } from '../lib/logger'
import { resolveMediaInputs } from '../lib/mediaInputs'
import { loadPrivateBffOverlay } from '../lib/private-overlay'
import { createQueueTask } from '../lib/taskSubmission'
import { requireUser } from '../lib/user-auth'
import { sessionClientFromRequest } from '../lib/user-session'
import { frontendOrigin } from './oauth'

/** CLI 低于这个版本时 `auth status` 报需要升级。 */
export const CLI_MIN_VERSION = '0.1.0'

/** 设备码与令牌端点不带凭据，按来源 IP 限流：轮询间隔 5 秒，一分钟 30 次足够。 */
const deviceStartLimiter = createCliRateLimiter({ maxRequests: 10, windowMs: 60_000 })
const tokenEndpointLimiter = createCliRateLimiter({ maxRequests: 30, windowMs: 60_000 })

function oauthJson(
  body: Record<string, unknown>,
  status = 200,
  headers: Record<string, string> = {},
) {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } })
}

function oauthUnavailable() {
  return oauthJson({ error: 'capability_unavailable' }, 404)
}

function limited(
  limiter: ReturnType<typeof createCliRateLimiter>,
  request: Request,
  peer: string | null,
): Response | null {
  const ip = sessionClientFromRequest(request, peer).ip ?? 'unknown'
  const result = limiter.check(ip)
  return result.allowed
    ? null
    : oauthJson({ error: 'slow_down' }, 429, { 'retry-after': String(result.retryAfterSeconds) })
}

const formClient = t.Object(
  { client_id: t.String({ maxLength: 64 }) },
  { additionalProperties: true },
)

/**
 * RFC 8628 设备授权与 RFC 6749/7009 令牌端点。放在 /v1/oauth 下是为了走 API 错误处理，
 * 但它们不经过 Bearer 边界：调用方此时还没有令牌。能力在每个处理器里判断，不挂 app 级钩子。
 */
export const cliOAuthRoutes = new Elysia()
  .post(
    '/v1/oauth/device_authorization',
    async ({ body, request, server }) => {
      if (!cliApiEnabled()) return oauthUnavailable()
      const blocked = limited(
        deviceStartLimiter,
        request,
        server?.requestIP(request)?.address ?? null,
      )
      if (blocked) return blocked
      if (body.client_id !== CLI_CLIENT_ID) return oauthJson({ error: 'invalid_client' }, 401)
      const result = await createDeviceAuthorization(
        CLI_CLIENT_ID,
        `${frontendOrigin(request)}/device`,
      )
      return result ? oauthJson({ ...result }) : oauthJson({ error: 'invalid_client' }, 401)
    },
    { body: formClient },
  )
  .post(
    '/v1/oauth/token',
    async ({ body, request, server }) => {
      if (!cliApiEnabled()) return oauthUnavailable()
      const blocked = limited(
        tokenEndpointLimiter,
        request,
        server?.requestIP(request)?.address ?? null,
      )
      if (blocked) return blocked
      if (body.client_id !== CLI_CLIENT_ID) return oauthJson({ error: 'invalid_client' }, 401)
      const result =
        body.grant_type === 'urn:ietf:params:oauth:grant-type:device_code' && body.device_code
          ? await exchangeDeviceCode(body.device_code, CLI_CLIENT_ID)
          : body.grant_type === 'refresh_token' && body.refresh_token
            ? await refreshCliToken(body.refresh_token, CLI_CLIENT_ID)
            : null
      if (!result) return oauthJson({ error: 'unsupported_grant_type' }, 400)
      return result.ok ? oauthJson({ ...result.tokens }) : oauthJson({ error: result.error }, 400)
    },
    {
      body: t.Object({
        client_id: t.String({ maxLength: 64 }),
        grant_type: t.String({ maxLength: 128 }),
        device_code: t.Optional(t.String({ maxLength: 256 })),
        refresh_token: t.Optional(t.String({ maxLength: 256 })),
      }),
    },
  )
  .post(
    '/v1/oauth/revoke',
    async ({ body }) => {
      if (!cliApiEnabled()) return oauthUnavailable()
      if (body.client_id !== CLI_CLIENT_ID) return oauthJson({ error: 'invalid_client' }, 401)
      await revokeCliToken(body.token, CLI_CLIENT_ID)
      return oauthJson({})
    },
    {
      body: t.Object({
        client_id: t.String({ maxLength: 64 }),
        token: t.String({ maxLength: 256 }),
      }),
    },
  )

const userCodeQuery = t.Object({ user_code: t.String({ minLength: 1, maxLength: 32 }) })

/** 网站确认页与账号设置用：走网站登录态，不认 CLI 令牌。 */
export const cliAccountRoutes = new Elysia()
  .use(requireUser)
  .get(
    '/api/cli/device',
    async ({ authUser, query, status }) => {
      if (!cliApiEnabled()) return status(404, { error: 'capability_unavailable' })
      if (!authUser) return status(401, { error: 'unauthorized' })
      const pending = await describeDeviceAuthorization(query.user_code)
      return pending ? pending : status(404, { error: 'invalid_code' })
    },
    { query: userCodeQuery },
  )
  .post(
    '/api/cli/device',
    async ({ authUser, body, status }) => {
      if (!cliApiEnabled()) return status(404, { error: 'capability_unavailable' })
      if (!authUser) return status(401, { error: 'unauthorized' })
      const changed = await decideDeviceAuthorization(
        body.user_code,
        authUser.id,
        body.decision === 'approve' ? 'approved' : 'denied',
      )
      return changed ? { ok: true } : status(404, { error: 'invalid_code' })
    },
    {
      body: t.Object({
        user_code: t.String({ minLength: 1, maxLength: 32 }),
        decision: t.Union([t.Literal('approve'), t.Literal('deny')]),
      }),
    },
  )
  .get('/api/me/cli-connections', async ({ authUser, status }) => {
    if (!cliApiEnabled()) return status(404, { error: 'capability_unavailable' })
    if (!authUser) return status(401, { error: 'unauthorized' })
    return { connections: await listCliConnections(authUser.id) }
  })
  .delete(
    '/api/me/cli-connections/:id',
    async ({ authUser, params, status }) => {
      if (!cliApiEnabled()) return status(404, { error: 'capability_unavailable' })
      if (!authUser) return status(401, { error: 'unauthorized' })
      return (await revokeCliConnection(authUser.id, params.id))
        ? { ok: true }
        : status(404, { error: 'not_found' })
    },
    { params: t.Object({ id: t.String({ minLength: 1, maxLength: 64 }) }) },
  )

const imageRequestFields = {
  prompt: t.String({ minLength: 1, maxLength: CLI_PROMPT_MAX_CHARS }),
  model: t.Optional(t.String({ minLength: 1, maxLength: 128 })),
  aspect_ratio: t.Optional(t.String({ minLength: 1, maxLength: 16 })),
  image_size: t.Optional(t.String({ minLength: 1, maxLength: 8 })),
  quality: t.Optional(t.String({ minLength: 1, maxLength: 16 })),
  reference_media_ids: t.Optional(t.Array(t.String({ format: 'uuid' }), { maxItems: 16 })),
  count: t.Optional(t.Literal(1)),
  max_credits: t.Optional(t.Integer({ minimum: 0, maximum: 1_000_000_000 })),
}
const idempotencyKey = t.String({ minLength: 8, maxLength: 64, pattern: '^[A-Za-z0-9_.:-]+$' })
const idParams = t.Object({ id: t.String({ minLength: 1, maxLength: 128 }) })
const pageQuery = (max: number) =>
  t.Object({
    limit: t.Optional(t.Integer({ minimum: 1, maximum: max })),
    cursor: t.Optional(t.String({ minLength: 1, maxLength: 128 })),
  })

/** 外部 CLI 接口。只有这一组用 Bearer 边界，网站的 /v1/queue 协议不受影响。 */
export const cliApiRoutes = new Elysia()
  .use(cliBoundary())
  .get('/v1/me', async ({ cli }) => {
    const summary = await (await loadPrivateBffOverlay()).taskHooks.accountSummary?.({
      userId: cli.user.id,
      now: Date.now(),
    })
    return cliSuccess({
      account: { id: cli.user.id, username: cli.user.username, nickname: cli.user.nickname },
      credits: summary?.credits ?? null,
      member: summary?.isMember ?? null,
      scopes: cli.scopes,
      min_cli_version: CLI_MIN_VERSION,
    })
  })
  .get('/v1/capabilities', async ({ cli }) => cliSuccess(await imageCapabilities(cli.user.id)))
  .post(
    '/v1/image-jobs/validate',
    async ({ cli, body }) => {
      requireScope(cli, 'images:write')
      const prepared = normalizeImageRequest(body, await availableImageModels())
      await assertReferenceMedia(cli.user.id, prepared.normalized.reference_media_ids)
      const preview = await previewImageRequest(cli.user.id, prepared, toSubmitRequest(prepared))
      if (preview.planRequired) throw new CliRequestError('PLAN_REQUIRED')
      const estimated = preview.quote?.estimated_credits
      if (body.max_credits !== undefined && estimated !== undefined && estimated > body.max_credits)
        throw new CliRequestError('MAX_CREDITS_EXCEEDED', {
          details: { required: estimated, max_credits: body.max_credits },
        })
      return cliSuccess({
        normalized: prepared.normalized,
        request_hash: prepared.requestHash,
        adjustments: prepared.adjustments,
        quote: preview.quote,
        creates_job: false,
      })
    },
    { body: t.Object(imageRequestFields, { additionalProperties: false }) },
  )
  .post(
    '/v1/image-jobs',
    async ({ cli, body, request }) => {
      requireScope(cli, 'images:write')
      const prepared = normalizeImageRequest(body, await availableImageModels())
      await assertReferenceMedia(cli.user.id, prepared.normalized.reference_media_ids)
      const submit = toSubmitRequest(prepared)
      const inputImages = await withMediaErrors(() =>
        resolveMediaInputs(cli.user.id, submit.input_images, {
          masked: false,
          signal: request.signal,
        }),
      )
      const outcome = await createQueueTask({
        provider: prepared.model.provider,
        model: prepared.model.id,
        userId: cli.user.id,
        ...(body.max_credits === undefined ? {} : { maxCredits: body.max_credits }),
        request: {
          ...submit,
          ...(inputImages ? { input_images: inputImages } : {}),
          client_request_id: body.idempotency_key,
        },
      })
      switch (outcome.kind) {
        case 'created':
        case 'duplicate_submission': {
          await recordCliJob(outcome.taskId, cli.user.id, cli.id).catch((err: unknown) =>
            log.warn({ event: 'cli.job_record_failed', err }, 'cli job attribution failed'),
          )
          return cliSuccess({
            job: await getJob(cli.user.id, outcome.taskId),
            request_hash: prepared.requestHash,
            adjustments: prepared.adjustments,
          })
        }
        case 'idempotency_mismatch':
        case 'idempotency_conflict':
          throw new CliRequestError('IDEMPOTENCY_CONFLICT')
        case 'invalid_prompt':
          throw new CliRequestError('INVALID_REQUEST', { message: 'prompt is required' })
        case 'invalid_input_image':
          throw new CliRequestError('INVALID_REQUEST', { message: outcome.message })
        case 'authentication_required':
          throw new CliRequestError('UNAUTHENTICATED')
        case 'private_billing_denied':
          throw new CliRequestError('PLAN_REQUIRED')
        case 'insufficient_credits':
          throw new CliRequestError('INSUFFICIENT_CREDITS', {
            details: { required: outcome.required, available: outcome.available },
          })
        case 'max_credits_exceeded':
          throw new CliRequestError('MAX_CREDITS_EXCEEDED', {
            details: { required: outcome.required, max_credits: outcome.maxCredits },
          })
        case 'price_unavailable':
          throw new CliRequestError('MODEL_UNAVAILABLE')
        case 'quota_exceeded':
          throw new CliRequestError('RATE_LIMITED', {
            message: 'Daily generation quota exceeded',
            details: { reset_at: outcome.quota.reset_at },
          })
        case 'object_storage_error':
          throw new CliRequestError('TEMPORARILY_UNAVAILABLE')
        default: {
          const unhandled: never = outcome
          throw new Error(`unhandled queue outcome ${JSON.stringify(unhandled)}`)
        }
      }
    },
    {
      body: t.Object(
        { ...imageRequestFields, idempotency_key: idempotencyKey },
        { additionalProperties: false },
      ),
    },
  )
  .get(
    '/v1/jobs',
    async ({ cli, query }) => {
      requireScope(cli, 'images:read')
      return cliSuccess(
        await listJobs(cli.user.id, {
          limit: query.limit ?? 20,
          ...(query.cursor ? { cursor: query.cursor } : {}),
          ...(query.idempotency_key ? { idempotencyKey: query.idempotency_key } : {}),
        }),
      )
    },
    {
      query: t.Object({
        limit: t.Optional(t.Integer({ minimum: 1, maximum: JOB_LIST_MAX })),
        cursor: t.Optional(t.String({ minLength: 1, maxLength: 128 })),
        idempotency_key: t.Optional(idempotencyKey),
      }),
    },
  )
  .get(
    '/v1/jobs/:id',
    async ({ cli, params }) => {
      requireScope(cli, 'images:read')
      return cliSuccess(await getJob(cli.user.id, params.id))
    },
    { params: idParams },
  )
  .post(
    '/v1/jobs/:id/cancel',
    async ({ cli, params }) => {
      requireScope(cli, 'images:write')
      return cliSuccess(await cancelJob(cli.user.id, params.id))
    },
    { params: idParams },
  )
  .post(
    '/v1/media',
    async ({ cli, body }) => {
      requireScope(cli, 'media:write')
      return cliSuccess(await withMediaErrors(() => reserveReferenceMedia(cli.user.id, body)))
    },
    {
      body: t.Object(
        {
          sha256: t.String({ pattern: '^[a-f0-9]{64}$' }),
          bytes: t.Integer({ minimum: 1 }),
          content_type: t.Union([
            t.Literal('image/png'),
            t.Literal('image/jpeg'),
            t.Literal('image/webp'),
          ]),
        },
        { additionalProperties: false },
      ),
    },
  )
  .post(
    '/v1/media/:id/complete',
    async ({ cli, params }) => {
      requireScope(cli, 'media:write')
      return cliSuccess(await withMediaErrors(() => completeReferenceMedia(cli.user.id, params.id)))
    },
    { params: idParams },
  )
  .get(
    '/v1/media',
    async ({ cli, query }) => {
      requireScope(cli, 'media:read')
      return cliSuccess(
        await listReferenceMedia(cli.user.id, {
          limit: query.limit ?? 20,
          ...(query.cursor ? { cursor: query.cursor } : {}),
        }),
      )
    },
    { query: pageQuery(MEDIA_LIST_MAX) },
  )
  .get(
    '/v1/media/:id',
    async ({ cli, params }) => {
      requireScope(cli, 'media:read')
      return cliSuccess(await withMediaErrors(() => getMedia(cli.user.id, params.id)))
    },
    { params: idParams },
  )
  .get(
    '/v1/media/:id/download',
    async ({ cli, params }) => {
      requireScope(cli, 'media:read')
      return cliSuccess(await withMediaErrors(() => mediaDownload(cli.user.id, params.id)))
    },
    { params: idParams },
  )
  .get(
    '/v1/artifacts/:id',
    async ({ cli, params }) => {
      requireScope(cli, 'images:read')
      return cliSuccess(await getArtifact(cli.user.id, params.id))
    },
    { params: idParams },
  )
  .get(
    '/v1/artifacts/:id/download',
    async ({ cli, params }) => {
      requireScope(cli, 'images:read')
      return cliSuccess(await artifactDownload(cli.user.id, params.id))
    },
    { params: idParams },
  )
