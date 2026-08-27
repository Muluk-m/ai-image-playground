import type { QueueProvider, TaskErrorType, TaskStatus } from '@image-playground/shared'
import type { StoredSubmitRequest, Task } from './schema'

export type PixelKind = 'input' | 'output'

export interface PixelObject {
  taskId: string
  kind: PixelKind
  idx: number
  mime: string
  data: Buffer
  createdAt: number
}

export type NewPixelObject = Omit<PixelObject, 'taskId' | 'createdAt'> & {
  createdAt?: number
}

export type SubmitOutcome =
  | { kind: 'replay'; id: string; submitted_at: number }
  | { kind: 'quota_rejected'; count: number; reset_at: string }
  | { kind: 'created'; id: string; submitted_at: number }

export interface SubmitCommand {
  provider: QueueProvider
  model: string
  request: StoredSubmitRequest
  clientRequestId: string | null
  deviceId: string
  n: number
  pixels: readonly NewPixelObject[]
}

export interface TaskFailPatch {
  error_message: string
  error_type: TaskErrorType
  completed_at: number
  upstream_status?: number | null
  upstream_body?: string | null
  result_payload?: Record<string, unknown>
}

export interface TaskStore {
  getById(id: string): Promise<Task | undefined>
  cancelFrom(id: string, from: 'queued' | 'in_progress'): Promise<boolean>
  claim(id: string, now: number): Promise<boolean>
  scheduleRetry(id: string, attemptJustFailed: number, nextRetryAt: number): Promise<boolean>
  complete(id: string, resultPayload: unknown, completedAt: number): Promise<boolean>
  fail(id: string, patch: TaskFailPatch): Promise<boolean>
  recoverInterrupted(now: number): Promise<number>
  listDueIds(provider: QueueProvider, now: number, limit: number): Promise<string[]>
  getStatuses(ids: readonly string[]): Promise<Array<{ id: string; status: TaskStatus }>>
  purgeOldTasks(threshold: number): Promise<number>
  listTerminalIdsWithNonWebpInputs(): Promise<string[]>
}

export interface PixelStore {
  putMany(taskId: string, pixels: readonly NewPixelObject[]): Promise<void>
  get(taskId: string, kind: PixelKind, idx: number): Promise<PixelObject | undefined>
  list(taskId: string, kind: PixelKind): Promise<PixelObject[]>
  replaceBytes(
    taskId: string,
    kind: PixelKind,
    idx: number,
    mime: string,
    data: Buffer,
  ): Promise<void>
  deleteOutputsOlderThan(cutoff: number): Promise<number>
}

export interface QueuePersistence {
  tasks: TaskStore
  pixels: PixelStore
  submit(command: SubmitCommand): Promise<SubmitOutcome>
  completeWithPixels(
    id: string,
    resultPayload: unknown,
    pixels: readonly NewPixelObject[],
    completedAt: number,
  ): Promise<boolean>
}
