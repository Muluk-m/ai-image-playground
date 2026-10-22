/**
 * 这一句是不是在要求改图里的单个对象或局部（含「换掉 X、背景不变」与只换背景）。
 * 不调模型，只认字面：整体风格、色调、季节昼夜、明暗、画种、构图、尺寸这类全图要求不算；
 * 拿不准时返回 false，交给模型按指引判断。为真时 `editImage` 第一次无蒙版的整图编辑会被
 * 退回、提醒它先考虑范围确认；模型坚持（同一轮再调一次）就放行，不会卡死。
 */
const WHOLE_IMAGE =
  /整张|整幅|整个画面|全图|整体|这张图|这幅图|画风|风格|色调|滤镜|黑白|调色|光线|光影|氛围|构图|角度|视角|姿势|镜头|裁剪|扩图|尺寸|比例|分辨率|高清|放大|超分|老照片|上色|季节|春天|春季|夏天|夏季|秋天|秋季|冬天|冬季|雪景|下雪|雨天|夜景|夜晚|晚上|夜里|白天|日落|黄昏|傍晚|清晨|黎明|亮度|明暗|调亮|调暗|变亮|变暗|对比度|饱和度|曝光|色温|暖色|冷色|卡通|动漫|动画|二次元|漫画|写实|真人|手绘|油画|水彩|素描|国画|像素风|赛博朋克|whole image|entire image|overall|style|colou?r grad|filter|resolution|upscale|crop|aspect|night|daytime|sunset|winter|summer|autumn|spring|brightness|contrast|saturation|exposure|cartoon|anime|realistic|painting/i
const KEEP_REST =
  /(其他|其余|其它|别的|背景|周围|环境|人物?|主体|其他地方|别处)[^，。,.!?！？]{0,6}(不变|不动|别动|不要动|保持原样|保持不变|保留)|只(改|换|动|把)|keep (the )?(rest|background|everything else)|only (change|replace|edit)/i
const OBJECT_CHANGE =
  /换成|改成|换掉|换一下|换个|换一个|变成|改为|替换|去掉|去除|删掉|删除|移除|抹掉|擦掉|\breplace\b|\bremove\b|\bswap\b|\berase\b/i

export function singleObjectEditIntent(text: string): boolean {
  const said = text.trim()
  if (!said || WHOLE_IMAGE.test(said)) return false
  return KEEP_REST.test(said) || OBJECT_CHANGE.test(said)
}

/** 模型第一次想整图改、退回时给它的提醒；同一轮再调一次 editImage 就按整图编辑放行。 */
export const SINGLE_OBJECT_EDIT_NUDGE =
  '这句话看起来是要改图里的某个对象或局部：先调用 proposeEditRegion 请用户确认修改范围（换背景时框住要保留的主体并设 invert），确认后再按蒙版改，不要先追问要换成什么样。如果用户要的其实是整张图的变化（季节、昼夜、明暗、画风，或把人物整体变成卡通之类），照原参数再调一次 editImage，这次会按整图编辑提交。'
