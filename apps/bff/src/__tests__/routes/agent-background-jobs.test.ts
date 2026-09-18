import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import {
  type AgentBackgroundJobCancelResponse,
  type AgentBackgroundJobsResponse,
  type AgentMessageView,
  type AgentTurnEvent,
  DEVICE_ID_HEADER,
  projectArtifactId,
} from '@image-playground/shared'
import { eq } from 'drizzle-orm'
import { Elysia } from 'elysia'
import {
  type AgentCall,
  completionStream,
  controlledCompletion,
  eventsOfType,
  parseFrames,
  readFrames,
  recordingAgentFetch,
  scriptedAgentFetch,
  TEST_IMAGE_CHANNEL,
  TEST_RESULT_PAYLOAD,
  toolCallCompletion,
} from '../helpers/agentStubs'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'

process.env.DATABASE_URL = await resetTestDatabase('agent_background_jobs_a612')
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.UPSTREAM_OPENAI_API_KEY = ''
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../agent-operator-config.json')

// Dynamic imports keep environment setup ahead of modules that capture configuration.
const { agentRoutes } = await import('../../routes/agent')
const { setAgentFetchForTesting } = await import('../../lib/agent/model')
const { setQueueTaskPollingForTesting } = await import('../../lib/taskSubmission')
const { _setChannelsForTesting } = await import('../../lib/channels')
const { setObjectStoreForTesting } = await import('../../lib/objectStore')
const { close: closeDb, db, schema } = await import('../../db/client')
const { _setPrivateBffOverlayForTesting, EMPTY_PRIVATE_BFF_OVERLAY } = await import(
  '../../lib/private-overlay'
)
// 取消按原桶退回：退款发生在 overlay 的 finalizeTask 里，这里记下它被叫了几次、以什么结局。
const finalized: { taskId: string; outcome: string }[] = []
_setPrivateBffOverlayForTesting(
  Object.freeze({
    ...EMPTY_PRIVATE_BFF_OVERLAY,
    taskHooks: {
      ...EMPTY_PRIVATE_BFF_OVERLAY.taskHooks,
      async finalizeTask({ taskId, outcome }: { taskId: string; outcome: string }) {
        finalized.push({ taskId, outcome })
      },
    },
  }),
)

const app = new Elysia().use(agentRoutes)
const DEVICE = 'device-abcdefgh'

function request(path: string, init: { method?: string; body?: unknown; device?: string } = {}) {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method: init.method ?? 'GET',
      headers: {
        'content-type': 'application/json',
        [DEVICE_ID_HEADER]: init.device ?? DEVICE,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
  )
}

async function startConversation(): Promise<string> {
  const response = await request('/api/agent/conversations', {
    method: 'POST',
    body: { deviceId: DEVICE },
  })
  expect(response.status).toBe(200)
  return ((await response.json()) as { conversation: { id: string } }).conversation.id
}

function turnRequest(conversationId: string, text: string) {
  return request(`/api/agent/conversations/${conversationId}/turns`, {
    method: 'POST',
    body: { deviceId: DEVICE, text },
  })
}

async function runTurn(conversationId: string, text: string) {
  return parseFrames(await (await turnRequest(conversationId, text)).text())
}

async function readJobs(conversationId: string): Promise<AgentBackgroundJobsResponse['jobs']> {
  const response = await request(`/api/agent/conversations/${conversationId}/jobs`)
  expect(response.status).toBe(200)
  return ((await response.json()) as AgentBackgroundJobsResponse).jobs
}

async function readMessages(conversationId: string): Promise<AgentMessageView[]> {
  const response = await request(`/api/agent/conversations/${conversationId}/messages`)
  return ((await response.json()) as { messages: AgentMessageView[] }).messages
}

function types(frames: { event: AgentTurnEvent }[]): string[] {
  return frames.map((frame) => frame.event.type)
}

async function onlyTask() {
  const tasks = await db.select().from(schema.tasks)
  expect(tasks).toHaveLength(1)
  return tasks[0]!
}

/** 测试里的迷你 worker：一次性把排着的任务推到终态，就像它在轮结束之后才跑完。 */
async function finishTask(taskId: string, outcome: 'completed' | 'failed' | 'in_progress') {
  const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId))
  await db
    .update(schema.tasks)
    .set(
      outcome === 'completed'
        ? {
            status: 'completed',
            result_payload: {
              data: Array.from(
                { length: task!.request_payload.n ?? 1 },
                () => TEST_RESULT_PAYLOAD.data[0]!,
              ),
            },
            completed_at: Date.now(),
          }
        : outcome === 'failed'
          ? {
              status: 'failed',
              error_message: '上游超时',
              error_type: 'upstream_timeout',
              completed_at: Date.now(),
            }
          : { status: 'in_progress', started_at: Date.now() },
    )
    .where(eq(schema.tasks.id, taskId))
}

function generateCall(n = 1) {
  return toolCallCompletion({
    id: 'call-1',
    name: 'generateImage',
    args: { prompt: '一只橘猫坐在窗台上', n },
  })
}

beforeEach(async () => {
  _setChannelsForTesting([TEST_IMAGE_CHANNEL])
  setObjectStoreForTesting(new InMemoryObjectStore())
  // 等结果的路径若被误走，预算一过就会以超时失败收场，断言立刻看得出来。
  setQueueTaskPollingForTesting({ intervalMs: 2, budgetMs: 200 })
  await db.delete(schema.tasks)
  await db.delete(schema.agent_conversations)
  finalized.length = 0
})

afterEach(() => {
  setAgentFetchForTesting()
  setQueueTaskPollingForTesting()
  setObjectStoreForTesting()
})

afterAll(async () => {
  await closeDb()
})

describe('生成改为后台任务', () => {
  it('hands the conversation back as soon as the task is submitted', async () => {
    const calls: AgentCall[] = []
    setAgentFetchForTesting(
      scriptedAgentFetch(calls, [() => generateCall(2), () => completionStream('已开始出 2 张')]),
    )
    const conversationId = await startConversation()

    // 没有 worker：任务一直排着，轮照样收尾。
    const frames = await runTurn(conversationId, '画两张橘猫')

    expect(types(frames)).toEqual([
      'turnStart',
      'toolStart',
      'toolEnd',
      'assistantStart',
      'textDelta',
      'turnEnd',
    ])
    expect(frames.at(-1)?.event).toMatchObject({ type: 'turnEnd', stopReason: 'completed' })
    const task = await onlyTask()
    expect(task.status).toBe('queued')
    const [end] = eventsOfType(frames, 'toolEnd')
    expect(end).toMatchObject({
      toolCallId: 'call-1',
      status: 'submitted',
      job: { taskId: task.id, media: 'image' },
    })
    expect(end!.artifacts).toBeUndefined()

    // 模型收到的是「已提交、结果尚未就绪」，不是一个可以顺口说「画好了」的结果。
    const toolResult = JSON.stringify(calls[1]!.messages.at(-1))
    expect(toolResult).toContain('结果尚未就绪')
    expect(toolResult).toContain(task.id)
  })

  it('tells the model in the system prompt and tool description not to claim unfinished results', async () => {
    const calls: AgentCall[] = []
    setAgentFetchForTesting(scriptedAgentFetch(calls, [() => completionStream('好的')]))
    const conversationId = await startConversation()

    await runTurn(conversationId, '你好')

    const system = JSON.stringify(calls[0]!.messages[0]!.content)
    expect(system).toContain('结果出来之前不得宣称已经完成')
    const tools = JSON.stringify(calls[0]!.tools)
    expect(tools).toContain('返回时结果尚未就绪')
  })

  it('delivers the finished task to the job list, the snapshot and the next turn', async () => {
    const calls: AgentCall[] = []
    setAgentFetchForTesting(
      scriptedAgentFetch(calls, [
        () => generateCall(2),
        () => completionStream('已开始'),
        () => completionStream('看到了'),
      ]),
    )
    const conversationId = await startConversation()
    const frames = await runTurn(conversationId, '画两张橘猫')
    const [end] = eventsOfType(frames, 'toolEnd')
    const task = await onlyTask()

    const pending = await readJobs(conversationId)
    expect(pending).toEqual([
      expect.objectContaining({ messageId: end!.messageId, result: expect.anything() }),
    ])
    expect(pending[0]!.result.status).toBe('submitted')

    await finishTask(task.id, 'completed')

    const [done] = await readJobs(conversationId)
    expect(done!.result).toMatchObject({
      status: 'succeeded',
      toolCallId: 'call-1',
      job: { taskId: task.id },
    })
    expect(done!.result.artifacts?.map((artifact) => artifact.artifactId)).toEqual([
      projectArtifactId(task.id, 0),
      projectArtifactId(task.id, 1),
    ])
    const snapshot = await readMessages(conversationId)
    expect(snapshot.find((message) => message.id === end!.messageId)?.content).toEqual([
      done!.result,
    ])

    // 终局写回了消息：任务行过了保留期被清掉，结果照样在。
    await db.delete(schema.tasks)
    const [kept] = await readJobs(conversationId)
    expect(kept!.result).toEqual(done!.result)

    // 没有唤醒：用户下次说话时，模型在对话记录里看到结果。
    await runTurn(conversationId, '效果怎么样')
    // 系统提示词里也有「结果尚未就绪」那句规矩，只看回放的对话记录。
    const replay = JSON.stringify(calls[2]!.messages.slice(1))
    expect(replay).toContain(`完成，图片 ${projectArtifactId(task.id, 0)}`)
    expect(replay).not.toContain('结果尚未就绪')
  })

  it('settles a finished task before the retention purge even if nobody read the conversation', async () => {
    const calls: AgentCall[] = []
    setAgentFetchForTesting(
      scriptedAgentFetch(calls, [
        () => generateCall(),
        () => completionStream('已开始'),
        () => completionStream('看到了'),
      ]),
    )
    const conversationId = await startConversation()
    await runTurn(conversationId, '画一只橘猫')
    const task = await onlyTask()

    // 用户关掉页面，任务跑完，过了保留期才被清：清之前没有任何人读过这个会话。
    await finishTask(task.id, 'completed')
    const { purgeOldTasks } = await import('../../db/maintenance')
    expect(await purgeOldTasks(-1)).toBe(1)
    expect(await db.select().from(schema.tasks)).toHaveLength(0)

    const [job] = await readJobs(conversationId)
    expect(job!.result).toMatchObject({ status: 'succeeded', job: { taskId: task.id } })
    expect(job!.result.artifacts?.map((artifact) => artifact.artifactId)).toEqual([
      projectArtifactId(task.id, 0),
    ])

    await runTurn(conversationId, '效果怎么样')
    const replay = JSON.stringify(calls[2]!.messages.slice(1))
    expect(replay).toContain(`完成，图片 ${projectArtifactId(task.id, 0)}`)
    expect(replay).not.toContain('任务丢失了')
  })

  it('does not purge a task that is still running for the conversation', async () => {
    setAgentFetchForTesting(
      scriptedAgentFetch([], [() => generateCall(), () => completionStream('已开始')]),
    )
    const conversationId = await startConversation()
    await runTurn(conversationId, '画一只橘猫')
    const task = await onlyTask()
    await finishTask(task.id, 'in_progress')

    const { purgeOldTasks } = await import('../../db/maintenance')
    expect(await purgeOldTasks(-1)).toBe(0)
    expect((await readJobs(conversationId))[0]!.result.status).toBe('submitted')
  })

  it('settles a failed task with its error code and keeps a running one pending', async () => {
    setAgentFetchForTesting(
      scriptedAgentFetch([], [() => generateCall(), () => completionStream('已开始')]),
    )
    const conversationId = await startConversation()
    await runTurn(conversationId, '画一只橘猫')
    const task = await onlyTask()

    await finishTask(task.id, 'in_progress')
    expect((await readJobs(conversationId))[0]!.result.status).toBe('submitted')

    await finishTask(task.id, 'failed')
    const [failed] = await readJobs(conversationId)
    expect(failed!.result).toMatchObject({ status: 'failed', errorCode: 'timeout' })
    expect(failed!.result.artifacts).toBeUndefined()
  })

  it('does not cancel the submitted task when the reply is stopped', async () => {
    const calls: AgentCall[] = []
    const reply = controlledCompletion()
    let at = 0
    const answers = [() => generateCall(), (signal?: AbortSignal) => reply.responseFor(signal)]
    setAgentFetchForTesting(recordingAgentFetch(calls, (signal) => answers[at++]!(signal)))
    const conversationId = await startConversation()

    const response = await turnRequest(conversationId, '画一只橘猫')
    // 读到工具收尾那一帧：任务已经提交，轮还在等下一句回复。
    const seen = await readFrames(response, 3)
    expect(types(seen)).toEqual(['turnStart', 'toolStart', 'toolEnd'])
    const turnId = eventsOfType(seen, 'turnStart')[0]!.turnId

    const stopped = await request(
      `/api/agent/conversations/${conversationId}/turns/${turnId}/abort`,
      {
        method: 'POST',
        body: { deviceId: DEVICE },
      },
    )
    expect(stopped.status).toBe(200)
    for (let i = 0; i < 200; i++) {
      const [summary] = await db
        .select()
        .from(schema.agent_turns)
        .where(eq(schema.agent_turns.turn_id, turnId))
      if (summary) break
      await Bun.sleep(5)
    }

    const task = await onlyTask()
    expect(task.status).toBe('queued')
    expect((await readJobs(conversationId))[0]!.result.status).toBe('submitted')
  })

  it('cancels unfinished tasks when the conversation is deleted', async () => {
    setAgentFetchForTesting(
      scriptedAgentFetch([], [() => generateCall(), () => completionStream('已开始')]),
    )
    const conversationId = await startConversation()
    await runTurn(conversationId, '画一只橘猫')
    const task = await onlyTask()
    expect(task.status).toBe('queued')

    const deleted = await request(`/api/agent/conversations/${conversationId}`, {
      method: 'DELETE',
      body: { deviceId: DEVICE },
    })
    expect(deleted.status).toBe(200)

    const [after] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, task.id))
    expect(after!.status).toBe('cancelled')
  })
})

function cancelJob(conversationId: string, taskId: string, device?: string) {
  return request(`/api/agent/conversations/${conversationId}/jobs/${taskId}/cancel`, {
    method: 'POST',
    ...(device ? { device } : {}),
  })
}

describe('后台任务的进度与取消', () => {
  it('reports the stage and submission time of an unfinished job from the task table', async () => {
    setAgentFetchForTesting(
      scriptedAgentFetch([], [() => generateCall(), () => completionStream('已开始')]),
    )
    const conversationId = await startConversation()
    await runTurn(conversationId, '画一只橘猫')
    const task = await onlyTask()

    // 排着队：阶段是「已提交」，已用时间从任务受理那一刻算，谁来读都是同一个起点。
    const [queued] = await readJobs(conversationId)
    expect(queued!.progress).toEqual({ stage: 'submitted', submittedAt: task.submitted_at })

    await finishTask(task.id, 'in_progress')
    const [running] = await readJobs(conversationId)
    expect(running!.progress).toEqual({ stage: 'running', submittedAt: task.submitted_at })

    await finishTask(task.id, 'completed')
    const [done] = await readJobs(conversationId)
    expect(done!.result.status).toBe('succeeded')
    expect(done!.progress).toBeUndefined()
  })

  it('cancels one job on request, refunds it and shows the cancelled outcome everywhere', async () => {
    setAgentFetchForTesting(
      scriptedAgentFetch([], [() => generateCall(), () => completionStream('已开始')]),
    )
    const conversationId = await startConversation()
    const frames = await runTurn(conversationId, '画一只橘猫')
    const [end] = eventsOfType(frames, 'toolEnd')
    const task = await onlyTask()
    await finishTask(task.id, 'in_progress')

    const response = await cancelJob(conversationId, task.id)
    expect(response.status).toBe(200)
    const { job } = (await response.json()) as AgentBackgroundJobCancelResponse
    expect(job).toMatchObject({
      messageId: end!.messageId,
      result: { status: 'failed', errorCode: 'cancelled', job: { taskId: task.id } },
    })
    expect(job.progress).toBeUndefined()

    const [after] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, task.id))
    expect(after!.status).toBe('cancelled')
    expect(finalized).toEqual([{ taskId: task.id, outcome: 'cancelled' }])

    // 换一台设备、刷新之后读到的是同一个结局。
    const [listed] = await readJobs(conversationId)
    expect(listed!.result).toEqual(job.result)
    const snapshot = await readMessages(conversationId)
    expect(snapshot.find((message) => message.id === end!.messageId)?.content).toEqual([job.result])

    // 再点一次（或另一台设备同时点）不会再退一次。
    const again = await cancelJob(conversationId, task.id)
    expect(again.status).toBe(200)
    expect(((await again.json()) as AgentBackgroundJobCancelResponse).job.result).toEqual(
      job.result,
    )
    expect(finalized).toHaveLength(1)
  })

  it('leaves a finished job alone when cancelled late', async () => {
    setAgentFetchForTesting(
      scriptedAgentFetch([], [() => generateCall(), () => completionStream('已开始')]),
    )
    const conversationId = await startConversation()
    await runTurn(conversationId, '画一只橘猫')
    const task = await onlyTask()
    await finishTask(task.id, 'completed')

    const response = await cancelJob(conversationId, task.id)
    expect(response.status).toBe(200)
    const { job } = (await response.json()) as AgentBackgroundJobCancelResponse
    expect(job.result.status).toBe('succeeded')
    expect(finalized).toEqual([])
  })

  it('refuses to cancel tasks that are not a job of this conversation', async () => {
    setAgentFetchForTesting(
      scriptedAgentFetch([], [() => generateCall(), () => completionStream('已开始')]),
    )
    const conversationId = await startConversation()
    await runTurn(conversationId, '画一只橘猫')
    const task = await onlyTask()

    expect((await cancelJob(conversationId, 'not-a-task')).status).toBe(404)
    // 别人的会话：连会话都找不到。
    expect((await cancelJob(conversationId, task.id, 'device-someoneelse')).status).toBe(404)

    const [after] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, task.id))
    expect(after!.status).toBe('queued')
    expect(finalized).toEqual([])
  })
})
