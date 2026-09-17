import type { AgentTool } from '@earendil-works/pi-agent-core'
import { agentTitleLine } from '@image-playground/shared'
import { Type } from 'typebox'
import { requireAgentImages } from '../images'
import { agentImageCount, imageCountParameter } from './queueParams'
import { runQueueTask } from './queueTask'
import type { AgentToolDefinition, AgentToolDetails } from './types'

const TITLE_MAX_CHARS = 40
const MAX_REFERENCES = 4

const parameters = Type.Object({
  prompt: Type.String({
    description:
      '忠实表达用户要求，不增加未指定的移动方向、位置、款式或修改对象。有遮罩时以目标图圈选范围为编辑边界，仅修改用户要求的对象，保留其它内容（包括圈内未要求修改的文字与背景）。不得把用户明确要改的示意图局部误列为保留项。参考图有圈选时，明确描述参考选区的位置和对象。用用户说话的语言写。',
  }),
  imageIds: Type.Array(Type.String(), {
    minItems: 1,
    maxItems: MAX_REFERENCES,
    description:
      '参考图的图片 id，第一张是要改的那张，产出会放在它旁边。id 来自用户引用的图、readLibrary 查到的素材，或本轮刚生成的图。',
  }),
  n: imageCountParameter,
})

function title(args: unknown): string {
  const prompt = (args as { prompt?: unknown } | null)?.prompt
  return typeof prompt === 'string' && prompt.trim()
    ? agentTitleLine(prompt, TITLE_MAX_CHARS)
    : '改图'
}

/** 第一张参考图就是被改的那张，产出贴着它放——与执行时的 `anchorObjectId` 取同一项。 */
function anchor(args: unknown): string | undefined {
  const first = (args as { imageIds?: unknown } | null)?.imageIds
  const id = Array.isArray(first) ? first[0] : undefined
  return typeof id === 'string' && id ? id : undefined
}

export const editImage: AgentToolDefinition = {
  name: 'editImage',
  guidance:
    '用户指着某张图说要改时调改图工具，参考图用他引用的那张，产出落在源图旁边，源图不动。版本数按需求用 n 指定，未要求多张时只出一张；不同修改方案分别调用。有遮罩时以圈选位置指认对象，不能把示意图里的部件误认成主体上的同名部件。参考图圈选表示参考来源，不是修改对象。',
  title,
  outputCount: agentImageCount,
  anchor,
  // 模型可以换一个图片 id 重试，所以拿不到图不该把整轮拖垮。
  onError: 'continue',
  create(context) {
    const tool: AgentTool<typeof parameters, AgentToolDetails> = {
      name: 'editImage',
      label: '改图',
      description:
        '在已有的图上改一处，产出落到画布上源图旁边，源图不动。目标图遮罩会随请求提交，要求只改圈选部分；接口成功不代表效果已验收。',
      parameters,
      async execute(_toolCallId, params, signal, onUpdate) {
        const images = await requireAgentImages(context.images, params.imageIds)
        return runQueueTask(
          context,
          {
            media: 'image',
            prompt: params.prompt,
            n: params.n,
            inputImages: images.map((image) => image.dataUrl),
            ...(images[0]?.maskDataUrl ? { mask: images[0].maskDataUrl } : {}),
            anchorObjectId: images[0]!.imageId,
          },
          signal,
          onUpdate,
        )
      },
    }
    return tool as AgentTool
  },
}
