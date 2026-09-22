import {
  type AgentAssetSaveCard,
  type AgentSaveCardView,
  ASSET_BACKGROUNDS,
  ASSET_KINDS,
  ASSET_VIEW_LABELS,
  ASSET_VIEW_SOURCES,
  agentTitleLine,
  SYNC_ASSET_VIEWS_MAX,
  SYNC_NAME_MAX_LENGTH,
} from '@image-playground/shared'
import { Type } from 'typebox'
import { agentSaveToolsAvailable } from '../saves'
import { defineAgentTool } from './adapter'
import { AgentToolError } from './errors'
import type { AgentToolContext } from './types'

const TITLE_MAX_CHARS = 24

const parameters = Type.Object({
  name: Type.String({
    maxLength: SYNC_NAME_MAX_LENGTH,
    description: '素材名，用户能一眼认出是哪件东西；用户说过怎么叫就用他的说法。',
  }),
  kind: Type.Union(
    ASSET_KINDS.map((one) => Type.Literal(one)),
    { description: '这组图拍的是什么：product 是商品，person 是人。' },
  ),
  background: Type.Union(
    ASSET_BACKGROUNDS.map((one) => Type.Literal(one)),
    {
      description:
        '背景状态。transparent 只在出图的模型原生支持透明输出、并且确实出成了透明底时才填；拿不准填 solid。',
    },
  ),
  views: Type.Array(
    Type.Object({
      imageId: Type.String({ description: '这张视角图的图片 id。' }),
      label: Type.Union(
        ASSET_VIEW_LABELS.map((one) => Type.Literal(one)),
        {
          description:
            '这张是哪个视角：front 正面、side 侧面、back 背面、detail 细节、sheet 正侧背拼在一张里、none 说不上来。',
        },
      ),
      source: Type.Union(
        ASSET_VIEW_SOURCES.map((one) => Type.Literal(one)),
        { description: 'upload 是用户自己给的原图，generated 是这轮生成出来的。' },
      ),
    }),
    {
      minItems: 1,
      maxItems: SYNC_ASSET_VIEWS_MAX,
      description:
        '这条素材的全部视角，按顺序，第一张是封面。用户上传的原图也一并带上：它是这件东西的凭据。',
    },
  ),
})

/**
 * 卡上的图片 id 一律是**真** id：模型可能按 `image 2` 这类编号说话，那种写法出了这一轮就没人
 * 认得。同时借这一趟确认每张图此刻都取得到——卡片要到用户按下保存才去取字节，等那时才发现
 * 少了一张，已经晚了一轮对话。
 */
async function identifyViews(
  context: AgentToolContext,
  views: readonly AgentSaveCardView[],
): Promise<AgentSaveCardView[]> {
  const resolved = await Promise.all(
    views.map(async (view) => ({
      view,
      image: await context.images.resolve(view.imageId, 'preview'),
    })),
  )
  const missing = resolved.flatMap((one) => (one.image ? [] : [one.view.imageId]))
  if (missing.length)
    throw new AgentToolError(
      'invalid_params',
      `这些 id 取不到图，没有存成卡片：${missing.join('、')}。核对后用真正的图片 id 重试。`,
    )
  return resolved.map(({ view, image }) => ({ ...view, imageId: image!.imageId }))
}

/**
 * 存素材：把这一轮备好的几张图拢成一条素材，交给用户按下保存。
 *
 * 工具不写任何记录——素材库是浏览器里的东西。它只产出一张卡片（{@link AgentAssetSaveCard}），
 * 落在结果块里；用户按下保存后由 `POST .../saves` 把卡改写成已保存，并排一条话回来。
 */
export const saveAsset = defineAgentTool({
  name: 'saveAsset',
  // 素材是出图这条路上的东西：视频轮里没有「把这组图存成素材」这件事。
  modes: ['image'],
  label: '存为素材',
  description:
    '把这一轮备好的几张图拢成一条素材，交给用户保存。素材是同一件东西的一组视角（正面、侧面、细节、正侧背拼图……），之后出图时整组一起用。调用它只是把卡片放到对话里：真正入库是用户在卡上按下保存，他按了你会收到一条消息。不要自己宣布已经存好。',
  guidance:
    '备好一组素材图之后，用存为素材工具把它们拢成一条素材交给用户保存；入库由用户按那一下，你收到「用户已保存」之前不要说素材已经在库里。',
  parameters,
  // 存不成多半是 id 写错：模型换个 id 再来一次就行，不该把整轮停下。
  onError: 'continue',
  available: (_mode, audience) => agentSaveToolsAvailable(audience),
  // 卡片不落画布，也没有送进上游的提示词，所以起跑时只有一行标题。
  call: ({ name }) => ({
    title: `存为素材：${agentTitleLine(typeof name === 'string' ? name : '', TITLE_MAX_CHARS) || '未命名'}`,
  }),
  execute: (context) => async (_toolCallId, params) => {
    const { name, kind, background, views } = params
    const trimmed = name.trim()
    if (!trimmed) throw new AgentToolError('invalid_params', '素材要有名字，给它起一个再重试。')
    const card: AgentAssetSaveCard = {
      kind: 'asset',
      status: 'pending',
      name: trimmed,
      assetKind: kind,
      background,
      views: await identifyViews(context, views),
    }
    return {
      content: [
        {
          type: 'text',
          text: `已经把这 ${card.views.length} 张图备成一张「存为素材」的卡片交给用户：${card.name}。他在卡上按下保存才会进素材库——他也可能去掉其中几张或改掉名字。收到「用户已保存素材」之前，不要说素材已经存好。`,
        },
      ],
      details: { saveCard: card },
    }
  },
})
