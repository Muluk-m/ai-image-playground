import {
  type CanvasOrigin,
  canvasStageRunsDirectly,
  readCanvasDocument,
  type StageAuthorization,
  type StoryboardFrameMode,
  storyboardFingerprint,
  storyboardMissingAssetNodes,
  storyboardStageSummary,
} from '@image-playground/shared'
import { Type } from 'typebox'
import * as Y from 'yjs'
import { agentCanvasProject } from '../../../../lib/agent/node-canvas-view'
import {
  proposeStageAuthorization,
  proposeStageAuthorizationInTransaction,
  readStageAuthorization,
} from '../../../../lib/agent/stage-authorizations'
import { agentVideoModel } from '../../../../lib/agent/video-models'
import {
  accessCanvasDocument,
  applyCanvasScriptPlan,
  executeCanvasCommand,
  getCanvasNode,
  prepareCanvasStoryboardFrames,
  replayedStoryboardRef,
  resolveStoryboardShotIds,
  type StageStoryboardSummaryRef,
  selectRunnableStageNodes,
  unknownStoryboardShotsMessage,
} from '../../../canvas'
import { defineAgentTool } from '../adapter'
import {
  invalidCanvasToolParam,
  nodeCanvasAvailable,
  nodeCanvasModes,
  nodeIdSchema,
  runCanvasOp,
  runCanvasOpAsync,
  writeAgentCanvas,
} from './node-shared'
import {
  canvasStageResult,
  missingAssetsMessage,
  priorFrameProposal,
  proposing,
  stageProposalInput,
} from './node-stage-quote'

const scratchOrigin: CanvasOrigin = 'agent:storyboard-frames'

export const runNodes = defineAgentTool({
  name: 'runNodes',
  label: '阶段授权',
  modes: nodeCanvasModes,
  available: nodeCanvasAvailable,
  onError: 'continue',
  guidance:
    '为画布节点生成图片或视频都用 runNodes。先 readCanvas 确认节点名称与范围。是否立即开跑由这一轮请求里的用户直接出图偏好决定，工具参数改不了。回执会写明是待确认还是已交给原标签页开跑。只有查到 taskIds 才能说已提交，有真实结果才能说已完成。画布不使用出图模式每轮自动提交额度。',
  description:
    '为当前云端画布的一组可生成图片或视频节点登记持久化阶段授权。预算由服务端按节点模型、数量和倍率计算，estimatedCredits 不决定上限。有提示词的素材按普通出图授权；没写提示词但有素材描述的图片素材按「素材名：描述」出图；两者都没有的素材不会单独授权。直接出图时原标签页立即开跑；用户关掉直接出图时才等确认卡。提供 authorizationId 时只查询真实授权状态、已用额度与任务记录，不重新提交。范围外或预算不足必须重新提案。',
  parameters: Type.Object({
    nodeIds: Type.Optional(
      Type.Array(nodeIdSchema, { minItems: 1, maxItems: 200, uniqueItems: true }),
    ),
    stage: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    estimatedCredits: Type.Optional(Type.Integer({ minimum: 0, maximum: 100000000 })),
    authorizationId: Type.Optional(nodeIdSchema),
  }),
  call: () => ({ title: '阶段授权' }),
  execute: (context) => async (callId, params) => {
    if (!nodeCanvasAvailable(context.mode, context))
      invalidCanvasToolParam('当前会话没有可用的云端节点画布。')
    const project = await agentCanvasProject(context)
    if (!project || !context.userId) return invalidCanvasToolParam('当前会话没有已同步的云端项目。')
    if (params.authorizationId) {
      const authorization = await readStageAuthorization(context.userId, params.authorizationId)
      if (
        authorization.projectId !== project.id ||
        authorization.conversationId !== context.conversationId
      )
        return invalidCanvasToolParam('授权不属于当前会话与项目。')
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ...authorization,
              submitted: authorization.attempts.some((attempt) => attempt.taskIds.length > 0),
              note:
                authorization.status === 'pending'
                  ? '待确认，尚未提交。'
                  : '只有 taskIds 中的任务已提交；不代表已完成。',
            }),
          },
        ],
        details: {},
      }
    }
    await context.assertExecution?.()
    const requested = params.nodeIds
    if (!requested?.length) return invalidCanvasToolParam('需要指定要生成的节点。')
    const doc = new Y.Doc()
    try {
      Y.applyUpdate(doc, await accessCanvasDocument(context.userId, project.id))
      const graph = readCanvasDocument(doc)
      const nodes = runCanvasOp(() => selectRunnableStageNodes(graph, requested))
      const input = await stageProposalInput(
        context,
        callId,
        project.id,
        graph,
        nodes,
        params.stage ?? '节点生成',
      )
      const authorization = await proposing(() => proposeStageAuthorization(input))
      return canvasStageResult(context, project.id, authorization)
    } finally {
      doc.destroy()
    }
  },
})

export const runStoryboardFrames = defineAgentTool({
  name: 'runStoryboardFrames',
  label: '首帧阶段',
  modes: nodeCanvasModes,
  available: nodeCanvasAvailable,
  onError: 'continue',
  guidance:
    '分镜表出首帧只用本工具，顺序是先素材、后首帧：分镜表引用的人物、地点素材都有图之后再调用；素材还没有图时，先用 runNodes（stage 写「素材」）出素材，素材批跑完系统会唤醒你，那时再调用本工具。首帧节点由本工具自己铺：不要用 createNodes、connectNodes 手工搭首帧节点，也不要对首帧节点用 runNodes。默认 mode 为 grid，宫格一次出图再切分；用户要求某一镜单独重出时传 shotIds（逐镜），shotIds 填分镜表镜头 id，不是首帧节点 id。素材缺图时本工具不铺节点也不登记授权，回执会列出缺图的素材节点：照回执在同一轮接着用 runNodes 发起素材阶段，不要停下来只向用户转述；画布上已有合适的图就用 importCanvasImage 收进素材。这条授权一经确认，分镜表就定稿。只有查到 taskIds 才能说已提交，读到真实结果才能说已完成。',
  description:
    '按分镜表铺首帧：每镜一个首帧节点，宫格模式另建宫格节点；首帧与宫格连上该镜人物、地点素材作为参考，再为本次要出图的节点登记首帧阶段授权，附镜头表摘要（镜数、总时长、每镜一句）。确认授权即把分镜表定稿；提案后镜头表被改过，确认会失败，需要重新提案。直接出图开着时原标签页立即确认并开跑。素材缺图时整次拒绝。',
  parameters: Type.Object({
    storyboardId: nodeIdSchema,
    mode: Type.Optional(Type.Union([Type.Literal('grid'), Type.Literal('individual')])),
    shotIds: Type.Optional(
      Type.Array(nodeIdSchema, {
        minItems: 1,
        maxItems: 200,
        uniqueItems: true,
        description:
          '只重出这几镜时传：分镜表镜头 id（readCanvas 里分镜表 shots[].id，照抄），不是首帧节点 id。出整张分镜表的首帧时不传。',
      }),
    ),
  }),
  call: () => ({ title: '首帧阶段' }),
  execute: (context) => async (callId, params) => {
    if (!nodeCanvasAvailable(context.mode, context))
      invalidCanvasToolParam('当前会话没有可用的云端节点画布。')
    const project = await agentCanvasProject(context)
    if (!project || !context.userId) return invalidCanvasToolParam('当前会话没有已同步的云端项目。')
    const userId = context.userId
    if (params.shotIds && params.mode === 'grid')
      invalidCanvasToolParam('单镜重出首帧只能逐镜：传 shotIds 时 mode 用 individual 或不填。')
    const mode: StoryboardFrameMode = params.shotIds ? 'individual' : (params.mode ?? 'grid')
    await context.assertExecution?.()
    const load = async () => {
      const doc = new Y.Doc()
      Y.applyUpdate(doc, await accessCanvasDocument(userId, project.id))
      return doc
    }
    // 先在副本上校验：缺素材、镜头不存在或提示词超长时，画布上什么也不留。
    const before = await load()
    let fingerprint: string
    try {
      // 同一次调用已登记过：跳过按当前画布的预检，交给画布命令先核对调用参数，再在重放里取回原授权。
      const prior = await priorFrameProposal(
        userId,
        context.conversationId,
        `${context.turnId}:${callId}`,
        params.storyboardId,
      )
      if (prior?.storyboard) fingerprint = prior.storyboard.fingerprint
      else {
        const board = runCanvasOp(() => getCanvasNode(before, params.storyboardId))
        if (board.type !== 'storyboard')
          return invalidCanvasToolParam(`节点不是分镜表：${params.storyboardId}`)
        if (!board.data.shots.length)
          return invalidCanvasToolParam('分镜表还没有镜头，先用 applyScriptPlan 写镜头。')
        const known = new Set(board.data.shots.map((shot) => shot.id))
        const shotIds = resolveStoryboardShotIds(
          readCanvasDocument(before).nodes,
          board,
          params.shotIds,
        )
        const unknown = (shotIds ?? []).filter((shot) => !known.has(shot))
        if (unknown.length) invalidCanvasToolParam(unknownStoryboardShotsMessage(board, unknown))
        const missing = storyboardMissingAssetNodes(before, board.id, shotIds)
        if (missing.length)
          invalidCanvasToolParam(
            missingAssetsMessage(missing, canvasStageRunsDirectly(context.params), shotIds),
          )
        fingerprint = storyboardFingerprint(board.data.shots)
        runCanvasOp(() => prepareCanvasStoryboardFrames(before, board.id, mode, scratchOrigin))
      }
    } finally {
      before.destroy()
    }
    // 铺节点与登记授权在同一事务里：计价或提案失败时，本次铺出或改动的节点一起回滚。
    let proposed:
      | { authorization: StageAuthorization; storyboard?: StageStoryboardSummaryRef }
      | undefined
    await runCanvasOpAsync(() =>
      proposing(() =>
        executeCanvasCommand(
          userId,
          project.id,
          { turnId: context.turnId, toolCallId: callId, label: '铺首帧', args: params },
          (doc, origin) => {
            const board = getCanvasNode(doc, params.storyboardId)
            if (
              board.type !== 'storyboard' ||
              storyboardFingerprint(board.data.shots) !== fingerprint
            )
              invalidCanvasToolParam('分镜表刚被改过，请重新读取后再发起首帧阶段。')
            prepareCanvasStoryboardFrames(doc, params.storyboardId, mode, origin)
          },
          async (tx, state, replay) => {
            const saved = new Y.Doc()
            try {
              Y.applyUpdate(saved, state)
              if (replay) {
                // 首次执行已在同一事务里登记了授权，这里只取回它。
                const prior = await priorFrameProposal(
                  userId,
                  context.conversationId,
                  `${context.turnId}:${callId}`,
                  params.storyboardId,
                  tx,
                )
                if (!prior)
                  return invalidCanvasToolParam('首帧阶段授权没有登记，请重新读取画布后再试。')
                const storyboard = replayedStoryboardRef(saved, prior.storyboard)
                proposed = { authorization: prior, ...(storyboard ? { storyboard } : {}) }
                return
              }
              const graph = readCanvasDocument(saved)
              const board = graph.nodes.find((node) => node.id === params.storyboardId)
              if (
                board?.type !== 'storyboard' ||
                storyboardFingerprint(board.data.shots) !== fingerprint
              )
                return invalidCanvasToolParam('分镜表刚被改过，请重新读取后再发起首帧阶段。')
              const shotIds = resolveStoryboardShotIds(graph.nodes, board, params.shotIds)
              // 预检之后素材可能被删掉或换掉：在要提交的画布上再核一次，缺图就整次回滚，不铺节点也不登记授权。
              const missing = storyboardMissingAssetNodes(saved, board.id, shotIds)
              if (missing.length)
                return invalidCanvasToolParam(
                  missingAssetsMessage(missing, canvasStageRunsDirectly(context.params), shotIds),
                )
              // 铺节点是幂等的：在要保存的画布副本上再跑一次只为拿到节点 ID，不写回。
              const persisted = new Set(graph.nodes.map((node) => node.id))
              const prepared = prepareCanvasStoryboardFrames(saved, board.id, mode, scratchOrigin)
              const wanted = shotIds ? new Set(shotIds) : undefined
              const targets = wanted
                ? board.data.shots.flatMap((shot, index) =>
                    wanted.has(shot.id) ? [prepared.frameIds[index]!] : [],
                  )
                : prepared.generateIds
              if (!targets.length || targets.some((target) => !persisted.has(target)))
                return invalidCanvasToolParam('首帧节点没有保存下来，请重新读取画布后再试。')
              const nodes = targets.map(
                (target) =>
                  graph.nodes.find((node) => node.id === target) ??
                  invalidCanvasToolParam('首帧节点不存在。'),
              )
              const storyboard: StageStoryboardSummaryRef = {
                ref: { storyboardId: board.id, fingerprint },
                summary: storyboardStageSummary(board.id, board.data.shots),
              }
              const authorization = await proposeStageAuthorizationInTransaction(
                tx,
                await stageProposalInput(
                  context,
                  callId,
                  project.id,
                  graph,
                  nodes,
                  '首帧',
                  storyboard,
                ),
              )
              proposed = { authorization, storyboard }
            } finally {
              saved.destroy()
            }
          },
        ),
      ),
    )
    if (!proposed) return invalidCanvasToolParam('首帧阶段授权没有登记，请重新读取画布后再试。')
    return canvasStageResult(context, project.id, proposed.authorization, proposed.storyboard)
  },
})

export const applyScriptPlan = defineAgentTool({
  name: 'applyScriptPlan',
  label: '拆分剧本',
  modes: nodeCanvasModes,
  available: nodeCanvasAvailable,
  onError: 'continue',
  guidance:
    '用户要求拆剧本、继续完善或扩写第 N 集时使用。先读取原分镜表，storyboardId 使用原表 ID；shots 提交完整的新镜头表，保留已有镜头 ID，新增镜头使用新 ID，省略的镜头会删除。assets 只列新素材。episodeNumber 指定集号，episode 只用于追加尚不存在的剧本文字。不生成媒体，不计费。',
  description:
    '创建或就地更新一集的唯一分镜表，保留原镜头身份，可增删镜头；定稿后修改会回到草稿，旧首帧和视频保留但过期。可同时新建无图素材或追加下一集剧本文字。',
  parameters: Type.Object({
    scriptNodeId: Type.String({
      minLength: 1,
      maxLength: 128,
      description:
        '画布上已有的文本剧本节点 ID（照抄 readCanvas）；剧本还不在画布上时先用 createNodes 建一个 text 节点放剧本。',
    }),
    storyboardId: nodeIdSchema,
    episodeNumber: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    assets: Type.Array(
      Type.Object({
        id: nodeIdSchema,
        kind: Type.Union([
          Type.Literal('person'),
          Type.Literal('location'),
          Type.Literal('prop'),
          Type.Literal('product'),
        ]),
        name: Type.String({ minLength: 1, maxLength: 120 }),
        description: Type.String({ maxLength: 4000 }),
      }),
      { maxItems: 40 },
    ),
    shots: Type.Array(
      Type.Object({
        id: nodeIdSchema,
        description: Type.String({ minLength: 1, maxLength: 10000 }),
        dialogue: Type.Optional(Type.String({ maxLength: 10000 })),
        camera: Type.Optional(Type.String({ maxLength: 200 })),
        durationSeconds: Type.Optional(Type.Integer({ minimum: 1 })),
        lookIds: Type.Array(nodeIdSchema, { maxItems: 8 }),
        locationId: Type.Optional(nodeIdSchema),
      }),
      { maxItems: 200 },
    ),
    episode: Type.Optional(
      Type.Object({
        number: Type.Integer({ minimum: 2, maximum: 200 }),
        text: Type.String({ minLength: 1, maxLength: 100000 }),
      }),
    ),
  }),
  call: () => ({ title: '拆分剧本' }),
  execute: (context) => async (callId, params) => {
    if (!nodeCanvasAvailable(context.mode, context))
      invalidCanvasToolParam('当前会话不能拆分剧本。')
    const selectedModel = context.params?.video?.model
    const video = agentVideoModel(selectedModel)
    if (selectedModel && (!video || !video.support.firstFrame))
      invalidCanvasToolParam(
        '当前所选视频模型不可用或不支持首帧视频，请选择可用的首帧视频模型后再写分镜表。',
      )
    if (video?.support.firstFrame) {
      const maximum = Math.max(...video.support.durations)
      for (const [index, shot] of params.shots.entries())
        if ((shot.durationSeconds ?? 5) > maximum)
          invalidCanvasToolParam(
            `第 ${index + 1} 镜 ${shot.id} 时长超过 ${video.support.label} 的 ${maximum} 秒上限，请在分镜表里拆镜，保留原镜头 ID 并为新增镜头分配新 ID。`,
          )
    }
    return writeAgentCanvas(context, callId, '拆分剧本', params, (doc, origin) => {
      applyCanvasScriptPlan(doc, params, origin)
    })
  },
})
