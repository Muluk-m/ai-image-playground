import {
  type AgentConversationSnapshot,
  type AgentToolResultBlock,
  DEVICE_ID_HEADER,
  USER_SESSION_COOKIE,
} from '@image-playground/shared'
import type { CaseTurn } from './cases'
import { localIsoDate, UNKNOWN_MODEL, type VerificationRun } from './record'

/**
 * 跑图脚本的核心：像浏览器一样走一遍 BFF 的智能体接口，不经界面。
 *
 * 一次跑图 = 新开一个会话 → 发一条 `/技能名 …` 并附上参考图（出图模式，拟好稿当场提交）→
 * 轮询会话直到没有轮在跑、没有任务在排、连续几次都不再变化 → 取最后一张成功产出的图。
 * 智能体复核后自己改一版也算在内：取的是这一轮对话最后交出来的那张。
 *
 * 网络全部经注入的 `fetch`，测试与 `--mock` 用 {@link createFakeBff} 代替真实 BFF。
 */

export interface RunnerOptions {
  /** BFF 的 API 地址，例如 `https://api.example.com`。 */
  readonly baseUrl: string
  /** 登录会话 cookie 的值；开了计费的部署必须带，匿名可用的部署可以不带。 */
  readonly sessionCookie?: string
  /** 匿名设备 ID，8–64 个字符。 */
  readonly deviceId: string
  readonly fetch: (input: string, init?: RequestInit) => Promise<Response>
  readonly sleep?: (ms: number) => Promise<void>
  /** 轮询间隔，默认 10 秒。 */
  readonly pollIntervalMs?: number
  /** 空闲连续几次才算真的结束（智能体复核后可能再出一版），默认 3 次。 */
  readonly settlePolls?: number
  /** 单次跑图的上限，默认 20 分钟。 */
  readonly timeoutMs?: number
  readonly now?: () => Date
}

export interface RunInput {
  readonly skill: string
  readonly caseId: string
  readonly run: number
  readonly turn: CaseTurn
  /** 与 `turn.images` 一一对应的图片字节。 */
  readonly images: readonly { readonly mime: string; readonly bytes: Uint8Array }[]
  /** 钉死的生成模型（预置模板）；缺席即部署默认模型。 */
  readonly model?: string
}

export interface RunOutput {
  /** 写进验证记录的那一条（`output` 由调用方按落盘位置填）。 */
  readonly run: Omit<VerificationRun, 'output'>
  /** 产出图；没出图是 null。 */
  readonly image: { readonly mime: string; readonly bytes: Uint8Array } | null
}

/** 生成类工具：它们的成功结果带图片产物。 */
const GENERATION_TOOLS = new Set(['generateImage', 'editImage'])
/** 还没有结局的工具状态。 */
const PENDING = new Set(['submitted', 'queued'])

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

function toolResults(snapshot: AgentConversationSnapshot): AgentToolResultBlock[] {
  return snapshot.messages.flatMap((message) =>
    message.content.filter((block): block is AgentToolResultBlock => block.type === 'toolResult'),
  )
}

/** 这一刻会话的指纹：没变化的连续几次才算这一轮对话真的收尾了。 */
function fingerprint(snapshot: AgentConversationSnapshot): string {
  return JSON.stringify(
    toolResults(snapshot).map((block) => [block.toolCallId, block.status, block.artifacts?.length]),
  )
}

function isIdle(snapshot: AgentConversationSnapshot): boolean {
  return (
    snapshot.activeTurn === null &&
    (snapshot.queue ?? []).length === 0 &&
    !toolResults(snapshot).some((block) => PENDING.has(block.status))
  )
}

export class RunnerError extends Error {}

async function expectOk(response: Response, what: string): Promise<Response> {
  if (response.ok) return response
  const body = await response.text().catch(() => '')
  throw new RunnerError(`${what} 失败：HTTP ${response.status} ${body.slice(0, 300)}`)
}

/** 跑一次：一组测试输入的第 `run` 次。网络或接口错误抛 {@link RunnerError}，没出图不抛。 */
export async function runVerificationCase(
  options: RunnerOptions,
  input: RunInput,
): Promise<RunOutput> {
  const sleep = options.sleep ?? defaultSleep
  const now = options.now ?? (() => new Date())
  const interval = options.pollIntervalMs ?? 10_000
  const settlePolls = options.settlePolls ?? 3
  const deadline = now().getTime() + (options.timeoutMs ?? 20 * 60_000)
  const base = options.baseUrl.replace(/\/+$/, '')
  const headers: Record<string, string> = {
    [DEVICE_ID_HEADER]: options.deviceId,
    ...(options.sessionCookie ? { cookie: `${USER_SESSION_COOKIE}=${options.sessionCookie}` } : {}),
  }
  const call = (path: string, init: RequestInit = {}) =>
    options.fetch(`${base}${path}`, {
      ...init,
      headers: { ...headers, ...(init.body ? { 'content-type': 'application/json' } : {}) },
    })

  const created = await expectOk(
    await call('/api/agent/conversations', {
      method: 'POST',
      body: JSON.stringify({ deviceId: options.deviceId }),
    }),
    '新建会话',
  )
  const { conversation } = (await created.json()) as { conversation: { id: string } }
  const conversationPath = `/api/agent/conversations/${encodeURIComponent(conversation.id)}`

  const turn = await expectOk(
    await call(`${conversationPath}/turns`, {
      method: 'POST',
      body: JSON.stringify({
        deviceId: options.deviceId,
        text: input.turn.text,
        mode: 'image',
        clientMessageId: `verify-${input.skill}-${input.caseId}-${input.run}-${now().getTime()}`,
        params: { autoSubmit: true, ...(input.model ? { model: input.model } : {}) },
        references: input.turn.images.map((image, at) => ({
          imageId: `verify-${at + 1}`,
          name: image.ref,
          dataUrl: `data:${input.images[at]!.mime};base64,${base64(input.images[at]!.bytes)}`,
        })),
      }),
    }),
    '发起对话轮',
  )
  // 开轮成功时回的是这一轮的事件流；读完它就是这一轮的对话说完了（后台任务另算）。
  await turn.text()

  let stable = 0
  let previous = ''
  let snapshot: AgentConversationSnapshot
  for (;;) {
    // 先问任务列表：它是「读取即结算」的，消息快照里的任务状态随之更新。
    await (await expectOk(await call(`${conversationPath}/jobs`), '查询后台任务')).arrayBuffer()
    snapshot = (await (
      await expectOk(await call(`${conversationPath}/messages`), '读取会话')
    ).json()) as AgentConversationSnapshot
    const print = fingerprint(snapshot)
    const idle = isIdle(snapshot)
    stable = !idle ? 0 : print === previous ? stable + 1 : 1
    previous = print
    if (stable >= settlePolls) break
    if (now().getTime() > deadline) throw new RunnerError('等待出图超时')
    await sleep(interval)
  }

  const date = localIsoDate(now())
  const results = toolResults(snapshot)
  const delivered = results
    .filter((block) => GENERATION_TOOLS.has(block.toolName) && block.status === 'succeeded')
    .flatMap((block) =>
      (block.artifacts ?? [])
        .filter((artifact) => artifact.media === 'image')
        .map((artifact) => ({ artifact, model: block.snapshot?.target?.model })),
    )
  const last = delivered.at(-1)
  const model = last?.model ?? input.model ?? UNKNOWN_MODEL
  const run = { case: input.caseId, run: input.run, model, date }
  if (!last) {
    const failed = results.filter((block) => block.status === 'failed').at(-1)
    return { run: { ...run, error: failed?.errorCode ?? 'no_output' }, image: null }
  }
  const image = await expectOk(
    await call(
      `/v1/queue/requests/${encodeURIComponent(last.artifact.taskId)}/image/${last.artifact.outputIndex}`,
    ),
    '下载产出图',
  )
  return {
    run,
    image: { mime: last.artifact.mime, bytes: new Uint8Array(await image.arrayBuffer()) },
  }
}

/** 图片扩展名与 MIME 的对照：读输入图按扩展名取 MIME，写产出图按 MIME 取扩展名。 */
export const IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
}

/** 按 MIME 给产出图取扩展名，认不出按 png。 */
export function imageExtension(mime: string): string {
  return Object.entries(IMAGE_MIME_BY_EXTENSION).find(([, one]) => one === mime)?.[0] ?? 'png'
}
