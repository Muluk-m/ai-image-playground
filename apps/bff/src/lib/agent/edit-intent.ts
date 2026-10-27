/**
 * 字面判断这一句是不是整张图的要求，不调模型。只用来拦「整图要求先发范围确认」这一种误用；
 * 局部修改要不要发范围确认由模型按指引判断（见 mask-proposal.ts 的 MASK_PROPOSAL_GUIDANCE），
 * 服务端不再强推。
 */
const KEEP_REST =
  /(其他|其余|其它|别的|背景|周围|环境|人物?|主体|其他地方|别处)[^，。,.!?！？]{0,6}(不变|不动|别动|不要动|保持原样|保持不变|保留)|只(改|换|动|把)|keep (the )?(rest|background|everything else)|only (change|replace|edit)/i

/**
 * 这一句是不是明摆着要整张图的变化（季节昼夜、明暗、画风……），且没提背景或「其余不动」。
 * 为真时 `proposeEditRegion` 第一次被调会退回、提醒直接整图 `editImage`；模型坚持就放行。
 */
export function wholeImageEditIntent(text: string): boolean {
  const said = text.trim()
  return GLOBAL_CHANGE.test(said) && !KEEP_REST.test(said) && !/背景|background/i.test(said)
}
/** 只收几乎只能指整张图的说法，「这张图里的…」「换个角度」这类不算。 */
const GLOBAL_CHANGE =
  /整张|整幅|整个画面|全图|整体|画风|色调|滤镜|调色|季节|春天|春季|夏天|夏季|秋天|秋季|冬天|冬季|雪景|下雪|雨天|夜景|夜晚|晚上|夜里|白天|日落|黄昏|傍晚|清晨|黎明|明暗|调亮|调暗|变亮|变暗|对比度|饱和度|曝光|色温|高清|超分|老照片|whole image|entire image|night scene|at night|daytime|sunset|winter|summer|autumn|brightness|contrast|saturation|exposure|upscale/i

/** 整图要求下模型第一次想发范围确认时给它的提醒；同一轮再调一次就照常发卡。 */
export const WHOLE_IMAGE_EDIT_NUDGE =
  '这句话要的是整张图的变化（季节、昼夜、明暗、画风之类），不用请用户圈范围：直接调 editImage 按整图编辑。只有用户其实只想改其中某一部分、又分不清他指的是哪一个时，才照原参数再调一次 proposeEditRegion。'
