import type { ContainerSample, HostSample } from '@image-playground/shared'
import { Elysia, t } from 'elysia'
import { db, schema } from '../db/client'
import { readBackups } from '../lib/ops-backups'
import { requireInternalService } from '../lib/user-auth'

/** 采集方的时钟允许的超前量；再往后的读数只可能是坏数据。 */
const CLOCK_SKEW_MS = 5 * 60 * 1000

/** 形状由 schema 管，这里管的是数值说不说得通：负数、零容量、可用量大过总量、来自未来。 */
function isPlausibleHostSample(sample: HostSample): boolean {
  const counts = [
    sample.disk_total_bytes,
    sample.disk_available_bytes,
    sample.mem_total_bytes,
    sample.mem_available_bytes,
  ]
  if (!counts.every((value) => Number.isSafeInteger(value) && value >= 0)) return false
  if (sample.disk_total_bytes === 0 || sample.mem_total_bytes === 0) return false
  if (sample.disk_available_bytes > sample.disk_total_bytes) return false
  if (sample.mem_available_bytes > sample.mem_total_bytes) return false
  const optionalCounts = [sample.swap_total_bytes, sample.swap_free_bytes, sample.cpu_count]
  if (
    !optionalCounts.every((value) => value == null || (Number.isSafeInteger(value) && value >= 0))
  )
    return false
  const ratio = sample.cpu_busy_ratio
  if (ratio != null && !(ratio >= 0 && ratio <= 1)) return false
  const loads = [sample.load_1, sample.load_5, sample.load_15]
  if (!loads.every((value) => value == null || (Number.isFinite(value) && value >= 0))) return false
  if (
    sample.booted_at != null &&
    !(Number.isSafeInteger(sample.booted_at) && sample.booted_at <= sample.sampled_at)
  )
    return false
  if (!(sample.containers ?? []).every(isPlausibleContainer)) return false
  return Number.isSafeInteger(sample.sampled_at) && sample.sampled_at <= Date.now() + CLOCK_SKEW_MS
}

function isPlausibleContainer(container: ContainerSample): boolean {
  if (!/^[0-9a-f]{64}$/.test(container.container_id)) return false
  if (!(Number.isSafeInteger(container.mem_bytes) && container.mem_bytes >= 0)) return false
  if (!(Number.isSafeInteger(container.oom_kills) && container.oom_kills >= 0)) return false
  const limit = container.mem_limit_bytes
  if (limit != null && !(Number.isSafeInteger(limit) && limit > 0)) return false
  const cores = container.cpu_cores
  return cores == null || (Number.isFinite(cores) && cores >= 0)
}

/** 一台机器上的容器数有限；再多只可能是坏数据或被人拿来灌库。 */
const MAX_CONTAINERS_PER_SAMPLE = 200

/** 运维看板要的、只有后端够得着的现状。读的部分经后台代理给运营者，写的部分只收采集容器的读数；都由内部令牌保护。 */
export const internalOpsRoutes = new Elysia({ prefix: '/internal/admin/ops' })
  .use(requireInternalService)
  .get('/backups', () => readBackups())
  .post(
    '/host-samples',
    async ({ body, status }) => {
      if (!isPlausibleHostSample(body)) return status(400, { error: 'invalid_host_sample' })
      const { containers = [], ...host } = body
      // 采集方重试时会带着同一个 sampled_at 再来一次；那是同一次读数，不是新的一行。
      await db.transaction(async (tx) => {
        await tx.insert(schema.host_samples).values(host).onConflictDoNothing()
        if (containers.length > 0) {
          await tx
            .insert(schema.container_samples)
            .values(containers.map((one) => ({ ...one, sampled_at: host.sampled_at })))
            .onConflictDoNothing()
        }
      })
      return status(204)
    },
    {
      body: t.Object({
        sampled_at: t.Number(),
        disk_total_bytes: t.Number(),
        disk_available_bytes: t.Number(),
        mem_total_bytes: t.Number(),
        mem_available_bytes: t.Number(),
        cpu_count: t.Optional(t.Nullable(t.Number())),
        cpu_busy_ratio: t.Optional(t.Nullable(t.Number())),
        load_1: t.Optional(t.Nullable(t.Number())),
        load_5: t.Optional(t.Nullable(t.Number())),
        load_15: t.Optional(t.Nullable(t.Number())),
        swap_total_bytes: t.Optional(t.Nullable(t.Number())),
        swap_free_bytes: t.Optional(t.Nullable(t.Number())),
        booted_at: t.Optional(t.Nullable(t.Number())),
        containers: t.Optional(
          t.Array(
            t.Object({
              container_id: t.String(),
              name: t.Nullable(t.String({ maxLength: 200 })),
              mem_bytes: t.Number(),
              mem_limit_bytes: t.Nullable(t.Number()),
              cpu_cores: t.Nullable(t.Number()),
              oom_kills: t.Number(),
            }),
            { maxItems: MAX_CONTAINERS_PER_SAMPLE },
          ),
        ),
      }),
    },
  )
