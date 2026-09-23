/**
 * 模板（look）＋素材 → 一次出图请求。三处出图共用这一份算式：生成模式在提交前组装、
 * 批量端点逐条素材组装、智能体照着同样的正文干活。所以它是纯函数，不读存储也不读网络。
 */

/** 模型一次收得下的输入图张数。素材先占位，余下的位置留给参考图。 */
export const LOOK_ASSEMBLY_MAX_INPUTS = 4

/**
 * 一张视角图。`label` 故意只要 `string`：界面上的视角联合类型与同步协议里的宽字段
 * 都要能原样传进来，这里只认得 `sheet` 与 `front` 两个值，其余一律当普通视角。
 */
export interface LookAssemblyView {
  readonly imageId: string
  readonly label: string
}

export interface LookAssemblyAsset {
  readonly id: string
  readonly name: string
  /** 有序，`[0]` 是封面。一张都没有的素材出不了图。 */
  readonly views: readonly LookAssemblyView[]
}

export interface LookAssemblyLook {
  /** frontmatter 之后的正文，按 `## N.` 分节。 */
  readonly body: string
  readonly slotCount: number
  readonly referenceImageIds: readonly string[]
}

export interface LookAssemblyInput {
  readonly look: LookAssemblyLook
  /** 按素材位顺序给：第 i 条填第 i 个素材位。 */
  readonly assets: readonly LookAssemblyAsset[]
  readonly maxInputs?: number
}

export type LookAssemblyResult =
  | { readonly ok: true; readonly prompt: string; readonly inputImageIds: string[] }
  | {
      readonly ok: false
      readonly reason: 'slot_mismatch' | 'no_views'
      /** `no_views` 时是那条没有视角的素材。 */
      readonly assetId?: string
    }

/** 一条素材只送一张图：拼图一张顶三张，其次正面，再不行就封面。 */
function pickViewImageId(asset: LookAssemblyAsset): string | undefined {
  const sheet = asset.views.find((view) => view.label === 'sheet')
  const front = asset.views.find((view) => view.label === 'front')
  return (sheet ?? front ?? asset.views[0])?.imageId
}

/** 正文第三节「需要用户提供的输入」写的是素材位；出图时它换成这一次真的送了什么。 */
const SLOT_SECTION_HEADING = /^##\s*3\s*[.．、]/
/** 分节的边界：同级或更高级的标题。第三节里的小标题不算。 */
const SECTION_HEADING = /^#{1,2}\s/

function inputListLines(
  assetNames: readonly string[],
  referenceOrdinals: readonly number[],
): string[] {
  const lines = assetNames.map((name, index) => `输入 ${index + 1} = 素材「${name}」`)
  if (referenceOrdinals.length > 0) {
    lines.push(`参考图：${referenceOrdinals.map((ordinal) => `输入 ${ordinal}`).join('、')}`)
  }
  return lines
}

/**
 * 把输入清单放进正文。找得到第三节就整节换掉，找不到（预置模板的正文不一定分节）
 * 就接在末尾——清单本身自带「输入 N =」的说明，不依赖那个标题。
 */
function withInputList(body: string, list: readonly string[]): string {
  const lines = body.split('\n')
  const heading = lines.findIndex((line) => SLOT_SECTION_HEADING.test(line))
  if (heading < 0) {
    if (list.length === 0) return body
    return `${body.replace(/\s+$/, '')}\n\n${list.join('\n')}`
  }
  let end = heading + 1
  while (end < lines.length && !SECTION_HEADING.test(lines[end] ?? '')) end += 1
  const tail = end < lines.length ? ['', ...lines.slice(end)] : []
  return [...lines.slice(0, heading + 1), ...list, ...tail].join('\n')
}

/**
 * 素材条数必须与素材位数相等——少了模型没东西放，多了没有位置放，两种都是
 * `slot_mismatch`，由调用方去问用户。素材超过输入上限时只带得下前几条：
 * 提示词里的清单与 `inputImageIds` 始终描述同一批图，不会出现说了却没送的输入。
 */
export function assembleLookRequest(input: LookAssemblyInput): LookAssemblyResult {
  const { look, assets } = input
  const maxInputs = input.maxInputs ?? LOOK_ASSEMBLY_MAX_INPUTS
  if (assets.length !== look.slotCount) return { ok: false, reason: 'slot_mismatch' }

  const slots: Array<{ readonly name: string; readonly imageId: string }> = []
  for (const asset of assets) {
    const imageId = pickViewImageId(asset)
    if (imageId === undefined) return { ok: false, reason: 'no_views', assetId: asset.id }
    slots.push({ name: asset.name, imageId })
  }

  const carried = slots.slice(0, Math.max(maxInputs, 0))
  const inputImageIds = carried.map((slot) => slot.imageId)
  const seen = new Set(inputImageIds)
  const referenceOrdinals: number[] = []
  for (const imageId of look.referenceImageIds) {
    if (inputImageIds.length >= maxInputs) break
    // 已经作为素材送进去的那张不再占一个位置：同一张图送两遍只是浪费输入。
    if (seen.has(imageId)) continue
    seen.add(imageId)
    referenceOrdinals.push(inputImageIds.length + 1)
    inputImageIds.push(imageId)
  }

  return {
    ok: true,
    prompt: withInputList(
      look.body,
      inputListLines(
        carried.map((slot) => slot.name),
        referenceOrdinals,
      ),
    ),
    inputImageIds,
  }
}
