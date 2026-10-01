import { QUEUE_MAX_INPUT_IMAGES } from './queue-protocol'

/**
 * 模板（look）＋素材 → 一次出图请求。三处出图共用这一份算式：生成模式在提交前组装、
 * 批量端点逐条素材组装、智能体照着同样的正文干活。所以它是纯函数，不读存储也不读网络。
 */

/** 模型一次收得下的输入图张数。素材先占位，余下的位置留给参考图。 */
export const LOOK_ASSEMBLY_MAX_INPUTS = QUEUE_MAX_INPUT_IMAGES

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
  readonly firstImageId?: string
  readonly maxInputs?: number
}

export type LookAssemblyResult =
  | { readonly ok: true; readonly prompt: string; readonly inputImageIds: string[] }
  | {
      readonly ok: false
      readonly reason: 'input_limit_exceeded'
      readonly assetId?: never
      readonly required: number
      readonly limit: number
    }
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
  assets: ReadonlyArray<{ name: string; ordinal: number }>,
  referenceOrdinals: readonly number[],
): string[] {
  const lines = assets.map(({ name, ordinal }) => `输入 ${ordinal} = 素材「${name}」`)
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
 * `slot_mismatch`，由调用方去问用户。完整输入超过上限时拒绝，不能静默舍弃素材或模板参考。
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

  const carried = slots
  const inputImageIds = carried.map((slot) => slot.imageId)
  const seen = new Set(inputImageIds)
  for (const imageId of look.referenceImageIds) {
    // 已经作为素材送进去的那张不再占一个位置：同一张图送两遍只是浪费输入。
    if (seen.has(imageId)) continue
    seen.add(imageId)
    inputImageIds.push(imageId)
  }

  if (inputImageIds.length > maxInputs) {
    return {
      ok: false,
      reason: 'input_limit_exceeded',
      required: inputImageIds.length,
      limit: maxInputs,
    }
  }

  const first = input.firstImageId ? inputImageIds.indexOf(input.firstImageId) : -1
  if (first > 0) inputImageIds.unshift(...inputImageIds.splice(first, 1))
  const finalReferences = inputImageIds.flatMap((id, index) =>
    carried.some((slot) => slot.imageId === id) ? [] : [index + 1],
  )
  return {
    ok: true,
    prompt: withInputList(
      look.body,
      inputListLines(
        carried.map((slot) => ({
          name: slot.name,
          ordinal: inputImageIds.indexOf(slot.imageId) + 1,
        })),
        finalReferences,
      ),
    ),
    inputImageIds,
  }
}
