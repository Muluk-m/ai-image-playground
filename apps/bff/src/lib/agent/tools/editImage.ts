import { agentTitleLine } from '@image-playground/shared'
import { Type } from 'typebox'
import { requireAgentImages } from '../images'
import { prepareMaskedEdit } from '../masked-edit'
import { defineAgentTool } from './adapter'
import { agentImageCount, imageCountParameter } from './queueParams'
import { runQueueTask } from './queueTask'

const TITLE_MAX_CHARS = 40
const MAX_REFERENCES = 4

const parameters = Type.Object({
  prompt: Type.String({
    description:
      '无选区时忠实表达用户要求；有选区时只写简短任务摘要，执行指令由服务端从用户原文与选区绑定生成。不得新增用户未授权的要求。有遮罩时以目标图圈选范围为编辑边界，仅修改用户要求的对象，保留其它内容（包括圈内未要求修改的文字与背景）。保留范围不能覆盖本次修改目标。参考图有圈选时，明确描述参考选区的位置和对象。用用户说话的语言写。',
  }),
  imageIds: Type.Array(Type.String(), {
    minItems: 1,
    maxItems: MAX_REFERENCES,
    description:
      '参考图的图片 id，第一张是要改的那张，产出会放在它旁边。id 来自用户引用的图、readLibrary 查到的素材，或本轮刚生成的图。',
  }),
  selectionBindings: Type.Optional(
    Type.Array(
      Type.Object({
        imageId: Type.String(),
        selectionId: Type.String(),
        objects: Type.Optional(
          Type.String({
            maxLength: 500,
            description:
              '仅描述选区里可见的具体对象及方位，包含对象类别、具体实例与相对位置；不要写修改动作、方向或保留要求。不在选区覆盖像素内的对象不能列入，应先澄清。',
          }),
        ),
      }),
      {
        description:
          '任意输入图片有选区时必须提供。逐一复制视觉证据的图片真实 ID 和选区 ID，目标和参考的选区都不能遗漏。',
      },
    ),
  ),
  requestQuote: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 3000,
      description:
        '若一轮要分别执行多个方案，原样摘录当前方案对应的用户原文；不可自创修改方向或属性。单一操作可省略。',
    }),
  ),
  deferredEdits: Type.Optional(
    Type.Array(
      Type.Object({
        targetImageId: Type.String(),
        selectionId: Type.Optional(Type.String()),
        requestQuote: Type.String({ minLength: 1, maxLength: 3000 }),
        n: imageCountParameter,
      }),
      {
        maxItems: 8,
        description:
          '仅当用户明确要求依赖当前产物的后续编辑时，在首次调用中预先列明后续目标、该目标选区 ID、对应的用户原文和张数。得到产物后可用其 ID 作参考执行列明的操作；不能临时追加或重复生成。',
      },
    ),
  ),
  n: imageCountParameter,
})

export const editImage = defineAgentTool({
  name: 'editImage',
  // 视频轮也要它：首帧不满意先改图，比重出一条片子便宜得多。
  modes: ['image', 'video'],
  label: '改图',
  description:
    '在已有的图上修改指定内容，产出落到画布上源图旁边，源图不动。目标图遮罩会随请求提交，要求只改圈选部分；接口成功不代表效果已验收。',
  guidance:
    '用户指着某张图说要改时调改图工具，参考图用他引用的那张，产出落在源图旁边，源图不动。版本数按需求用 n 指定，未要求多张时只出一张；不同修改方案分别调用。有遮罩时以圈选位置指认对象，不能以其他同名实例替代指定目标。参考图圈选表示参考来源，不是修改对象。',
  parameters,
  // 模型可以换一个图片 id 重试，所以拿不到图不该把整轮拖垮。
  onError: 'continue',
  call({ prompt, imageIds, selectionBindings, n }) {
    const written = typeof prompt === 'string' ? prompt : undefined
    // 第一张参考图就是被改的那张，产出贴着它放——与执行时的 `anchorObjectId` 取同一项。
    const first = Array.isArray(imageIds) ? imageIds[0] : undefined
    return {
      title: selectionBindings?.length
        ? '编辑选区'
        : written?.trim()
          ? agentTitleLine(written, TITLE_MAX_CHARS)
          : '改图',
      outputCount: agentImageCount({ n }),
      ...(typeof first === 'string' && first ? { anchor: first } : {}),
      ...(written ? { prompt: written } : {}),
    }
  },
  execute(context) {
    const originalAuthorization = context.authorization?.().instructions
    return async (toolCallId, params, signal, onUpdate) => {
      const snapshot = context.authorization?.()
      const images = await requireAgentImages(context.images, params.imageIds)
      if (
        (context.maskedEditPlan?.protected || context.images.masked) &&
        !images.some((image) => image.maskDataUrl)
      ) {
        throw new Error(
          '本轮存在用户选区，不能静默改成无选区编辑；请核对目标和参考，或先请用户取消选区',
        )
      }
      const prepared = await prepareMaskedEdit(
        images,
        params.selectionBindings,
        snapshot?.instructions ?? '',
        params.requestQuote,
      )
      if (signal?.aborted || snapshot !== context.authorization?.())
        throw new Error('修改要求已更新，请按最新要求核对后执行')
      return runQueueTask(
        context,
        {
          media: 'image',
          toolCallId,
          // 只有真遮罩编辑参与内容去重：换个 tool-call id 重来一次要认得出来。
          ...(prepared
            ? {
                maskedContent: {
                  imageIds: images.map((image) => image.imageId),
                  ...(params.selectionBindings
                    ? { selectionBindings: params.selectionBindings }
                    : {}),
                  quote: params.requestQuote ?? originalAuthorization,
                },
              }
            : {}),
          ...(params.requestQuote
            ? {
                maskedOperation: {
                  targetImageId: images[0]!.imageId,
                  selectionId: params.selectionBindings?.find(
                    (binding) => binding.imageId === images[0]!.imageId,
                  )?.selectionId,
                  requestQuote: params.requestQuote,
                  n: params.n,
                },
              }
            : {}),
          prompt: prepared?.prompt ?? params.prompt,
          n: params.n,
          inputImages: prepared?.inputImages ?? images.map((image) => image.dataUrl),
          ...(images[0]?.maskDataUrl ? { mask: images[0].maskDataUrl } : {}),
          anchorObjectId: images[0]!.imageId,
        },
        signal,
        onUpdate,
      )
    }
  },
})
