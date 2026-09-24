import {
  type AgentLookSaveCard,
  agentTitleLine,
  LOOK_PURPOSES,
  SYNC_ID_MAX_LENGTH,
  SYNC_LOOK_BODY_MAX_LENGTH,
  SYNC_LOOK_DESCRIPTION_MAX_LENGTH,
  SYNC_LOOK_REFERENCE_IMAGES_MAX,
  SYNC_LOOK_SLOT_COUNT_MAX,
  SYNC_NAME_MAX_LENGTH,
} from '@image-playground/shared'
import { Type } from 'typebox'
import { getChannels, resolveModelMedia } from '../../channels'
import { agentSaveToolsAvailable } from '../saves'
import { defineAgentTool } from './adapter'
import { AgentToolError } from './errors'
import { resolveAgentModel } from './queueTask'
import type { AgentToolContext } from './types'

const TITLE_MAX_CHARS = 24

const parameters = Type.Object({
  id: Type.Optional(
    Type.String({
      maxLength: SYNC_ID_MAX_LENGTH,
      description:
        '要改写的那条模板的 id（用户说「再调一版」时用）。留空即新建一条；不要凭空编一个 id。',
    }),
  ),
  name: Type.String({
    maxLength: SYNC_NAME_MAX_LENGTH,
    description: '模板名，说清它出的是什么效果。',
  }),
  description: Type.String({
    maxLength: SYNC_LOOK_DESCRIPTION_MAX_LENGTH,
    description: '一句话说清什么时候该用它。它就是这条模板作为技能时的「何时用」。',
  }),
  purpose: Type.Union(
    LOOK_PURPOSES.map((one) => Type.Literal(one)),
    { description: '用途：hero 主图、poster 海报、scene 场景图、detail 详情图。' },
  ),
  body: Type.String({
    maxLength: SYNC_LOOK_BODY_MAX_LENGTH,
    description:
      '模板正文，按固定七节写：## 1. 一句话目标 / ## 2. 适用场景 / ## 3. 需要用户提供的输入 / ## 4. 工作流程 / ## 5. 输出要求 / ## 6. 约束与禁忌 / ## 7. 示例。第 3 节列的就是素材位。',
  }),
  model: Type.Optional(
    Type.String({
      maxLength: 128,
      description:
        '一般不填：留空就钉这一轮正在用的出图模型。只有效果是用另一个模型调出来的才填，填的必须是这个部署真有的模型 id，不要凭印象写。',
    }),
  ),
  size: Type.Optional(
    Type.String({
      maxLength: 32,
      description:
        '一般不填：留空就钉这一轮的尺寸。效果是用别的尺寸调出来的才填，与出图参数同一套写法。',
    }),
  ),
  slotCount: Type.Integer({
    minimum: 0,
    maximum: SYNC_LOOK_SLOT_COUNT_MAX,
    description: '要几条素材填进去，与正文第 3 节列的条目数一致。',
  }),
  referenceImageIds: Type.Array(Type.String(), {
    maxItems: SYNC_LOOK_REFERENCE_IMAGES_MAX,
    description: '这条模板每次出图都要带上的参考图 id（风格参考、版式参考）；没有就给空数组。',
  }),
  coverImageId: Type.Optional(
    Type.String({
      description: '封面图 id：用这条模板出过的、最能代表效果的那一张。还没试出来就留空。',
    }),
  ),
})

/** 这个部署出得了图的模型。钉一个不在清单里的模型，这条模板出不了图，只能标「需重新调试」。 */
function imageModelIds(): string[] {
  return [
    ...new Set(
      getChannels().flatMap((channel) =>
        channel.models.filter((model) => (model.media ?? 'image') === 'image').map((one) => one.id),
      ),
    ),
  ]
}

/**
 * 卡上的图片 id 一律是**真** id（模型可能按 `image 2` 这类编号说话），并借这一趟确认每张此刻
 * 都取得到：等用户按下保存才发现少图，已经晚了一轮对话。
 */
async function identifyImages(
  context: AgentToolContext,
  imageIds: readonly string[],
): Promise<string[]> {
  const resolved = await Promise.all(
    imageIds.map(async (imageId) => ({
      imageId,
      image: await context.images.resolve(imageId, 'preview'),
    })),
  )
  const missing = resolved.flatMap((one) => (one.image ? [] : [one.imageId]))
  if (missing.length)
    throw new AgentToolError(
      'invalid_params',
      `这些 id 取不到图，没有存成卡片：${missing.join('、')}。核对后用真正的图片 id 重试。`,
    )
  return resolved.map((one) => one.image!.imageId)
}

/**
 * 存模板：把调好的这套出图办法写成一条模板，交给用户保存。
 *
 * 模板的形态就是一份技能：`body` 是分节正文，其余字段是它的 frontmatter。保存之后它会以
 * `look-<id>` 的名字出现在这个用户的技能清单里，`/look-<id>` 直接调得动。
 */
export const saveLook = defineAgentTool({
  name: 'saveLook',
  modes: ['image'],
  label: '存为模板',
  description:
    '把调好的这套出图办法写成一条模板交给用户保存。模板钉死模型与尺寸（默认就是这一轮的），正文按固定七节写，第 3 节列出要用户提供的素材。调用它只是把卡片放到对话里：真正入库是用户在卡上按下保存，他按了你会收到一条消息。带 id 就是改写已有的那条。',
  guidance:
    '效果调到用户满意之后，用存为模板工具把这套办法写成模板交给他保存；入库由用户按那一下，之后请他拿一条素材试一张，不满意就带着同一个 id 再存一版。',
  parameters,
  onError: 'continue',
  available: (_mode, audience) => agentSaveToolsAvailable(audience),
  call: ({ name }) => ({
    title: `存为模板：${agentTitleLine(typeof name === 'string' ? name : '', TITLE_MAX_CHARS) || '未命名'}`,
  }),
  execute: (context) => async (_toolCallId, raw) => {
    const name = raw.name.trim()
    if (!name) throw new AgentToolError('invalid_params', '模板要有名字，给它起一个再重试。')
    const body = raw.body.trim()
    if (!body)
      throw new AgentToolError('invalid_params', '模板正文是空的：把七节正文写全了再存一次。')
    // 不填就钉这一轮正在用的模型与尺寸：模型看不见这一轮的参数，让它自己写只能靠猜。
    const model =
      raw.model?.trim() || resolveAgentModel('image', context.params?.model)?.model || ''
    // 钉一个这个部署没有的模型，等于存下一条出不了图的模板：当场说清，别让用户事后才发现。
    if (resolveModelMedia(model) !== 'image')
      throw new AgentToolError(
        'invalid_params',
        `这个部署没有出图模型 ${model || '（空）'}，模板没有存成卡片。可用的出图模型：${imageModelIds().join('、') || '（无）'}。用真正出成这个效果的那个模型 id 重试。`,
      )
    const [referenceImageIds, cover] = await Promise.all([
      identifyImages(context, raw.referenceImageIds),
      raw.coverImageId ? identifyImages(context, [raw.coverImageId]) : [],
    ])
    const card: AgentLookSaveCard = {
      kind: 'look',
      status: 'pending',
      ...(raw.id?.trim() ? { lookId: raw.id.trim() } : {}),
      name,
      description: raw.description.trim(),
      purpose: raw.purpose,
      body,
      model,
      size: raw.size?.trim() || context.params?.size || 'auto',
      slotCount: raw.slotCount,
      referenceImageIds,
      ...(cover[0] ? { coverImageId: cover[0] } : {}),
    }
    return {
      content: [
        {
          type: 'text',
          text: `已经把这套办法备成一张「存为模板」的卡片交给用户：${card.name}（${card.model} · ${card.size} · ${card.slotCount} 个素材位）。他在卡上按下保存才会进模板库——他也可能改掉名字。收到「用户已保存模板」之前，不要说模板已经存好；存好之后请他拿一条素材试一张。`,
        },
      ],
      details: { saveCard: card },
    }
  },
})
