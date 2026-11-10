import { describe, expect, it } from 'bun:test'
import type { AgentToolStatus } from '../agent'
import { agentBatch, agentBatchConfirmEvent } from '../machines/agent-batch'
import { AGENT_INBOX_CREATED, agentInbox } from '../machines/agent-inbox'
import { agentTool } from '../machines/agent-tool'
import {
  announcementPublication,
  announcementPublishEvent,
  canReviseAnnouncement,
} from '../machines/announcement'
import { deviceAuthorization, deviceDecisionEvent } from '../machines/device-authorization'
import { inspirationPublication, inspirationStatusEvent } from '../machines/inspiration'
import { mediaObject } from '../machines/media-object'
import { projectCliJobStatus, queueTask } from '../machines/queue-task'
import { TASK_PROGRESS_PHASES, type TaskStatus } from '../queue-protocol'
import { defineMachine, IllegalTransitionError, type StateMachine } from '../state-machine'

type AnyMachine = StateMachine<string, string>

function assertMachine(machine: AnyMachine) {
  const states = new Set(machine.states)
  expect(states.size).toBe(machine.states.length)
  for (const from of machine.states) {
    for (const event of machine.events) {
      const next = machine.tryStep(from, event)
      if (next === undefined) {
        expect(() => machine.step(from, event)).toThrow(IllegalTransitionError)
      } else {
        expect(states.has(next)).toBe(true)
        expect(machine.step(from, event)).toBe(next)
        expect(machine.allows(from, event)).toBe(true)
      }
    }
  }
}

describe('defineMachine', () => {
  it('rejects an edge that leaves the state set at definition time', () => {
    expect(() =>
      defineMachine({
        id: 'sample',
        states: ['a', 'b'] as const,
        events: ['go'] as const,
        transitions: { a: { go: 'nope' }, b: {} },
      } as never),
    ).toThrow('nope')
  })

  it('target requires one shared destination', () => {
    const machine = defineMachine({
      id: 'fork',
      states: ['a', 'b'] as const,
      events: ['go'] as const,
      transitions: { a: { go: 'a' }, b: { go: 'b' } },
    })
    expect(() => machine.target('go')).toThrow(IllegalTransitionError)
  })
})

describe('domain machines', () => {
  const machines: AnyMachine[] = [
    announcementPublication,
    inspirationPublication,
    deviceAuthorization,
    agentInbox,
    queueTask,
    agentTool,
    mediaObject,
    agentBatch,
  ]

  it('every edge stays inside the declared states', () => {
    for (const machine of machines) assertMachine(machine)
  })

  it('covers the agent tool status union', () => {
    type Missing = Exclude<AgentToolStatus, (typeof agentTool.states)[number]>
    const missing: Missing extends never ? true : never = true
    expect(missing).toBe(true)
  })
})

describe('announcement publication', () => {
  it('publishes now or later, and archived cannot be revised', () => {
    expect(announcementPublishEvent(20, 10)).toBe('schedule')
    expect(announcementPublishEvent(10, 10)).toBe('publish')
    expect(announcementPublication.step('draft', 'schedule')).toBe('scheduled')
    expect(announcementPublication.step('published', 'unpublish')).toBe('draft')
    expect(announcementPublication.step('archived', 'archive')).toBe('archived')
    expect(canReviseAnnouncement('published')).toBe(true)
    expect(canReviseAnnouncement('archived')).toBe(false)
  })
})

describe('inspiration publication', () => {
  it('allows every status write that the admin API already accepts', () => {
    for (const from of inspirationPublication.states) {
      for (const to of inspirationPublication.states) {
        expect(inspirationPublication.step(from, inspirationStatusEvent(to))).toBe(to)
      }
    }
  })

  it('refuses to delete a published item', () => {
    expect(inspirationPublication.allows('draft', 'remove')).toBe(true)
    expect(inspirationPublication.allows('archived', 'remove')).toBe(true)
    expect(inspirationPublication.allows('published', 'remove')).toBe(false)
  })
})

describe('device authorization', () => {
  it('approves, denies, then consumes only an approval', () => {
    expect(deviceDecisionEvent('approved')).toBe('approve')
    expect(deviceAuthorization.step('pending', 'approve')).toBe('approved')
    expect(deviceAuthorization.step('pending', 'deny')).toBe('denied')
    expect(deviceAuthorization.step('approved', 'consume')).toBe('consumed')
    expect(deviceAuthorization.allows('denied', 'consume')).toBe(false)
    expect(deviceAuthorization.allows('pending', 'consume')).toBe(false)
  })
})

describe('agent inbox', () => {
  it('matches the write sites', () => {
    expect(AGENT_INBOX_CREATED.queued).toBe('pending')
    expect(AGENT_INBOX_CREATED.preempted).toBe('cancelled')
    expect(agentInbox.step('pending', 'fail')).toBe('failed')
    expect(agentInbox.step('pending', 'consume')).toBe('consumed')
    expect(agentInbox.target('withdraw')).toBe('cancelled')
    expect(agentInbox.target('return')).toBe('cancelled')
    expect(agentInbox.step('consumed', 'requeue')).toBe('pending')
    expect(agentInbox.allows('consumed', 'withdraw')).toBe(false)
    expect(agentInbox.allows('cancelled', 'consume')).toBe(false)
  })
})

describe('queue task', () => {
  it('encodes the worker, recovery, and terminal edges', () => {
    expect(queueTask.step('queued', 'claim')).toBe('in_progress')
    expect(queueTask.step('in_progress', 'retry')).toBe('queued')
    expect(queueTask.step('in_progress', 'resume_poll')).toBe('queued')
    expect(queueTask.step('in_progress', 'retry_archive')).toBe('queued')
    expect(queueTask.step('in_progress', 'reconcile')).toBe('reconciling')
    expect(queueTask.step('queued', 'reconcile')).toBe('reconciling')
    expect(queueTask.step('in_progress', 'succeed')).toBe('completed')
    expect(queueTask.step('reconciling', 'fail')).toBe('failed')
    expect(queueTask.step('reconciling', 'cancel')).toBe('cancelled')
    expect(queueTask.step('reconciling', 'resume')).toBe('in_progress')
    expect(queueTask.target('cancel')).toBe('cancelled')
    expect(queueTask.target('reconcile')).toBe('reconciling')
    expect(queueTask.allows('completed', 'retry')).toBe(false)
    expect(queueTask.allows('queued', 'succeed')).toBe(false)
  })

  it('projects every task status and phase onto the CLI vocabulary', () => {
    const seen = new Set<string>()
    for (const status of queueTask.states) {
      for (const phase of TASK_PROGRESS_PHASES) {
        seen.add(projectCliJobStatus(status, phase))
      }
    }
    expect([...seen].sort()).toEqual([
      'canceled',
      'failed',
      'persisting',
      'queued',
      'running',
      'succeeded',
    ])
    expect(projectCliJobStatus('completed', 'confirming')).toBe('succeeded')
    expect(projectCliJobStatus('queued', 'queued')).toBe('queued')
    expect(projectCliJobStatus('queued', 'reconnecting')).toBe('running')
    expect(projectCliJobStatus('in_progress', 'confirming')).toBe('persisting')
    expect(projectCliJobStatus('reconciling', 'reconciling')).toBe('running')
    expect(projectCliJobStatus('cancelled', 'generating')).toBe('canceled')
    const status: TaskStatus = 'failed'
    expect(projectCliJobStatus(status, 'queued')).toBe('failed')
  })
})

describe('agent tool, media, and batch', () => {
  it('moves a tool card from draft to a terminal job', () => {
    expect(agentTool.step('awaiting_confirmation', 'confirm')).toBe('submitted')
    expect(agentTool.step('awaiting_confirmation', 'void')).toBe('failed')
    expect(agentTool.step('queued', 'submit')).toBe('submitted')
    expect(agentTool.step('queued', 'withdraw')).toBe('failed')
    expect(agentTool.step('submitted', 'succeed')).toBe('succeeded')
    expect(agentTool.step('submitted', 'fail')).toBe('failed')
    expect(agentTool.allows('succeeded', 'fail')).toBe(false)
    expect(agentTool.allows('failed', 'submit')).toBe(false)
  })

  it('publishes pending media and reclaims stored objects', () => {
    expect(mediaObject.step('pending', 'publish')).toBe('ready')
    expect(mediaObject.target('reclaim')).toBe('deleting')
    expect(mediaObject.allows('ready', 'publish')).toBe(false)
    expect(mediaObject.allows('deleting', 'publish')).toBe(false)
  })

  it('confirms, pauses, and closes a batch', () => {
    expect(agentBatch.step('draft', agentBatchConfirmEvent(false))).toBe('running')
    expect(agentBatch.step('draft', agentBatchConfirmEvent(true))).toBe('paused')
    expect(agentBatch.step('paused', 'confirm')).toBe('running')
    expect(agentBatch.target('pause')).toBe('paused')
    expect(agentBatch.target('resume')).toBe('running')
    expect(agentBatch.target('close')).toBe('closed')
    expect(agentBatch.target('cancel')).toBe('cancelled')
    expect(agentBatch.allows('closed', 'resume')).toBe(false)
    expect(agentBatch.allows('running', 'confirm')).toBe(false)
    expect(agentBatch.allows('running', 'cancel')).toBe(false)
    expect(agentBatch.allows('closed', 'cancel')).toBe(false)
    expect(agentBatch.step('draft', 'pause')).toBe('paused')
    expect(agentBatch.step('cancelled', 'pause')).toBe('paused')
    expect(agentBatch.allows('closed', 'pause')).toBe(false)
  })
})
