import type { AgentOwner } from './conversations'

const pending = new Map<string, Promise<void>>()

/** The single BFF owns running turns; serialize preparation with deletion, not the turn lifetime. */
export async function withAgentLifecycle<T>(owner: AgentOwner, work: () => Promise<T>): Promise<T> {
  const key = owner.kind === 'user' ? `user:${owner.userId}` : `device:${owner.deviceId}`
  const previous = pending.get(key) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.then(() => gate)
  pending.set(key, tail)
  await previous
  try {
    return await work()
  } finally {
    release()
    if (pending.get(key) === tail) pending.delete(key)
  }
}
