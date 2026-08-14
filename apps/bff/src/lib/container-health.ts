export interface ContainerHealthState {
  consecutiveFailures: number
  restartCount: number
  lastRestartAt: number | null
}

export type ContainerHealthResult =
  | 'healthy'
  | 'failed'
  | 'cooldown'
  | 'restarted'
  | 'restart_limit_reached'

interface ContainerHealthCheckOptions {
  failureLimit: number
  maxRestarts: number
  restartCooldownMs: number
  now: () => number
  check: () => Promise<boolean>
  loadState: () => Promise<ContainerHealthState | null>
  saveState: (state: ContainerHealthState) => Promise<void>
  clearState: () => Promise<void>
  restart: () => Promise<void>
}

const EMPTY_STATE: ContainerHealthState = {
  consecutiveFailures: 0,
  restartCount: 0,
  lastRestartAt: null,
}

export async function runContainerHealthCheck(
  options: ContainerHealthCheckOptions,
): Promise<ContainerHealthResult> {
  if (await options.check()) {
    await options.clearState()
    return 'healthy'
  }

  const previous = (await options.loadState()) ?? EMPTY_STATE
  const failed: ContainerHealthState = {
    ...previous,
    consecutiveFailures: previous.consecutiveFailures + 1,
  }
  if (failed.consecutiveFailures < options.failureLimit) {
    await options.saveState(failed)
    return 'failed'
  }

  if (failed.restartCount >= options.maxRestarts) {
    await options.saveState({
      ...failed,
      consecutiveFailures: options.failureLimit,
    })
    return 'restart_limit_reached'
  }

  const now = options.now()
  if (failed.lastRestartAt !== null && now - failed.lastRestartAt < options.restartCooldownMs) {
    await options.saveState({
      ...failed,
      consecutiveFailures: options.failureLimit,
    })
    return 'cooldown'
  }

  await options.saveState({
    consecutiveFailures: 0,
    restartCount: failed.restartCount + 1,
    lastRestartAt: now,
  })
  await options.restart()
  return 'restarted'
}
