import type { HydratedSubmitRequest } from '../../imageArchive'
import type { ConcurrencyGate } from '../concurrency'
import type { UpstreamRoute } from '../routes'
import type { UpstreamCallResult } from '../shared'
import type { UpstreamTransportSession } from '../transport'
import type { UpstreamCallParams } from '../types'

export interface UpstreamExecutionContext {
  readonly params: UpstreamCallParams
  readonly route: UpstreamRoute
  readonly request: HydratedSubmitRequest
  readonly useNativeN: boolean
  readonly session: UpstreamTransportSession
  readonly concurrencyGate: ConcurrencyGate
}

export interface UpstreamExecutor {
  readonly id: string
  matches(ctx: Pick<UpstreamExecutionContext, 'params' | 'route'>): boolean
  execute(ctx: UpstreamExecutionContext): Promise<UpstreamCallResult>
}
