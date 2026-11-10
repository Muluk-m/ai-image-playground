import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  activityFromCanvas,
  activityFromRecord,
  activityFromServerStatus,
  applyGenerationActivity,
  canvasProjection,
  GENERATION_EVENTS,
  GENERATION_PHASES,
  type GenerationActivity,
  generationActivityMachine,
  isGenerationOpen,
  projectGenerationActivity,
  reportEvent,
  showsGenerationTimer,
} from '../../lib/generationActivity'

const phases = GENERATION_PHASES
const events = GENERATION_EVENTS

describe('generation activity transitions', () => {
  it('covers every phase and event exactly once in the machine', () => {
    expect(generationActivityMachine.states).toEqual(phases)
    expect(generationActivityMachine.events).toEqual(events)
    for (const phase of phases) {
      for (const event of events) {
        const next = generationActivityMachine.tryStep(phase, event)
        if (next === undefined) {
          expect(generationActivityMachine.allows(phase, event)).toBe(false)
        } else {
          expect(generationActivityMachine.step(phase, event)).toBe(next)
          expect(phases).toContain(next)
        }
      }
    }
  })

  it('moves a live attempt through the server phases and into a terminal', () => {
    let activity: GenerationActivity = { phase: 'submitting' }
    activity = applyGenerationActivity(activity, 'report-queued')
    activity = applyGenerationActivity(activity, 'report-generating')
    activity = applyGenerationActivity(activity, 'report-reconnecting')
    activity = applyGenerationActivity(activity, 'report-confirming')
    activity = applyGenerationActivity(activity, 'report-reconciling')
    expect(applyGenerationActivity(activity, 'succeed')).toEqual({ phase: 'done' })
    expect(applyGenerationActivity({ phase: 'generating' }, 'fail')).toEqual({ phase: 'failed' })
    expect(applyGenerationActivity({ phase: 'queued' }, 'cancel')).toEqual({ phase: 'cancelled' })
  })

  it('releases a locally queued batch row before it can show a server phase', () => {
    const queued = { phase: 'batch-queued' as const }
    expect(applyGenerationActivity(queued, 'release')).toEqual({ phase: 'submitting' })
    expect(applyGenerationActivity(queued, reportEvent('generating'))).toBe(queued)
    expect(projectGenerationActivity(queued).batchQueued).toBe(true)
    expect(projectGenerationActivity(applyGenerationActivity(queued, 'release')).batchQueued).toBe(
      undefined,
    )
  })
})

describe('illegal generation transitions keep the current phase', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('ignores progress, failure, and success after the attempt already finished', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const breadcrumb = vi.fn()
    vi.stubGlobal('Sentry', { addBreadcrumb: breadcrumb })
    const done = { phase: 'done' as const }
    const cancelled = { phase: 'cancelled' as const }
    expect(applyGenerationActivity(done, reportEvent('generating'))).toBe(done)
    expect(applyGenerationActivity(cancelled, 'fail')).toBe(cancelled)
    expect(applyGenerationActivity(cancelled, 'succeed')).toBe(cancelled)
    expect(applyGenerationActivity({ phase: 'failed' }, reportEvent('queued'))).toEqual({
      phase: 'failed',
    })
    expect(warn).toHaveBeenCalled()
    expect(breadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'generation-activity', level: 'warning' }),
    )
    expect(projectGenerationActivity(done)).toMatchObject({
      status: 'done',
      queuePhase: undefined,
      batchQueued: undefined,
      cancelled: undefined,
    })
    expect(projectGenerationActivity(cancelled)).toMatchObject({
      status: 'error',
      cancelled: true,
      queuePhase: undefined,
    })
  })

  it('does not throw when the breadcrumb recorder throws', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.stubGlobal('Sentry', {
      addBreadcrumb: () => {
        throw new Error('sentry down')
      },
    })
    expect(applyGenerationActivity({ phase: 'done' }, 'retry')).toEqual({ phase: 'done' })
  })
})

describe('legacy flags fold into one phase', () => {
  it('drops a generating phase left on a finished or cancelled record', () => {
    expect(
      activityFromRecord({
        status: 'done',
        queuePhase: 'generating',
        batchQueued: true,
        cancelled: true,
      }),
    ).toEqual({ phase: 'done' })
    expect(
      activityFromRecord({ status: 'running', cancelled: true, queuePhase: 'generating' }),
    ).toEqual({ phase: 'cancelled' })
    expect(showsGenerationTimer({ phase: 'cancelled' })).toBe(false)
    expect(isGenerationOpen({ phase: 'cancelled' })).toBe(false)
  })

  it('keeps a locally queued batch row from looking like it is already generating', () => {
    expect(
      activityFromRecord({ status: 'running', batchQueued: true, queuePhase: 'generating' }),
    ).toEqual({ phase: 'batch-queued' })
  })

  it('retries a failed canvas placeholder without keeping the previous phase', () => {
    const failed = activityFromCanvas({
      status: 'error',
      meta: { queuePhase: 'confirming' },
    })
    const retried = applyGenerationActivity(failed, 'retry')
    expect(retried).toEqual({ phase: 'submitting' })
    expect(canvasProjection(retried)).toEqual({ status: 'loading', queuePhase: undefined })
    expect(canvasProjection({ phase: 'stale' }).status).toBe('stale')
  })

  it('lets a terminal status override a leftover in-progress activity', () => {
    expect(
      activityFromCanvas({
        status: 'error',
        meta: { activity: { phase: 'submitting' }, queuePhase: 'confirming' },
      }).phase,
    ).toBe('failed')
    expect(
      activityFromCanvas({
        status: 'stale',
        meta: { activity: { phase: 'generating' } },
      }).phase,
    ).toBe('stale')
    expect(
      activityFromCanvas({
        status: 'error',
        meta: { activity: { phase: 'cancelled' } },
      }).phase,
    ).toBe('cancelled')
    expect(activityFromRecord({ status: 'error', activity: { phase: 'queued' } }).phase).toBe(
      'failed',
    )
    expect(activityFromRecord({ status: 'done', activity: { phase: 'generating' } }).phase).toBe(
      'done',
    )
    expect(
      activityFromRecord({
        status: 'running',
        cancelled: true,
        activity: { phase: 'generating' },
      }).phase,
    ).toBe('cancelled')
    expect(activityFromRecord({ status: 'error', activity: { phase: 'stale' } }).phase).toBe(
      'stale',
    )
    expect(showsGenerationTimer({ phase: 'stale' })).toBe(false)
  })

  it('projects a server queued task as queued, and an in-progress task as generating', () => {
    expect(projectGenerationActivity(activityFromServerStatus('queued')).queuePhase).toBe('queued')
    expect(projectGenerationActivity(activityFromServerStatus('in_progress')).queuePhase).toBe(
      'generating',
    )
    expect(activityFromServerStatus('cancelled').phase).toBe('cancelled')
  })
})
