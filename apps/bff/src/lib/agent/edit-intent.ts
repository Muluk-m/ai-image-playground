/**
 * 这一句是不是在要求改图里的单个对象或局部（含「换掉 X、背景不变」与只换背景）。
 * 不调模型，只认字面：整体风格、色调、构图、尺寸这类全图要求不算；拿不准时返回 false，
 * 交给模型按指引判断。`editImage` 据此拒绝没有蒙版的整图编辑，让它先发范围确认。
 */
const WHOLE_IMAGE =
  /整张|整幅|整个画面|全图|整体|这张图|这幅图|画风|风格|色调|滤镜|黑白|调色|光线|光影|氛围|构图|角度|视角|姿势|镜头|裁剪|扩图|尺寸|比例|分辨率|高清|放大|超分|老照片|上色|whole image|entire image|overall|style|colou?r grad|filter|resolution|upscale|crop|aspect/i
const KEEP_REST =
  /(其他|其余|其它|别的|背景|周围|环境|人物?|主体|其他地方|别处)[^，。,.!?！？]{0,6}(不变|不动|别动|不要动|保持原样|保持不变|保留)|只(改|换|动|把)|keep (the )?(rest|background|everything else)|only (change|replace|edit)/i
const OBJECT_CHANGE =
  /换成|改成|换掉|换一下|换个|换一个|变成|改为|替换|去掉|去除|删掉|删除|移除|抹掉|擦掉|\breplace\b|\bremove\b|\bswap\b|\berase\b/i

export function singleObjectEditIntent(text: string): boolean {
  const said = text.trim()
  if (!said || WHOLE_IMAGE.test(said)) return false
  return KEEP_REST.test(said) || OBJECT_CHANGE.test(said)
}

/** 模型想整图改、拦下来时回它的那句话。 */
export const SINGLE_OBJECT_EDIT_REFUSAL =
  '用户要改的是图里的某个对象或局部，不能整图编辑：先调用 proposeEditRegion 请他确认修改范围（换背景时框住要保留的主体并设 invert），确认后再按蒙版改。不要先追问要换成什么样。'
