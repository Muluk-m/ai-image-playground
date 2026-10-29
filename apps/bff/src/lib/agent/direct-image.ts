import type { AgentTurnInput } from './turn-input'
import { requestAgentReferences } from './turn-input'

/**
 * 「图片生成」模式（对话视图）的这一轮：系统提示词本来就只让模型「用用户原话调用一次生图工具」
 *（`DIRECT_IMAGE_LINE`），那次模型调用只是把原话抄进 generateImage，却要多花一次对话模型的钱
 * 和几秒「思考中」，对话上游一挂图片模式也跟着挂。所以这一步不问模型，直接拼出那次调用。
 *
 * 只认最干净的情形：没有附图（含澄清链里沿用的引用）、不是技能调用、不是唤醒或续跑。
 * 附了图时要不要改图、哪张是目标要模型判断，照旧交给它。返回 null 就是不走这条路。
 * 张数不填：工具按本轮参数里的 n 取（`requestedImageCount`）。
 */
export function directImageCall(
  input: Pick<
    AgentTurnInput,
    'directImage' | 'mode' | 'audience' | 'text' | 'references' | 'history' | 'continuation'
  >,
  wake: boolean,
): Record<string, unknown> | null {
  if (input.directImage !== true || wake || input.continuation) return null
  if (input.mode !== 'image' || input.audience.experience !== 'chat') return null
  const prompt = input.text.trim()
  if (!prompt || prompt.startsWith('/')) return null
  if (requestAgentReferences(input).length > 0) return null
  return { prompt }
}
