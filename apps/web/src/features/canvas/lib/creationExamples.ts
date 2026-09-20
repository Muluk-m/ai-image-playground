/**
 * 空项目落地页的起手案例。点一下把整句话填进输入框，不直接发送。
 *
 * 视频那几条是从竞品与厂商官方 prompt 指南里挑的电商向单镜头案例（来源见每条 `source`），
 * 原文照抄不翻译：模型对这些写法的响应是被官方示例验证过的，改写会失真。图片档沿用原先
 * 那三条中文起手示例已由灵感库取代（见 components/CreationInspiration.tsx）。
 *
 * 只放能在当前档位跑通的：单镜头、不依赖多镜头脚本或厂商独有的特效模板。
 */
export interface CreationExample {
  readonly id: string
  /** 卡面标题，自己拟的短句。 */
  readonly title: string
  /** 填进输入框的原文。 */
  readonly prompt: string
  /** 运镜或玩法标签，卡面右上角一枚。 */
  readonly tag: string
  /** 卡面封面，也是视频的 poster。自家用 gpt-image-2.5 按同一条 prompt 生成，不用竞品的图。 */
  readonly cover: string
  /** prompt 出处，便于日后核对与替换。 */
  readonly source: string
}

/**
 * 案例样片放在公开 R2 桶（`aip-public-assets`）的 `cases/` 前缀下，不进 Pages 产物：
 * 四条 720p 5 秒片合计约 7MB，随每次发布重传是白花带宽，而它们的更新节奏和代码无关。
 * 用户媒体那个 `ai-images` 桶不能设公开，所以这是另一个只放公开素材的桶。
 */
const CLIP_ORIGIN = 'https://pub-ad1b49b25af44f0cbceecfd883a725e0.r2.dev/cases'

/** 样片与封面同名，按案例 id 取。 */
export function exampleClipUrl(id: string): string {
  return `${CLIP_ORIGIN}/${id}.mp4`
}

const VIDEO_EXAMPLES: readonly CreationExample[] = [
  {
    id: 'serum-macro',
    title: '精华液滴管微距',
    tag: '微距推镜',
    cover: '/cases/serum-macro.webp',
    prompt:
      "Subject. A frosted glass dropper bottle of amber facial serum, label facing camera, resting on a wet black stone slab. Motion. A single drop falls from the dropper tip and lands on the stone, spreading into a thin amber puddle; the bottle rocks once from the impact then settles still. Camera. 100mm macro lens, slow dolly-in from eye level, shallow depth of field keeping the label sharp while the background blurs. Lighting. Hard top-down key light throws a bright rim along the bottle's shoulder; a cool blue backlight separates the glass from the black surface.",
    source: 'https://github.com/Reviral-ai/seedance-2.5-prompts',
  },
  {
    id: 'sneaker-turntable',
    title: '运动鞋转台光扫',
    tag: '环绕弧线',
    cover: '/cases/sneaker-turntable.webp',
    prompt:
      "Subject. A matte black running shoe on a rotating concrete pedestal, laces slightly loose, one lace hanging over the edge. Motion. The pedestal turns a quarter-rotation as a shaft of light sweeps across the shoe's side panel, catching the stitched seams; the hanging lace sways once from the air movement. Camera. 50mm lens, slow arc move circling the shoe at knee height, camera fixed on the shoe. Lighting. Single hard spotlight from camera-left crosses the shoe as it turns, deep shadow pooling on the concrete behind it.",
    source: 'https://github.com/Reviral-ai/seedance-2.5-prompts',
  },
  {
    id: 'ribbon-apparel-unboxing',
    title: '缎带服饰开箱',
    tag: '三分之四推镜',
    cover: '/cases/unboxing-apparel.webp',
    prompt:
      'Subject. Hands untying a ribbon on a matte black apparel box on a marble countertop, tissue paper folded neatly inside. Motion. The ribbon falls away, fingers part the tissue paper, revealing a folded knit sweater in deep green; a hand lifts one sleeve to show the texture. Camera. 50mm lens, slow dolly-in from a three-quarter angle, shallow depth of field. Lighting. Cool north-facing window light, soft shadow under the box edge on the marble.',
    source: 'https://github.com/Reviral-ai/seedance-2.5-prompts',
  },
  {
    id: 'perfume-pedestal-up',
    title: '香水瓶升镜特写',
    tag: '升镜',
    cover: '/cases/perfume-pedestal-up.webp',
    prompt:
      "A woman's slender fingers with delicate, polished nails gently grasp the faceted cap of a clear glass perfume bottle, illuminated by soft, prismatic light. The hand lifts the bottle, revealing the faint tattoo on her wrist while the camera executes a gentle pedestal up, following the bottle's ascent. The color palette combines natural skin tones with the opalescent hues of the perfume bottle and the soft cool blue and warm pink background. Commercial beauty photography, ethereal, soft focus, product shot, iridescent, soft pastels",
    source:
      'https://help.runwayml.com/hc/en-us/articles/46749315925395-Camera-Terms-Prompts-Examples',
  },
]

export function videoExamples(): readonly CreationExample[] {
  return VIDEO_EXAMPLES
}
