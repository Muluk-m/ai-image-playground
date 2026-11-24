import type { HostSample } from '@image-playground/shared'
import { db, schema } from '../db/client'

export async function recordHostSample(sample: HostSample): Promise<void> {
  const { containers = [], ...host } = sample
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
}
