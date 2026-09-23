import { agentTitleLine } from '@image-playground/shared'
import { Type } from 'typebox'
import { requireAgentImages } from '../images'
import { prepareMaskedEdit } from '../masked-edit'
import { defineAgentTool } from './adapter'
import { AgentToolError } from './errors'
import { agentImageCount, imageCountParameter, reviewParameter } from './queueParams'
import { draftQueueTask, resolveAgentModel } from './queueTask'

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
      '图片 id 列表：第一张是唯一编辑目标，产出落在它旁边；后续是用户指定或明确委托用途的参考图（如换款、范例复刻、补足背面结构），不是其它待处理目标。id 来自用户引用、readLibrary、fetchImage 取回的网图或本轮产物。',
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
  reviewAfterCompletion: reviewParameter,
})

export const editImage = defineAgentTool({
  name: 'editImage',
  // 视频轮也要它：首帧不满意先改图，比重出一条片子便宜得多。
  modes: ['image', 'video'],
  label: '改图',
  // 拟稿即收尾：对话模式下执行指令交给用户确认，不提交任务、不落画布。出图模式当场提交。
  confirms: true,
  description:
    '在已有的图上发起一次改图，产出落到画布上源图旁边，源图不动。一次调用只处理一张目标图，可附明确用途的参考图。卡片上给用户看的是真正会送进上游的那一份执行指令。有选区的局部改图提交成功后系统一定会唤醒你复核候选；目标图遮罩会随请求提交，要求只改圈选部分，调用成功不代表效果已验收。提交前要不要先等用户确认由系统决定，见系统提示词里的生成流程那一段——工具返回的那句话会说清这一次到底提交了没有，照它说。',
  guidance:
    '改已有图用 editImage。逐张修改时每个目标各调用一次，各自写提示词，默认只带当前目标；明确要求的参考放在目标后面。同一目标同一方案的多版本用 n，未指定张数默认 1；不同角度或方案分别调用。有遮罩时以圈选位置指认对象，不能以其他同名实例替代指定目标。参考图圈选表示参考来源，不是修改对象。用户没说过的颜色、材质、风格不要替他写进提示词。不要为同一件事调第二次。',
  parameters,
  // 模型可以换一个图片 id 重试，所以拿不到图不该把整轮拖垮。
  onError: 'continue',
  target: (params) => resolveAgentModel('image', params?.model),
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
      ...(Array.isArray(imageIds)
        ? { references: imageIds.filter((id): id is string => typeof id === 'string') }
        : {}),
    }
  },
  execute(context) {
    const originalAuthorization = context.authorization?.().instructions
    return async (toolCallId, params, signal) => {
      const snapshot = context.authorization?.()
      // 只有明确的参数关卡（图片 id、选区绑定、授权原文）拦下的才算参数不成立；读库、读对象存储、
      // 解码出的错不是模型的参数问题，照旧落进未分类。
      const images = await requireAgentImages(context.images, params.imageIds)
      if (
        (context.maskedEditPlan?.protected || context.images.masked) &&
        !images.some((image) => image.maskDataUrl)
      ) {
        throw new AgentToolError(
          'invalid_params',
          '本轮存在用户选区，不能静默改成无选区编辑；请核对目标和参考，或先请用户取消选区',
        )
      }
      const prepared = await prepareMaskedEdit(
        images,
        params.selectionBindings,
        snapshot?.instructions ?? '',
        params.requestQuote,
      )
      if (signal?.aborted) throw new AgentToolError('cancelled', '这一轮被中止了')
      if (snapshot !== context.authorization?.())
        throw new AgentToolError('invalid_params', '用户原文已更新，请按最新原文核对后执行')
      // 局部改图（有选区、遮罩、分方案摘录或连锁后续）的候选必须复核：确认提交后一定唤醒
      // 智能体回来检查，不由它选。
      const local =
        Boolean(prepared) ||
        Boolean(images[0]?.maskDataUrl) ||
        context.images.masked ||
        Boolean(context.maskedEditPlan?.protected) ||
        Boolean(params.requestQuote) ||
        Boolean(params.deferredEdits?.length)
      return draftQueueTask(
        context,
        {
          toolName: 'editImage',
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
          // 真遮罩编辑的执行指令由服务端按用户原文与选区拼出来：卡上给用户看的、他改的、
          // 确认时提交的都是这一句。
          prompt: prepared?.prompt ?? params.prompt,
          n: params.n,
          inputImages: prepared?.inputImages ?? images.map((image) => image.dataUrl),
          ...(images[0]?.maskDataUrl ? { mask: images[0].maskDataUrl } : {}),
          anchorObjectId: images[0]!.imageId,
          review: local || params.reviewAfterCompletion === true,
        },
        signal,
      )
    }
  },
})
