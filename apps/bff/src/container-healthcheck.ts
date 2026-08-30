import { unlink } from 'node:fs/promises'
import { type ContainerHealthState, runContainerHealthCheck } from './lib/container-health'

const [healthUrl, stateFile, failureLimitRaw, maxRestartsRaw, restartCooldownMsRaw] =
  Bun.argv.slice(2)

if (!healthUrl || !stateFile) {
  throw new Error(
    'Usage: container-healthcheck.ts <url> <state-file> <failure-limit> <max-restarts> <restart-cooldown-ms>',
  )
}
new URL(healthUrl)

function positiveInteger(raw: string | undefined, name: string): number {
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`)
  return value
}

const failureLimit = positiveInteger(failureLimitRaw, 'failure-limit')
const maxRestarts = positiveInteger(maxRestartsRaw, 'max-restarts')
const restartCooldownMs = positiveInteger(restartCooldownMsRaw, 'restart-cooldown-ms')

async function loadState(): Promise<ContainerHealthState | null> {
  const file = Bun.file(stateFile)
  if (!(await file.exists())) return null
  try {
    const state = JSON.parse(await file.text()) as Partial<ContainerHealthState>
    if (
      !Number.isInteger(state.consecutiveFailures) ||
      (state.consecutiveFailures ?? -1) < 0 ||
      !Number.isInteger(state.restartCount) ||
      (state.restartCount ?? -1) < 0 ||
      (state.lastRestartAt !== null && !Number.isFinite(state.lastRestartAt))
    ) {
      return null
    }
    return state as ContainerHealthState
  } catch {
    return null
  }
}

async function clearState(): Promise<void> {
  try {
    await unlink(stateFile)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

const result = await runContainerHealthCheck({
  failureLimit,
  maxRestarts,
  restartCooldownMs,
  now: Date.now,
  check: async () => {
    try {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(4_000) })
      return response.ok
    } catch {
      return false
    }
  },
  loadState,
  saveState: async (state) => {
    await Bun.write(stateFile, JSON.stringify(state))
  },
  clearState,
  restart: async () => {
    const children = (await Bun.file('/proc/1/task/1/children').text())
      .trim()
      .split(/\s+/)
      .map(Number)
      .filter(Number.isInteger)
    const applicationPid = children[0]
    if (!applicationPid) throw new Error('container application process not found')
    process.kill(applicationPid, 'SIGKILL')
  },
})

if (result !== 'healthy') {
  console.error(
    JSON.stringify({
      event: 'container.health_failed',
      healthUrl,
      result,
    }),
  )
  process.exitCode = 1
}
