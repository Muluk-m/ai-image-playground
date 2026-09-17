import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import type { AgentMessageView, AgentToolArtifact } from '@image-playground/shared'
import { eq } from 'drizzle-orm'
import type { FfmpegRunOptions, FfmpegRunResult } from '../../../lib/ffmpeg'
import { InMemoryObjectStore } from '../../helpers/inMemoryObjectStore'
import { installRecordingTaskHooks } from '../../helpers/privateOverlayStub'

process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
process.env.LOG_LEVEL = 'silent'
process.env.OPERATOR_CONFIG_FILE = resolve(
  import.meta.dir,
  '../../agent-video-operator-config.json',
)
process.env.DATABASE_URL = await resetTestDatabase('bff_video_stitch')

// `billing:credits` 是开着的，所以计费替身必须在被测模块求值之前装好。
const hooks = installRecordingTaskHooks()

// 动态引入：环境要先钉死，再让捕获配置的模块加载。
const { close, db, schema } = await import('../../../db/client')
const { setObjectStoreForTesting } = await import('../../../lib/objectStore')
const { setFfmpegForTesting } = await import('../../../lib/ffmpeg')
const { createAgentImageSource } = await import('../../../lib/agent/images')
const { _resetVideoStitchSlotForTesting, STITCH_MODEL, stitchVideoSegments } = await import(
  '../../../lib/agent/video-stitch'
)
const { stitchVideos } = await import('../../../lib/agent/tools/stitchVideos')
const { STITCH_LIMITS } = await import('../../../lib/agent/video-stitch-plan')

const MP4 = 'video/mp4'
const FILM = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7])

interface FakeSegment {
  readonly width: number
  readonly height: number
  readonly durationSeconds: number
  readonly hasAudio: boolean
}

function probeJson(segment: FakeSegment): string {
  return JSON.stringify({
    streams: [
      {
        codec_type: 'video',
        width: segment.width,
        height: segment.height,
        duration: String(segment.durationSeconds),
        r_frame_rate: '30/1',
      },
      ...(segment.hasAudio ? [{ codec_type: 'audio' }] : []),
    ],
  })
}

/**
 * 每一段的字节第一位就是它的编号，所以探测是按**内容**认段，不是按临时文件名认段——
 * 临时文件名跟着写入顺序走，认它就等于什么都没测，顺序接错了也看不出来。
 */
async function markerOf(path: string): Promise<number> {
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer())
  return bytes[0] ?? -1
}

interface FakeFfmpeg {
  segments: FakeSegment[]
  /** 每次 ffmpeg 调用拿到的完整参数，按调用顺序。 */
  readonly calls: string[][]
  /** ffprobe 依次看到的段编号；拼接顺序就是它。 */
  readonly probed: number[]
  /** ffmpeg 那一行 `-i` 上依次排着的段编号，跑的当下读出来——临时目录随后就删了。 */
  readonly inputs: number[]
  /** 每次子进程调用拿到的超时预算，按 `ffprobe` / `ffmpeg` 分开记。 */
  readonly budgets: { probe: number[]; run: number[] }
  /** 每次子进程调用前先睡这么久，用来把墙钟预算耗光。 */
  delayMs: number
  /** 假成片的字节数。 */
  filmBytes: number
  /** 每次 ffmpeg 调用拿到的取消信号。 */
  readonly signals: (AbortSignal | undefined)[]
  /** ffmpeg 的返回码；`-1` 是「杀了也没等到它退」。 */
  exitCode: number
  /** ffmpeg 真跑起来时先等这个；用来把两次拼接卡在同一时刻。 */
  gate?: Promise<void>
  onStart?: () => void
  writeOutput: boolean
}

const fake: FakeFfmpeg = {
  segments: [],
  exitCode: 0,
  calls: [],
  probed: [],
  inputs: [],
  budgets: { probe: [], run: [] },
  delayMs: 0,
  filmBytes: FILM.byteLength,
  signals: [],
  writeOutput: true,
}

function installFakeFfmpeg(): void {
  setFfmpegForTesting({
    available: true,
    runner: {
      async ffprobe(args: readonly string[], options: FfmpegRunOptions): Promise<FfmpegRunResult> {
        fake.budgets.probe.push(options.timeoutMs)
        if (fake.delayMs) await Bun.sleep(fake.delayMs)
        const marker = await markerOf(args.at(-1) ?? '')
        fake.probed.push(marker)
        const segment = fake.segments[marker]
        if (!segment) return { code: 1, stdout: '', stderr: 'no such segment' }
        return { code: 0, stdout: probeJson(segment), stderr: '' }
      },
      async ffmpeg(args: readonly string[], options: FfmpegRunOptions): Promise<FfmpegRunResult> {
        fake.budgets.run.push(options.timeoutMs)
        fake.signals.push(options.signal)
        if (fake.delayMs) await Bun.sleep(fake.delayMs)
        fake.calls.push([...args])
        for (const [at, arg] of args.entries()) {
          const path = args[at + 1]
          if (arg === '-i' && path?.includes('/in-')) fake.inputs.push(await markerOf(path))
        }
        fake.onStart?.()
        if (fake.gate) await fake.gate
        if (fake.exitCode !== 0) return { code: fake.exitCode, stdout: '', stderr: 'boom' }
        if (fake.writeOutput) {
          const film = fake.filmBytes === FILM.byteLength ? FILM : new Uint8Array(fake.filmBytes)
          await Bun.write(args.at(-1) ?? '', film)
        }
        return { code: 0, stdout: '', stderr: '' }
      },
    },
  })
}

let store: InMemoryObjectStore

beforeEach(async () => {
  store = new InMemoryObjectStore()
  setObjectStoreForTesting(store)
  installFakeFfmpeg()
  fake.segments = []
  fake.exitCode = 0
  fake.calls.length = 0
  fake.probed.length = 0
  fake.inputs.length = 0
  fake.budgets.probe.length = 0
  fake.budgets.run.length = 0
  fake.signals.length = 0
  fake.delayMs = 0
  fake.filmBytes = FILM.byteLength
  fake.gate = undefined
  fake.onStart = undefined
  fake.writeOutput = true
  hooks.reset()
  _resetVideoStitchSlotForTesting()
  await db.delete(schema.tasks)
})

afterEach(() => {
  setObjectStoreForTesting()
  setFfmpegForTesting()
})

afterAll(close)

/** 一段已经出好的视频：任务行 + 桶里的字节，与生视频产物落库的形状一致。 */
async function seedSegment(input: {
  readonly taskId: string
  readonly userId?: string | null
  readonly status?: 'completed' | 'in_progress'
  /** 这一段在 `fake.segments` 里的编号，也是它字节里的第一位。 */
  readonly marker: number
  /** 任务行上声明的时长；下载之前的上限检查读的就是它。 */
  readonly declaredSeconds?: number
}): Promise<AgentToolArtifact> {
  const objectKey = `${input.taskId}/out/0`
  await store.write(objectKey, new Uint8Array([input.marker, 9, 9]), MP4)
  const now = Date.now()
  await db.insert(schema.tasks).values({
    id: input.taskId,
    provider: 'openai-compat',
    model: 'grok-imagine-video',
    status: input.status ?? 'completed',
    request_payload: {
      prompt: '一镜',
      device_id: 'device-abcdefgh',
      video: {
        duration_seconds: input.declaredSeconds ?? 5,
        aspect_ratio: '16:9',
        resolution: '720p',
      },
    },
    result_payload: { data: [{ object: objectKey, mime: MP4 }] },
    submitted_at: now,
    completed_at: now,
    user_id: input.userId ?? null,
  })
  return {
    artifactId: `agent_${input.taskId}`,
    media: 'video',
    taskId: input.taskId,
    outputIndex: 0,
    mime: MP4,
  }
}

function historyWith(artifacts: readonly AgentToolArtifact[]): AgentMessageView[] {
  return [
    {
      id: 'm1',
      turnId: 'turn-old',
      role: 'assistant',
      content: artifacts.map((artifact) => ({
        type: 'toolResult' as const,
        toolCallId: `call-${artifact.artifactId}`,
        toolName: 'generateVideo' as const,
        status: 'succeeded' as const,
        title: '生视频',
        artifacts: [artifact],
      })),
      createdAt: 1,
    },
  ]
}

function imageSource(artifacts: readonly AgentToolArtifact[], userId: string | null = null) {
  return createAgentImageSource({ references: [], history: historyWith(artifacts), userId })
}

const LANDSCAPE: FakeSegment = { width: 1280, height: 720, durationSeconds: 5, hasAudio: false }
const PORTRAIT: FakeSegment = { width: 720, height: 1280, durationSeconds: 4, hasAudio: true }

async function resolvedVideos(artifacts: readonly AgentToolArtifact[]) {
  const source = imageSource(artifacts)
  const videos = []
  for (const artifact of artifacts) {
    const lookup = await source.resolveVideo(artifact.artifactId)
    if (lookup.kind !== 'ready') throw new Error(`segment not ready: ${artifact.artifactId}`)
    videos.push(lookup.video)
  }
  return videos
}

function stitchInput(videos: Awaited<ReturnType<typeof resolvedVideos>>) {
  return {
    videos,
    userId: null,
    deviceId: 'device-abcdefgh',
    conversationId: 'c1',
    turnId: 't1',
    title: '成片',
  }
}

/** 两段横屏，最常用的那组夹具。 */
async function twoSegments() {
  fake.segments = [LANDSCAPE, LANDSCAPE]
  return resolvedVideos([
    await seedSegment({ taskId: 'task-1', marker: 0 }),
    await seedSegment({ taskId: 'task-2', marker: 0 }),
  ])
}

describe('finished videos are things the model can point at', () => {
  it('resolves a completed segment the conversation produced', async () => {
    const artifact = await seedSegment({ taskId: 'task-a', marker: 0 })
    const source = imageSource([artifact])
    expect(source.videoIds).toEqual([artifact.artifactId])
    const lookup = await source.resolveVideo(artifact.artifactId)
    expect(lookup.kind).toBe('ready')
  })

  it('separates an id this turn never saw from one it cannot read yet', async () => {
    const running = await seedSegment({
      taskId: 'task-running',
      status: 'in_progress',
      marker: 0,
    })
    const source = imageSource([running])
    expect(await source.resolveVideo('agent_nope')).toEqual({ kind: 'unknown' })
    expect(await source.resolveVideo(running.artifactId)).toEqual({ kind: 'unavailable' })
  })

  it('refuses a segment that belongs to somebody else', async () => {
    await db
      .insert(schema.users)
      .values({
        id: 'user-2',
        username: 'two',
        password_hash: 'x',
        created_at: Date.now(),
        updated_at: Date.now(),
      })
      .onConflictDoNothing()
    const theirs = await seedSegment({ taskId: 'task-theirs', userId: 'user-2', marker: 0 })
    const source = imageSource([theirs], 'user-1')
    expect(await source.resolveVideo(theirs.artifactId)).toEqual({ kind: 'unavailable' })
  })

  it('still keeps video out of the image references: it has no editable bitmap', async () => {
    const artifact = await seedSegment({ taskId: 'task-b', marker: 0 })
    expect(await imageSource([artifact]).resolve(artifact.artifactId)).toBeNull()
  })
})

describe('stitching several segments into one film', () => {
  it('stores the film as an ordinary completed video task', async () => {
    fake.segments = [LANDSCAPE, PORTRAIT]
    const artifacts = [
      await seedSegment({ taskId: 'task-1', marker: 0 }),
      await seedSegment({ taskId: 'task-2', marker: 1 }),
    ]
    const outcome = await stitchVideoSegments(stitchInput(await resolvedVideos(artifacts)))
    if (outcome.kind !== 'stitched') throw new Error(outcome.message)

    expect(outcome).toMatchObject({ width: 1280, height: 720, outputIndex: 0, mime: MP4 })
    expect(outcome.durationSeconds).toBeCloseTo(9, 5)
    // 第二段是竖屏要补边，第一段没有音轨要补静音：两件事都得如实报出来。
    expect(outcome.adaptations).toEqual([
      { index: 0, scaled: false, padded: false, silenced: true },
      { index: 1, scaled: true, padded: true, silenced: false },
    ])

    const [row] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, outcome.taskId))
    expect(row).toMatchObject({
      status: 'completed',
      provider: 'openai-compat',
      model: STITCH_MODEL,
      agent_conversation_id: 'c1',
      agent_turn_id: 't1',
      upstream_invocation_count: 0,
    })
    // 带着 video 这一段，成片与逐镜产出同类：不进作品流水，按视频清理。
    expect(row!.request_payload.video).toMatchObject({ aspect_ratio: '16:9', resolution: '720p' })
    expect(store.objects.get(`${outcome.taskId}/out/0`)?.bytes).toEqual(FILM)
  })

  it('feeds ffmpeg the segments in the order the model asked for', async () => {
    fake.segments = [LANDSCAPE, PORTRAIT]
    const artifacts = [
      await seedSegment({ taskId: 'task-1', marker: 0 }),
      await seedSegment({ taskId: 'task-2', marker: 1 }),
    ]
    const videos = await resolvedVideos(artifacts)
    await stitchVideoSegments(stitchInput([videos[1]!, videos[0]!]))
    // 倒着给就倒着接：顺序是模型唯一说了算的东西。
    expect(fake.probed).toEqual([1, 0])
    // 命令行上的 `-i` 也按同一个顺序排；静音源那一路不是片段，不参与比较。
    expect(fake.inputs).toEqual([1, 0])
  })

  it('bills nothing at all: no reservation, no settlement, no ledger row', async () => {
    fake.segments = [LANDSCAPE, LANDSCAPE]
    const artifacts = [
      await seedSegment({ taskId: 'task-1', marker: 0 }),
      await seedSegment({ taskId: 'task-2', marker: 0 }),
    ]
    await stitchVideoSegments(stitchInput(await resolvedVideos(artifacts)))
    expect(hooks.reservations).toEqual([])
    expect(hooks.settlements).toEqual([])
  })

  it('clears its temporary files whether it succeeds or fails', async () => {
    fake.segments = [LANDSCAPE, LANDSCAPE]
    const artifacts = [
      await seedSegment({ taskId: 'task-1', marker: 0 }),
      await seedSegment({ taskId: 'task-2', marker: 0 }),
    ]
    const videos = await resolvedVideos(artifacts)

    await stitchVideoSegments(stitchInput(videos))
    const succeeded = dirname(fake.calls[0]!.at(-1)!)
    expect(existsSync(succeeded)).toBe(false)

    fake.exitCode = 1
    const failure = await stitchVideoSegments(stitchInput(videos))
    expect(failure).toMatchObject({ kind: 'refused' })
    expect(existsSync(dirname(fake.calls[1]!.at(-1)!))).toBe(false)
  })

  it('leaves no task row and no object behind when ffmpeg fails', async () => {
    fake.segments = [LANDSCAPE, LANDSCAPE]
    fake.exitCode = 1
    const artifacts = [
      await seedSegment({ taskId: 'task-1', marker: 0 }),
      await seedSegment({ taskId: 'task-2', marker: 0 }),
    ]
    await stitchVideoSegments(stitchInput(await resolvedVideos(artifacts)))
    const rows = await db.select().from(schema.tasks)
    expect(rows.map((row) => row.model)).toEqual(['grok-imagine-video', 'grok-imagine-video'])
  })

  it('names the segment ffprobe could not read, instead of failing the whole turn', async () => {
    // 只登记一段的探测答案，第二段就成了「读不出参数」的那一段。
    // 第二段的编号没有登记探测答案，它就是「读不出参数」的那一段。
    fake.segments = [LANDSCAPE]
    const artifacts = [
      await seedSegment({ taskId: 'task-1', marker: 0 }),
      await seedSegment({ taskId: 'task-2', marker: 5 }),
    ]
    const outcome = await stitchVideoSegments(stitchInput(await resolvedVideos(artifacts)))
    expect(outcome).toMatchObject({ kind: 'refused' })
    expect(outcome.kind === 'refused' && outcome.message).toContain('第 2 段')
  })
})

describe('one stitch at a time on a small machine', () => {
  it('queues the second call and turns the third away', async () => {
    fake.segments = [LANDSCAPE, LANDSCAPE]
    const artifacts = [
      await seedSegment({ taskId: 'task-1', marker: 0 }),
      await seedSegment({ taskId: 'task-2', marker: 0 }),
    ]
    const videos = await resolvedVideos(artifacts)
    let release = () => {}
    fake.gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const started = new Promise<void>((resolve) => {
      fake.onStart = resolve
    })

    const first = stitchVideoSegments(stitchInput(videos))
    await started
    let queued = 0
    const second = stitchVideoSegments({
      ...stitchInput(videos),
      onQueued: () => {
        queued++
      },
    })
    // 第三条连队都进不了：等的人再多就直接说稍后再试，不无限堆。
    const third = await stitchVideoSegments(stitchInput(videos))
    expect(third).toMatchObject({ kind: 'refused' })
    expect(third.kind === 'refused' && third.message).toContain('现在排不下')
    expect(queued).toBe(1)

    release()
    expect((await first).kind).toBe('stitched')
    expect((await second).kind).toBe('stitched')
  })
})

describe('the tool end to end', () => {
  it('hands back a video artifact the canvas can place and the next turn can name', async () => {
    fake.segments = [LANDSCAPE, LANDSCAPE]
    const artifacts = [
      await seedSegment({ taskId: 'task-1', marker: 0 }),
      await seedSegment({ taskId: 'task-2', marker: 0 }),
    ]
    const images = imageSource(artifacts)
    const stages: string[] = []
    const result = await stitchVideos
      .create({
        mode: 'video',
        conversationId: 'c1',
        turnId: 't1',
        userId: null,
        deviceId: 'device-abcdefgh',
        images,
      })
      .execute(
        'call-1',
        { videoIds: artifacts.map((one) => one.artifactId), title: '成片' } as never,
        undefined,
        (partial: { details?: { stage?: string } }) => {
          if (partial.details?.stage) stages.push(partial.details.stage)
        },
      )

    const [film] = (result.details.artifacts ?? []) as AgentToolArtifact[]
    expect(film).toMatchObject({ media: 'video', outputIndex: 0, mime: MP4, width: 1280 })
    expect(stages).toEqual(['running'])
    expect(JSON.stringify(result.content)).toContain('不消耗积分')
    // 成片本身也成了模型指得到的一段视频：下一步可以拿它继续接。
    expect(images.videoIds).toContain(film!.artifactId)
    expect((await images.resolveVideo(film!.artifactId)).kind).toBe('ready')
  })
})

describe('一次拼接的墙钟预算', () => {
  it('每一次子进程调用只拿到剩下的那点预算，探测另有自己的短上限', async () => {
    const videos = await twoSegments()
    await stitchVideoSegments({ ...stitchInput(videos), deadlineMs: 10_000 })

    // 探测是逐段串行的，单次再慢也不能吃掉整份预算。
    for (const budget of fake.budgets.probe) {
      expect(budget).toBeLessThanOrEqual(STITCH_LIMITS.probeTimeoutMs)
    }
    // ffmpeg 拿的是「此刻还剩多少」，不是一个与总预算无关的固定 300 秒。
    expect(fake.budgets.run[0]).toBeLessThanOrEqual(10_000)
  })

  it('预算耗光就收场，不把全局槽一直占着', async () => {
    const videos = await twoSegments()
    fake.delayMs = 60
    const outcome = await stitchVideoSegments({ ...stitchInput(videos), deadlineMs: 80 })

    expect(outcome).toMatchObject({ kind: 'refused' })
    expect(outcome.kind === 'refused' && outcome.message).toContain('太久')
    // 槽回来了：下一次拼接照样跑得起来。
    fake.delayMs = 0
    expect((await stitchVideoSegments(stitchInput(videos))).kind).toBe('stitched')
  })

  it('杀不死的 ffmpeg 收场之后，下一次拼接仍然拿得到槽', async () => {
    const videos = await twoSegments()
    // `-1` 是执行接缝在「SIGTERM 与 SIGKILL 都没等到它退」时给的码。
    fake.exitCode = -1
    expect((await stitchVideoSegments(stitchInput(videos))).kind).toBe('refused')
    fake.exitCode = 0
    expect((await stitchVideoSegments(stitchInput(videos))).kind).toBe('stitched')
  })
})

describe('字节上限', () => {
  it('段太大时一个字节都不下载', async () => {
    const videos = await twoSegments()
    // 桶里那份比单段上限还大：这一步只问大小，不读内容。
    await store.write(
      'task-2/out/0',
      new Uint8Array(STITCH_LIMITS.maxSegmentBytes + 1),
      'video/mp4',
    )
    const outcome = await stitchVideoSegments(stitchInput(videos))

    expect(outcome).toMatchObject({ kind: 'refused' })
    expect(outcome.kind === 'refused' && outcome.message).toContain('太大')
    expect(fake.calls).toHaveLength(0)
  })

  it('成片太大时不落库、不进桶', async () => {
    const videos = await twoSegments()
    fake.filmBytes = STITCH_LIMITS.maxFilmBytes + 1
    const outcome = await stitchVideoSegments(stitchInput(videos))

    expect(outcome).toMatchObject({ kind: 'refused' })
    expect(outcome.kind === 'refused' && outcome.message).toContain('超过 400 MB')
    expect((await db.select().from(schema.tasks)).map((row) => row.model)).toEqual([
      'grok-imagine-video',
      'grok-imagine-video',
    ])
  })

  it('段的字节是边读边写的，不整份进内存', async () => {
    const videos = await twoSegments()
    await stitchVideoSegments(stitchInput(videos))
    // `open` 是流式那条路；`read` 会把整段 mp4 读成一个 Uint8Array。
    expect(store.events.filter((one) => one === 'read:task-1/out/0')).toEqual([])
    expect(store.events).toContain('open:task-1/out/0')
  })

  it('声明的总时长超标时，同样一个字节都不下载', async () => {
    fake.segments = [LANDSCAPE, LANDSCAPE]
    const videos = await resolvedVideos([
      await seedSegment({ taskId: 'task-1', marker: 0, declaredSeconds: 100 }),
      await seedSegment({ taskId: 'task-2', marker: 0, declaredSeconds: 100 }),
    ])
    const outcome = await stitchVideoSegments(stitchInput(videos))

    expect(outcome).toMatchObject({ kind: 'refused' })
    expect(outcome.kind === 'refused' && outcome.message).toContain(
      String(STITCH_LIMITS.maxTotalSeconds),
    )
    // 时长这条上限在下载之前就查了：探测一次都没发生。
    expect(fake.probed).toEqual([])
  })
})

describe('取消', () => {
  it('排队时取消就让出等待位，不占着不动', async () => {
    const videos = await twoSegments()
    let release = () => {}
    fake.gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const started = new Promise<void>((resolve) => {
      fake.onStart = resolve
    })
    const running = stitchVideoSegments(stitchInput(videos))
    await started

    const controller = new AbortController()
    const queued = stitchVideoSegments({ ...stitchInput(videos), signal: controller.signal })
    controller.abort()
    expect((await queued).kind).toBe('refused')

    // 等待位空出来了，新来的那条排得进去，而不是被顶成「排不下」。
    fake.gate = undefined
    const next = stitchVideoSegments(stitchInput(videos))
    release()
    expect((await running).kind).toBe('stitched')
    expect((await next).kind).toBe('stitched')
  })

  it('下载途中取消就停手，不再去起 ffmpeg', async () => {
    const videos = await twoSegments()
    const controller = new AbortController()
    controller.abort()
    const outcome = await stitchVideoSegments({ ...stitchInput(videos), signal: controller.signal })

    expect(outcome).toMatchObject({ kind: 'refused' })
    expect(fake.calls).toHaveLength(0)
  })

  it('ffmpeg 跑着时取消：子进程收到信号，临时目录清掉，槽还回来', async () => {
    const videos = await twoSegments()
    const controller = new AbortController()
    let release = () => {}
    fake.gate = new Promise<void>((resolve) => {
      release = resolve
    })
    fake.onStart = () => {
      controller.abort()
      release()
    }
    const outcome = await stitchVideoSegments({ ...stitchInput(videos), signal: controller.signal })

    expect(outcome).toMatchObject({ kind: 'refused' })
    // 信号真的传给了子进程执行接缝，它才杀得掉在跑的 ffmpeg。
    expect(fake.signals.at(-1)?.aborted).toBe(true)
    expect(existsSync(dirname(fake.calls[0]!.at(-1)!))).toBe(false)
    fake.gate = undefined
    fake.onStart = undefined
    expect((await stitchVideoSegments(stitchInput(videos))).kind).toBe('stitched')
  })
})

describe('一轮里拼几次', () => {
  it('到了上限就说明白，不再起 ffmpeg', async () => {
    fake.segments = [LANDSCAPE, LANDSCAPE]
    const artifacts = [
      await seedSegment({ taskId: 'task-1', marker: 0 }),
      await seedSegment({ taskId: 'task-2', marker: 0 }),
    ]
    const images = imageSource(artifacts)
    const tool = stitchVideos.create({
      mode: 'video',
      conversationId: 'c1',
      turnId: 't1',
      userId: null,
      deviceId: 'device-abcdefgh',
      images,
    })
    const params = { videoIds: artifacts.map((one) => one.artifactId) } as never
    const run = () => tool.execute('call-1', params, undefined, undefined)

    for (let at = 0; at < STITCH_LIMITS.maxPerTurn; at++) {
      expect((await run()).details.artifacts).toHaveLength(1)
    }
    const extra = await run()

    expect(extra.details.artifacts).toBeUndefined()
    expect(JSON.stringify(extra.content)).toContain(`${STITCH_LIMITS.maxPerTurn}`)
    expect(fake.calls).toHaveLength(STITCH_LIMITS.maxPerTurn)
  })

  it('成片可以再被拼进下一条，它也算这一轮的一次', async () => {
    fake.segments = [LANDSCAPE, LANDSCAPE]
    const artifacts = [
      await seedSegment({ taskId: 'task-1', marker: 0 }),
      await seedSegment({ taskId: 'task-2', marker: 0 }),
    ]
    const images = imageSource(artifacts)
    const tool = stitchVideos.create({
      mode: 'video',
      conversationId: 'c1',
      turnId: 't1',
      userId: null,
      deviceId: 'device-abcdefgh',
      images,
    })
    const first = await tool.execute(
      'call-1',
      { videoIds: artifacts.map((one) => one.artifactId) } as never,
      undefined,
      undefined,
    )
    const film = (first.details.artifacts ?? [])[0]!

    // 成片本身就是一段普通视频：拿它接着往下拼是合理需求，字节也真的读得出来。
    const again = await tool.execute(
      'call-2',
      { videoIds: [film.artifactId, artifacts[0]!.artifactId] } as never,
      undefined,
      undefined,
    )
    expect(again.details.artifacts).toHaveLength(1)
    expect(fake.calls).toHaveLength(2)
  })

  it('长标题落库前照卡片那一套截断', async () => {
    fake.segments = [LANDSCAPE, LANDSCAPE]
    const artifacts = [
      await seedSegment({ taskId: 'task-1', marker: 0 }),
      await seedSegment({ taskId: 'task-2', marker: 0 }),
    ]
    const tool = stitchVideos.create({
      mode: 'video',
      conversationId: 'c1',
      turnId: 't1',
      userId: null,
      deviceId: 'device-abcdefgh',
      images: imageSource(artifacts),
    })
    const title = '咖啡的一天'.repeat(20)
    const result = await tool.execute(
      'call-1',
      { videoIds: artifacts.map((one) => one.artifactId), title } as never,
      undefined,
      undefined,
    )
    const film = (result.details.artifacts ?? [])[0]!
    const [row] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, film.taskId))

    const stored = row!.request_payload.prompt
    expect([...stored].length).toBeLessThanOrEqual(32)
    // 卡片标题与落库的那一份是同一条截断规则，只差前缀。
    expect(stitchVideos.call({ videoIds: ['a', 'b'], title }, 'video').title).toBe(
      `拼接：${stored}`,
    )
  })
})
