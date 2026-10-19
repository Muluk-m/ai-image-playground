import {
  appendScriptEpisode,
  type CanvasNode,
  type CanvasOrigin,
  canvasInputFingerprint,
  canvasMainResult,
  canvasNodeKind,
  canvasNodeRegistry,
  canvasNodeSourceData,
  chooseCanvasResult,
  connectCanvasNodes,
  deleteCanvasNode,
  insertCanvasNode,
  isCanvasStoryboardData,
  layoutCanvasArrange,
  moveCanvasNodes,
  readCanvasDocument,
  recordCanvasResult,
  replaceStoryboardShots,
  type TextNodeData,
  ungroupCanvasNodes,
  updateCanvasNode,
} from '@image-playground/shared'
import { type Static, Type } from 'typebox'
import * as Y from 'yjs'
import { executeCanvasCommand } from '../../canvasCommands'
import { accessCanvasDocument } from '../../canvasSyncStore'
import { isCapabilityEnabled } from '../../capabilities'
import { agentCanvasProject } from '../node-canvas-view'
import { defineAgentTool } from './adapter'
import { AgentToolError } from './errors'
import type { AgentToolAudience, AgentToolContext } from './types'

const id = Type.String({ minLength: 1, maxLength: 128 })
const videoMode = Type.Union([
  Type.Literal('text'),
  Type.Literal('first'),
  Type.Literal('frames'),
  Type.Literal('reference'),
])
const fields = {
  x: Type.Optional(Type.Number({ minimum: -1000000, maximum: 1000000 })),
  y: Type.Optional(Type.Number({ minimum: -1000000, maximum: 1000000 })),
  width: Type.Optional(Type.Number({ minimum: 40, maximum: 5000 })),
  height: Type.Optional(Type.Number({ minimum: 40, maximum: 5000 })),
  name: Type.Optional(Type.String({ maxLength: 120 })),
  text: Type.Optional(Type.String({ maxLength: 100000 })),
  prompt: Type.Optional(Type.String({ maxLength: 100000 })),
  videoMode: Type.Optional(videoMode),
}
const createParameters = Type.Object({
  nodes: Type.Array(
    Type.Object({
      id,
      type: Type.Union([
        Type.Literal('text'),
        Type.Literal('image'),
        Type.Literal('video'),
        Type.Literal('timeline'),
        Type.Literal('storyboard'),
      ]),
      ...fields,
    }),
    { minItems: 1, maxItems: 100 },
  ),
})
const updateParameters = Type.Object({
  nodes: Type.Array(Type.Object({ id, ...fields }), { minItems: 1, maxItems: 100 }),
})
type NodeFields = Static<typeof updateParameters>['nodes'][number]
const modes = ['image', 'video'] as const
const available = (_mode: unknown, audience?: AgentToolAudience) =>
  Boolean(
    audience?.userId &&
      audience.experience === 'canvas' &&
      isCapabilityEnabled('accounts:sync'),
  )
const guidance =
  '修改前用 readCanvas 读取需要的节点。一次调用会原子保存并可整体撤销，不运行生成、不计费。视频节点必须明确给出 videoMode，不能依引用数量推断。'
const invalid = (message: string): never => {
  throw new AgentToolError('invalid_params', message)
}
function getNode(doc: Y.Doc, id: string) {
  return (
    readCanvasDocument(doc).nodes.find((node) => node.id === id) ?? invalid(`节点不存在：${id}`)
  )
}
// `CanvasNode` 是基类型与联合的交集，直接判 `type` 收不住 `data`，所以从这里返回。
function textData(node: CanvasNode): TextNodeData {
  return node.type === 'text' ? node.data : invalid('只能拆分文本剧本节点。')
}
export function patchAgentCanvasNode(doc: Y.Doc, fields: NodeFields, origin: CanvasOrigin) {
  const node = getNode(doc, fields.id)
  const kind = canvasNodeKind(node)
  if (fields.videoMode && kind !== 'video') invalid('只有视频节点可以设置 videoMode。')
  if (
    kind === 'video' &&
    (fields.prompt !== undefined || fields.videoMode !== undefined) &&
    !fields.videoMode
  )
    invalid('修改视频提示词时必须显式指定 videoMode。')
  if (fields.text !== undefined && kind !== 'text') invalid('只有文本节点可以设置 text。')
  if (fields.prompt !== undefined && kind !== 'image' && kind !== 'video')
    invalid('只有图片和视频节点可以设置 prompt。')
  const changesData =
    fields.name !== undefined ||
    fields.text !== undefined ||
    fields.prompt !== undefined ||
    fields.videoMode !== undefined
  let data: CanvasNode['data'] | undefined
  const source = canvasNodeSourceData(doc, node.id)!
  if (changesData && node.type === 'text')
    data = {
      ...node.data,
      ...(fields.text !== undefined ? { text: fields.text, richText: undefined } : {}),
      ...(fields.name !== undefined ? { name: fields.name } : {}),
    }
  else if (changesData && (node.type === 'image' || node.type === 'video'))
    data = {
      ...source,
      ...(fields.name !== undefined ? { name: fields.name } : {}),
      meta: {
        ...('meta' in source ? source.meta : {}),
        ...(fields.prompt !== undefined ? { nodePrompt: fields.prompt } : {}),
        ...(fields.videoMode ? { nodeVideoMode: fields.videoMode } : {}),
      },
    }
  else if (changesData && fields.name !== undefined) invalid('时间线和分镜表不支持此名称字段。')
  updateCanvasNode(
    doc,
    fields.id,
    {
      ...(fields.x !== undefined ? { x: fields.x } : {}),
      ...(fields.y !== undefined ? { y: fields.y } : {}),
      ...(fields.width !== undefined ? { width: fields.width } : {}),
      ...(fields.height !== undefined ? { height: fields.height } : {}),
      ...(data ? { data } : {}),
    },
    origin,
  )
}
async function write(
  context: AgentToolContext,
  toolCallId: string,
  label: string,
  args: unknown,
  mutate: (doc: Y.Doc, origin: CanvasOrigin) => void,
) {
  if (!available(context.mode, context)) invalid('当前会话没有可写的云端节点画布。')
  const project = await agentCanvasProject(context)
  if (!project || !context.userId) return invalid('当前会话没有已同步的云端项目。')
  await context.assertExecution?.()
  const result = await executeCanvasCommand(
    context.userId,
    project.id,
    { turnId: context.turnId, toolCallId, label, args },
    mutate,
  )
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          ...result,
          saved: true,
          note: '已保存到服务端画布，可撤销；没有启动生成任务。',
        }),
      },
    ],
    details: {},
  }
}

export const createNodes = defineAgentTool({
  name: 'createNodes',
  label: '创建节点',
  modes,
  available,
  guidance,
  onError: 'continue',
  description:
    '在当前云端画布批量创建节点。id 必须是新的唯一节点标识；不填位置时排列到已有内容右侧。视频必须显式选择 videoMode: text文生、first首帧、frames首尾帧、reference参考生。不会生成媒体。',
  parameters: createParameters,
  call: () => ({ title: '创建节点' }),
  execute: (context) => async (callId, params) =>
    write(context, callId, '创建节点', params, (doc, origin) => {
      const existing = readCanvasDocument(doc).nodes
      const right = existing.length
        ? Math.max(...existing.map((node) => node.x + node.width)) + 168
        : 0
      let nextY = 0
      for (const node of params.nodes) {
        if (readCanvasDocument(doc).nodes.some((existing) => existing.id === node.id))
          invalid(`节点 id 已存在：${node.id}`)
        if (node.type === 'video' && !node.videoMode)
          invalid('创建视频节点必须显式指定 videoMode。')
        insertCanvasNode(
          doc,
          {
            id: node.id,
            type: node.type === 'video' ? 'image' : node.type,
            x: node.x ?? right,
            y: node.y ?? nextY,
            width: node.width ?? canvasNodeRegistry[node.type].size.width,
            height: node.height ?? canvasNodeRegistry[node.type].size.height,
            data:
              node.type === 'text'
                ? { text: '', fontSize: 16, fill: '#fff' }
                : node.type === 'timeline'
                  ? { clips: [] }
                  : node.type === 'storyboard'
                    ? { shots: [] }
                    : { meta: { nodeKind: node.type } },
          },
          origin,
        )
        patchAgentCanvasNode(doc, node, origin)
        nextY = (node.y ?? nextY) + (node.height ?? canvasNodeRegistry[node.type].size.height) + 168
      }
    }),
})
export const updateNodes = defineAgentTool({
  name: 'updateNodes',
  label: '修改节点',
  modes,
  available,
  guidance,
  onError: 'continue',
  description:
    '批量修改已有节点的位置、尺寸、名称、文本或生成提示词。只更新显式传入字段，不替换整份画布；视频提示词变更必须提供 videoMode。',
  parameters: updateParameters,
  call: () => ({ title: '修改节点' }),
  execute: (context) => async (callId, params) =>
    write(context, callId, '修改节点', params, (doc, origin) => {
      for (const node of params.nodes) patchAgentCanvasNode(doc, node, origin)
    }),
})

export const importCanvasImage = defineAgentTool({
  name: 'importCanvasImage',
  label: '收图进素材',
  modes,
  available,
  onError: 'continue',
  guidance:
    '用户指定画布上的已有图片作为素材时，先 readCanvas 确认来源图片节点和目标素材节点，再调用本工具；不要重新生成或只改提示词后声称已挂图。只有本工具成功保存后才能说已收进素材。',
  description:
    '把当前画布指定图片节点的真实主图收进指定素材节点，新增一个视角候选并成为主结果。保留来源节点、目标名称和已有候选；原子保存、可撤销，不提交生成任务、不产生生成费用。尚无真实图片的来源会被拒绝。',
  parameters: Type.Object({
    imageNodeId: id,
    assetNodeId: id,
    viewLabel: Type.Optional(Type.Literal('sheet')),
  }),
  call: () => ({ title: '收图进素材' }),
  execute: (context) => async (callId, params) =>
    write(context, callId, '收图进素材', params, (doc, origin) => {
      const source = getNode(doc, params.imageNodeId)
      const target = getNode(doc, params.assetNodeId)
      if (target.type !== 'image' || target.data.meta?.nodeKind !== 'asset')
        return invalid('目标必须是素材节点。')
      if (source.id === target.id) invalid('来源图片与目标素材节点不能相同。')
      if (source.type !== 'image' || canvasNodeKind(source) !== 'image' || !source.data.mediaId)
        return invalid('来源节点尚无已同步的真实图片；请等待生成或上传完成，不能声称已挂图。')
      const mediaId = source.data.mediaId
      if (!canvasMainResult(doc, target.id) && target.data.mediaId) {
        recordCanvasResult(
          doc,
          {
            id: `import:${crypto.randomUUID()}`,
            nodeId: target.id,
            kind: 'image',
            source: { type: 'media', mediaId: target.data.mediaId },
            createdAt: Date.now() - 1,
            adopted: true,
            display: {
              mediaId: target.data.mediaId,
              ...(target.data.naturalWidth ? { naturalWidth: target.data.naturalWidth } : {}),
              ...(target.data.naturalHeight ? { naturalHeight: target.data.naturalHeight } : {}),
            },
          },
          origin,
        )
      }
      const resultId = `import:${crypto.randomUUID()}`
      recordCanvasResult(
        doc,
        {
          id: resultId,
          nodeId: target.id,
          kind: 'image',
          source: { type: 'media', mediaId },
          createdAt: Date.now(),
          inputFingerprint: canvasInputFingerprint(doc, target.id),
          ...(params.viewLabel ? { assetViewLabel: params.viewLabel } : {}),
        },
        origin,
      )
      if (
        !chooseCanvasResult(
          doc,
          target.id,
          resultId,
          {
            data: {
              mediaId,
              naturalWidth: source.data.naturalWidth,
              naturalHeight: source.data.naturalHeight,
            },
          },
          origin,
        )
      )
        invalid('图片未能收进素材，请重新读取画布。')
    }),
})
export const connectNodes = defineAgentTool({
  name: 'connectNodes',
  label: '关联节点',
  modes,
  available,
  guidance,
  onError: 'continue',
  description:
    '建立 source 到 target 的有向参考关系。按节点类型校验，不依左右位置限制。任一连线不合法时整批不保存；已有连线保持不变。',
  parameters: Type.Object({
    edges: Type.Array(Type.Object({ source: id, target: id }), { minItems: 1, maxItems: 200 }),
  }),
  call: () => ({ title: '关联节点' }),
  execute: (context) => async (callId, params) =>
    write(context, callId, '关联节点', params, (doc, origin) => {
      for (const edge of params.edges) {
        if (
          readCanvasDocument(doc).edges.some(
            (existing) => existing.source === edge.source && existing.target === edge.target,
          )
        )
          continue
        if (!connectCanvasNodes(doc, edge, origin))
          invalid(`不支持的节点关联：${edge.source} → ${edge.target}`)
      }
    }),
})
export const deleteNodes = defineAgentTool({
  name: 'deleteNodes',
  label: '删除节点',
  modes,
  available,
  guidance,
  onError: 'continue',
  description: '删除指定节点及其连线、分组成员关系，整批可撤销。不会删除原始素材文件。',
  parameters: Type.Object({
    nodeIds: Type.Array(id, { minItems: 1, maxItems: 100, uniqueItems: true }),
  }),
  call: () => ({ title: '删除节点' }),
  execute: (context) => async (callId, params) =>
    write(context, callId, '删除节点', params, (doc, origin) => {
      for (const id of params.nodeIds) getNode(doc, id)
      ungroupCanvasNodes(doc, params.nodeIds, origin)
      for (const id of params.nodeIds) deleteCanvasNode(doc, id, origin)
    }),
})
export const arrangeNodes = defineAgentTool({
  name: 'arrangeNodes',
  label: '整理节点',
  modes,
  available,
  guidance,
  onError: 'continue',
  description:
    '把指定节点按阅读顺序整理成网格，避开未选择的节点。只改变位置，不改正文、类型或引用。',
  parameters: Type.Object({
    nodeIds: Type.Array(id, { minItems: 1, maxItems: 200, uniqueItems: true }),
    columns: Type.Optional(Type.Integer({ minimum: 1, maximum: 12 })),
  }),
  call: () => ({ title: '整理节点' }),
  execute: (context) => async (callId, params) =>
    write(context, callId, '整理节点', params, (doc, origin) => {
      for (const id of params.nodeIds) getNode(doc, id)
      const placements = layoutCanvasArrange(
        [{ columns: params.columns, items: params.nodeIds.map((elementId) => ({ elementId })) }],
        readCanvasDocument(doc).nodes.map((node) => ({
          id: node.id,
          x: node.x,
          y: node.y,
          w: node.width,
          h: node.height,
        })),
      )
      moveCanvasNodes(
        doc,
        placements.map((item) => ({ id: item.elementId, x: item.x, y: item.y })),
        origin,
      )
    }),
})

export const runNodes = defineAgentTool({
  name: 'runNodes',
  label: '建议运行节点',
  modes,
  available,
  onError: 'continue',
  guidance:
    '为画布节点生成图片或视频（包括批量生成）都用 runNodes。先 readCanvas 确认节点。工具成功不等于生成完成；回执说明这次是等用户确认还是直接运行，照回执如实告诉用户。',
  description:
    '为当前云端画布指定节点或分组发起运行。对话卡显示当前批次预估：对话模式下用户在卡上确认后运行；出图模式下直接运行，开跑前用户可撤销。工具本身不生成、不扣费；实际结果应通过 readCanvas 再查看。',
  parameters: Type.Object({
    nodeIds: Type.Array(id, { minItems: 1, maxItems: 200, uniqueItems: true }),
  }),
  call: () => ({ title: '建议运行节点' }),
  execute: (context) => async (_callId, params) => {
    if (!available(context.mode, context)) invalid('当前会话没有可用的云端节点画布。')
    const project = await agentCanvasProject(context)
    if (!project || !context.userId) return invalid('当前会话没有已同步的云端项目。')
    await context.assertExecution?.()
    const doc = new Y.Doc()
    try {
      Y.applyUpdate(doc, await accessCanvasDocument(context.userId, project.id))
      const graph = readCanvasDocument(doc)
      const existing = new Set([
        ...graph.nodes.map((node) => node.id),
        ...(graph.groups ?? []).map((group) => group.id),
      ])
      for (const id of params.nodeIds) if (!existing.has(id)) invalid(`节点或分组不存在：${id}`)
      // 出图模式与生成工具共用每轮自动提交额度；领不到就退回等用户在对话卡确认。
      const autoRun = context.autoSubmit?.take() === true
      const canvasRun = {
        projectId: project.id,
        nodeIds: params.nodeIds,
        ...(autoRun ? { autoRun: true as const } : {}),
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ...canvasRun,
              submitted: false,
              note: autoRun
                ? '出图模式：节点将在几秒后直接运行并计费，用户可在开跑前撤销。不得声称已生成，结果需重新读取画布。'
                : '运行建议已给到用户；用户在对话卡确认前不会提交或扣费。不得声称已生成，结果需重新读取画布。',
            }),
          },
        ],
        details: { canvasRun },
      }
    } finally {
      doc.destroy()
    }
  },
})

export const applyScriptPlan = defineAgentTool({
  name: 'applyScriptPlan',
  label: '拆分剧本',
  modes,
  available,
  onError: 'continue',
  guidance:
    '用户要求拆剧本或续写第 N 集时使用。把已有文本节点拆成无图素材和分镜表并连线；续写只追加该集，不覆盖已有集。不生成媒体，不计费。',
  description:
    '把一个文本剧本拆成没有图片的人物、地点、道具节点和一张分镜表，按引用连到分镜表。可以同时把下一集追加到原剧本。不会提交生图或生视频。',
  parameters: Type.Object({
    scriptNodeId: id,
    storyboardId: id,
    assets: Type.Array(
      Type.Object({
        id,
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
        id,
        description: Type.String({ minLength: 1, maxLength: 10000 }),
        dialogue: Type.Optional(Type.String({ maxLength: 10000 })),
        camera: Type.Optional(Type.String({ maxLength: 200 })),
        durationSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 60 })),
        lookIds: Type.Array(id, { maxItems: 8 }),
        locationId: Type.Optional(id),
      }),
      { minItems: 1, maxItems: 200 },
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
    if (!available(context.mode, context)) invalid('当前会话不能拆分剧本。')
    return write(context, callId, '拆分剧本', params, (doc, origin) => {
      const script = getNode(doc, params.scriptNodeId)
      const scriptText = textData(script)
      const taken = new Set(readCanvasDocument(doc).nodes.map((node) => node.id))
      if (taken.has(params.storyboardId)) invalid(`节点 id 已存在：${params.storyboardId}`)
      for (const asset of params.assets) {
        if (taken.has(asset.id)) invalid(`节点 id 已存在：${asset.id}`)
        taken.add(asset.id)
      }
      const kinds = new Map(params.assets.map((asset) => [asset.id, asset.kind]))
      for (const node of readCanvasDocument(doc).nodes)
        if (
          node.type === 'image' &&
          node.data.meta?.nodeKind === 'asset' &&
          node.data.meta.assetKind
        )
          kinds.set(node.id, node.data.meta.assetKind as (typeof params.assets)[number]['kind'])
      for (const shot of params.shots) {
        for (const look of shot.lookIds)
          if (kinds.get(look) !== 'person') invalid(`人物引用不存在：${look}`)
        if (shot.locationId && kinds.get(shot.locationId) !== 'location')
          invalid(`地点引用不存在：${shot.locationId}`)
      }
      const shots = params.shots.map((shot) => ({
        id: shot.id,
        description: shot.description,
        ...(shot.dialogue ? { dialogue: shot.dialogue } : {}),
        ...(shot.camera ? { camera: shot.camera } : {}),
        ...(shot.durationSeconds !== undefined ? { durationSeconds: shot.durationSeconds } : {}),
        lookIds: [...shot.lookIds],
        ...(shot.locationId ? { locationId: shot.locationId } : {}),
      }))
      if (!isCanvasStoryboardData({ shots })) invalid('分镜表不合法。')
      if (params.episode) {
        const next =
          appendScriptEpisode(scriptText.text, params.episode.number, params.episode.text) ??
          invalid(`第 ${params.episode.number} 集已经在剧本里，或正文是空的。`)
        const { richText: _rich, ...data } = scriptText
        updateCanvasNode(doc, script.id, { data: { ...data, text: next } }, origin)
      }
      const existing = readCanvasDocument(doc).nodes
      const right = Math.max(...existing.map((node) => node.x + node.width)) + 168
      const board = canvasNodeRegistry.storyboard.size
      insertCanvasNode(
        doc,
        {
          id: params.storyboardId,
          type: 'storyboard',
          x: right + canvasNodeRegistry.image.size.width + 168,
          y: script.y,
          width: board.width,
          height: board.height,
          data: { shots: [] },
        },
        origin,
      )
      replaceStoryboardShots(doc, params.storyboardId, shots, origin)
      const written = readCanvasDocument(doc).nodes.find((node) => node.id === params.storyboardId)
      if (written?.type !== 'storyboard' || written.data.shots.length !== shots.length)
        invalid('分镜表没有写入。')
      let nextY = script.y
      for (const asset of params.assets) {
        const size = canvasNodeRegistry.image.size
        insertCanvasNode(
          doc,
          {
            id: asset.id,
            type: 'image',
            x: right,
            y: nextY,
            width: size.width,
            height: size.height,
            data: {
              name: asset.name,
              meta: {
                nodeKind: 'asset',
                assetKind: asset.kind,
                assetDescription: asset.description,
              },
            },
          },
          origin,
        )
        if (!connectCanvasNodes(doc, { source: asset.id, target: params.storyboardId }, origin))
          invalid(`素材无法连接到分镜表：${asset.id}`)
        nextY += size.height + 48
      }
      if (!connectCanvasNodes(doc, { source: script.id, target: params.storyboardId }, origin))
        invalid('剧本无法连接到分镜表。')
    })
  },
})
