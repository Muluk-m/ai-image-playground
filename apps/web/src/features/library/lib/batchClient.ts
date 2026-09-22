import { authenticatedBffFetch } from '../../../lib/authClient'
import { isUserStorageScope } from '../../../lib/authScope'
import { isClientCapabilityEnabled } from '../../../lib/clientCapabilities'
import { getDeviceId } from '../../../lib/deviceId'
import { bffBaseUrl, getRuntimeConfig } from '../../../lib/runtimeConfig'

/** 一批最多几条素材、每条最多几张：与 BFF 的 `/api/looks/batch` 是同一套上限。 */
export const LOOK_BATCH_MAX_ASSETS = 20
export const LOOK_BATCH_MAX_PER_ASSET = 4

/** 批量提交等的是服务端逐条归档输入图再建任务，比一次普通请求慢得多。 */
const LOOK_BATCH_TIMEOUT_MS = 60_000

export interface LookBatchInput {
  /** 自建模板的记录 id。与 `skillName` 二选一。 */
  readonly lookId?: string
  /** 预置模板的技能名。与 `lookId` 二选一。 */
  readonly skillName?: string
  /** 按顺序给：素材位只有一个时每条各起一个任务，不止一个时这一批按序填满那几个位。 */
  readonly assetIds: readonly string[]
  readonly perAsset: number
  /** 某条素材要出几张，盖过 `perAsset`；素材位不止一个时不起作用。 */
  readonly counts?: Readonly<Record<string, number>>
}

/** 一个建出来的任务，连同填进它的那几条素材。 */
export interface LookBatchTask {
  readonly assetIds: string[]
  readonly taskId: string
}

/**
 * 批量出图被拒。`code` 是服务端的拒绝码：`slot_mismatch` / `no_views` 带上 `assetId`
 * 指名是哪一条素材，`image_unavailable` 带 `imageId`，`model_unavailable` 带 `model`。
 */
export class LookBatchError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail: {
      readonly assetId?: string
      readonly imageId?: string
      readonly model?: string
    } = {},
  ) {
    super(code)
    this.name = 'LookBatchError'
  }
}

export function lookBatchEnabled(): boolean {
  return (
    getRuntimeConfig().bff.enabled &&
    isUserStorageScope() &&
    isClientCapabilityEnabled('accounts:sync')
  )
}

export async function submitLookBatch(
  input: LookBatchInput,
  signal?: AbortSignal,
): Promise<{ tasks: LookBatchTask[] }> {
  const timeout = AbortSignal.timeout(LOOK_BATCH_TIMEOUT_MS)
  const response = await authenticatedBffFetch(`${bffBaseUrl()}/api/looks/batch`, {
    method: 'POST',
    cache: 'no-store',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...(input.lookId ? { lookId: input.lookId } : {}),
      ...(input.skillName ? { skillName: input.skillName } : {}),
      assetIds: [...input.assetIds],
      perAsset: input.perAsset,
      ...(input.counts && Object.keys(input.counts).length > 0 ? { counts: input.counts } : {}),
      device_id: getDeviceId(),
    }),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string
      assetId?: string
      imageId?: string
      model?: string
    }
    throw new LookBatchError(response.status, body.error ?? 'look_batch_failed', {
      ...(body.assetId ? { assetId: body.assetId } : {}),
      ...(body.imageId ? { imageId: body.imageId } : {}),
      ...(body.model ? { model: body.model } : {}),
    })
  }
  return (await response.json()) as { tasks: LookBatchTask[] }
}
