import type { CanvasOrigin } from '@image-playground/shared'
import { type Static, Type } from 'typebox'
import type * as Y from 'yjs'
import { agentVideoAvailable } from '../../../../lib/agent/video-models'
import {
  arrangeCanvasNodes,
  type CanvasNodeImageSource,
  type CanvasNodePatchFields,
  type CanvasVideoModeCheck,
  connectCanvasNodeEdges,
  deleteCanvasNodes,
  importImageIntoAssetNode,
  insertCanvasNodes,
  missingNodeMessage,
  patchCanvasNode,
} from '../../../canvas'
import type { AgentToolContext } from '../../contracts'
import { defineAgentTool } from '../adapter'
import {
  invalidCanvasToolParam,
  nodeCanvasAvailable,
  nodeCanvasGuidance,
  nodeCanvasModes,
  nodeCommonFields,
  nodeIdSchema,
  runCanvasOp,
  throwNoVideoModel,
  videoModeCheck,
  writeAgentCanvas,
} from './node-shared'

export { missingNodeMessage }

const createParameters = Type.Object({
  nodes: Type.Array(
    Type.Object({
      id: nodeIdSchema,
      type: Type.Union([
        Type.Literal('text'),
        Type.Literal('image'),
        Type.Literal('video'),
        Type.Literal('timeline'),
        Type.Literal('storyboard'),
      ]),
      ...nodeCommonFields,
      imageId: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 128,
          description:
            '仅 image 节点：用对话里已有图片的 ID（本轮附图或会话图片）建成素材节点，节点直接显示这张图，可作为参考连给生成节点。',
        }),
      ),
    }),
    { minItems: 1, maxItems: 100 },
  ),
})

const updateParameters = Type.Object({
  nodes: Type.Array(Type.Object({ id: nodeIdSchema, ...nodeCommonFields }), {
    minItems: 1,
    maxItems: 100,
  }),
})

export function patchAgentCanvasNode(
  doc: Y.Doc,
  fields: CanvasNodePatchFields,
  origin: CanvasOrigin,
  checkVideoMode?: CanvasVideoModeCheck,
): void {
  runCanvasOp(() => patchCanvasNode(doc, fields, origin, checkVideoMode))
}

/**
 * 对话里的图要接进节点画布，只能先落成带云媒体的素材节点。没有这一步时模型只能请用户把附图拖进画布
 * 再选中（2026-10-19 会话 e71a6e9e 连续四轮卡在这里）。
 */
async function nodeImageSources(
  context: AgentToolContext,
  nodes: Static<typeof createParameters>['nodes'],
): Promise<Map<string, CanvasNodeImageSource>> {
  const wanted = nodes.filter((node) => node.imageId)
  for (const node of wanted)
    if (node.type !== 'image') invalidCanvasToolParam(`只有 image 节点可以设置 imageId：${node.id}`)
  if (!wanted.length) return new Map()
  const resolved = await context.images.resolveMediaReferences(wanted.map((node) => node.imageId!))
  const sources = new Map<string, CanvasNodeImageSource>()
  for (const [index, node] of wanted.entries()) {
    const reference = resolved[index]
    if (!reference) {
      const available = context.images.references.map((one) => one.imageId).join('、')
      invalidCanvasToolParam(
        `找不到可用作素材的图片：${node.imageId}。${available ? `本轮可用的图片 ID：${available}。` : '请让用户重新上传这张图。'}`,
      )
    }
    sources.set(node.id, {
      mediaId: reference!.mediaId,
      ...(reference!.name ? { name: reference!.name } : {}),
    })
  }
  return sources
}

export const createNodes = defineAgentTool({
  name: 'createNodes',
  label: '创建节点',
  modes: nodeCanvasModes,
  available: nodeCanvasAvailable,
  guidance: nodeCanvasGuidance,
  onError: 'continue',
  description:
    '在当前云端画布批量创建节点。id 必须是新的唯一节点标识；不填位置时排列到已有内容右侧。视频必须显式选择 videoMode: text文生、first首帧、frames首尾帧、reference参考生。不会生成媒体。',
  parameters: createParameters,
  call: () => ({ title: '创建节点' }),
  execute: (context) => async (callId, params) => {
    if (params.nodes.some((node) => node.type === 'video') && !agentVideoAvailable())
      throwNoVideoModel()
    const sources = await nodeImageSources(context, params.nodes)
    return writeAgentCanvas(context, callId, '创建节点', params, (doc, origin) => {
      insertCanvasNodes(doc, params.nodes, sources, origin, videoModeCheck(context.params))
    })
  },
})

export const updateNodes = defineAgentTool({
  name: 'updateNodes',
  label: '修改节点',
  modes: nodeCanvasModes,
  available: nodeCanvasAvailable,
  guidance: nodeCanvasGuidance,
  onError: 'continue',
  description:
    '批量修改已有节点的位置、尺寸、名称、文本或生成提示词。只更新显式传入字段，不替换整份画布；视频提示词变更必须提供 videoMode。',
  parameters: updateParameters,
  call: () => ({ title: '修改节点' }),
  execute: (context) => async (callId, params) =>
    writeAgentCanvas(context, callId, '修改节点', params, (doc, origin) => {
      for (const node of params.nodes)
        patchCanvasNode(doc, node, origin, videoModeCheck(context.params))
    }),
})

export const importCanvasImage = defineAgentTool({
  name: 'importCanvasImage',
  label: '收图进素材',
  modes: nodeCanvasModes,
  available: nodeCanvasAvailable,
  onError: 'continue',
  guidance:
    '用户指定画布上的已有图片作为素材时，先 readCanvas 确认来源图片节点和目标素材节点，再调用本工具；不要重新生成或只改提示词后声称已挂图。只有本工具成功保存后才能说已收进素材。',
  description:
    '把当前画布指定图片节点的真实主图收进指定素材节点，新增一个视角候选并成为主结果。保留来源节点、目标名称和已有候选；原子保存、可撤销，不提交生成任务、不产生生成费用。尚无真实图片的来源会被拒绝。',
  parameters: Type.Object({
    imageNodeId: nodeIdSchema,
    assetNodeId: nodeIdSchema,
    viewLabel: Type.Optional(Type.Literal('sheet')),
  }),
  call: () => ({ title: '收图进素材' }),
  execute: (context) => async (callId, params) =>
    writeAgentCanvas(context, callId, '收图进素材', params, (doc, origin) => {
      importImageIntoAssetNode(doc, params, origin)
    }),
})

export const connectNodes = defineAgentTool({
  name: 'connectNodes',
  label: '关联节点',
  modes: nodeCanvasModes,
  available: nodeCanvasAvailable,
  guidance: nodeCanvasGuidance,
  onError: 'continue',
  description:
    '建立 source 到 target 的有向参考关系。按节点类型校验，不依左右位置限制。任一连线不合法时整批不保存；已有连线保持不变。',
  parameters: Type.Object({
    edges: Type.Array(Type.Object({ source: nodeIdSchema, target: nodeIdSchema }), {
      minItems: 1,
      maxItems: 200,
    }),
  }),
  call: () => ({ title: '关联节点' }),
  execute: (context) => async (callId, params) =>
    writeAgentCanvas(context, callId, '关联节点', params, (doc, origin) => {
      connectCanvasNodeEdges(doc, params.edges, origin)
    }),
})

export const deleteNodes = defineAgentTool({
  name: 'deleteNodes',
  label: '删除节点',
  modes: nodeCanvasModes,
  available: nodeCanvasAvailable,
  guidance: nodeCanvasGuidance,
  onError: 'continue',
  description: '删除指定节点及其连线、分组成员关系，整批可撤销。不会删除原始素材文件。',
  parameters: Type.Object({
    nodeIds: Type.Array(nodeIdSchema, { minItems: 1, maxItems: 100, uniqueItems: true }),
  }),
  call: () => ({ title: '删除节点' }),
  execute: (context) => async (callId, params) =>
    writeAgentCanvas(context, callId, '删除节点', params, (doc, origin) => {
      deleteCanvasNodes(doc, params.nodeIds, origin)
    }),
})

export const arrangeNodes = defineAgentTool({
  name: 'arrangeNodes',
  label: '整理节点',
  modes: nodeCanvasModes,
  available: nodeCanvasAvailable,
  guidance: nodeCanvasGuidance,
  onError: 'continue',
  description:
    '把指定节点按阅读顺序整理成网格，避开未选择的节点。只改变位置，不改正文、类型或引用。',
  parameters: Type.Object({
    nodeIds: Type.Array(nodeIdSchema, { minItems: 1, maxItems: 200, uniqueItems: true }),
    columns: Type.Optional(Type.Integer({ minimum: 1, maximum: 12 })),
  }),
  call: () => ({ title: '整理节点' }),
  execute: (context) => async (callId, params) =>
    writeAgentCanvas(context, callId, '整理节点', params, (doc, origin) => {
      arrangeCanvasNodes(doc, params.nodeIds, params.columns, origin)
    }),
})
