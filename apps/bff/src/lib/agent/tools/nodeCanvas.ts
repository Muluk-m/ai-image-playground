import {
  type CanvasNode,
  type CanvasOrigin,
  canvasNodeKind,
  canvasNodeRegistry,
  canvasNodeSourceData,
  connectCanvasNodes,
  deleteCanvasNode,
  insertCanvasNode,
  layoutCanvasArrange,
  moveCanvasNodes,
  readCanvasDocument,
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
      audience.nodeCanvas &&
      audience.experience === 'canvas' &&
      isCapabilityEnabled('canvas:nodes') &&
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
  if (
    !available(context.mode, {
      ...context,
      nodeCanvas: context.canvas?.selectedNodeIds !== undefined,
    })
  )
    invalid('当前会话没有可写的云端节点画布。')
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
    '先 readCanvas 确认节点。只给出运行建议，不能把工具成功当作生成完成；用户须在对话卡检查预估并在画布二次确认。',
  description:
    '为当前云端画布指定节点或分组准备运行建议。对话卡显示当前批次预估，用户检查后高亮节点并再次确认才提交任务。工具本身不生成、不扣费；实际结果应通过 readCanvas 再查看。',
  parameters: Type.Object({
    nodeIds: Type.Array(id, { minItems: 1, maxItems: 200, uniqueItems: true }),
  }),
  call: () => ({ title: '建议运行节点' }),
  execute: (context) => async (_callId, params) => {
    if (
      !available(context.mode, {
        ...context,
        nodeCanvas: context.canvas?.selectedNodeIds !== undefined,
      })
    )
      invalid('当前会话没有可用的云端节点画布。')
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
      const canvasRun = { projectId: project.id, nodeIds: params.nodeIds }
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ...canvasRun,
              submitted: false,
              note: '运行建议已给到用户；检查预估并二次确认前不会提交或扣费。不得声称已生成，结果需重新读取画布。',
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
