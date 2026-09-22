// PROTOTYPE 假数据：内存态，不落库。
export type ViewLabel = '正面' | '侧面' | '背面' | '细节' | '拼图' | '无'
export interface ProtoView {
  src: string
  label: ViewLabel
  source: '上传' | '生成'
}
export interface ProtoAsset {
  id: string
  name: string
  kind?: '产品' | '人物'
  background?: '透明' | '纯色'
  views: ProtoView[]
}
export type Purpose = '主图' | '海报' | '场景图' | '详情图'
export interface ProtoLook {
  id: string
  name: string
  purpose: Purpose
  origin: '自建' | '预置'
  cover: string
  refs: string[]
  /** 模板正文就是一份技能：frontmatter 之后的 markdown，按 `## N. 标题` 分节。 */
  prompt: string
  description: string
  model: string
  size: string
  slots: number
  needsRetune?: boolean
  badge?: 'New' | 'Hot'
}

function ph(label: string, bg = '#f3f3f1', fg = '#8a8a86', transparent = false): string {
  const grid = transparent
    ? `<defs><pattern id="c" width="16" height="16" patternUnits="userSpaceOnUse"><rect width="8" height="8" fill="#e6e6e3"/><rect x="8" y="8" width="8" height="8" fill="#e6e6e3"/></pattern></defs><rect width="100%" height="100%" fill="url(#c)"/>`
    : `<rect width="100%" height="100%" fill="${bg}"/>`
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400">${grid}<ellipse cx="200" cy="230" rx="130" ry="70" fill="#d9d9d4" stroke="#bdbdb8" stroke-width="4"/><text x="200" y="120" font-size="28" text-anchor="middle" fill="${fg}" font-family="sans-serif">${label}</text></svg>`
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

export const ASSETS: ProtoAsset[] = [
  {
    id: 'a1',
    name: '鹅蛋形大理石纹浴缸',
    kind: '产品',
    background: '透明',
    views: [
      { src: ph('正 / 侧 / 背 拼图', '', '', true), label: '拼图', source: '生成' },
      { src: ph('正面', '', '', true), label: '正面', source: '生成' },
      { src: ph('细节 · 排水口', '', '', true), label: '细节', source: '生成' },
      { src: ph('实拍原图'), label: '无', source: '上传' },
    ],
  },
  {
    id: 'a2',
    name: '烟灰透明树脂缸',
    kind: '产品',
    background: '纯色',
    views: [{ src: ph('正面 · 白底'), label: '正面', source: '上传' }],
  },
  {
    id: 'a3',
    name: '模特 · 阿哲',
    kind: '人物',
    background: '透明',
    views: [
      { src: ph('人物拼图', '', '', true), label: '拼图', source: '生成' },
      { src: ph('头部细节', '', '', true), label: '细节', source: '生成' },
    ],
  },
  {
    id: 'a4',
    name: '旧素材 · 白底图',
    views: [{ src: ph('旧素材'), label: '无', source: '上传' }],
  },
]

export const LOOKS: ProtoLook[] = [
  {
    id: 'l1',
    name: '岩壁大理石',
    purpose: '场景图',
    origin: '预置',
    cover: '/prototype-looks/01.webp',
    refs: ['/prototype-looks/01.webp'],
    description: '把素材放进粗糙岩壁 + 深灰石板的冷峻卫浴场景，斜 45° 俯拍，高端电商场景图。',
    prompt: `## 1. 一句话目标
把用户提供的产品素材放进「粗糙岩石壁面 + 深灰哑光石板地面」的冷峻卫浴场景里，出一张高端电商场景图。

## 2. 适用场景
- 卫浴、家居硬装类商品的详情页场景图
- 品牌调性偏冷峻、材质感强的主视觉

## 3. 需要用户提供的输入
- **产品素材**（必填）：1 条，优先白底或透明底的拼图 / 正面视角。
- **画面比例**（可选）：缺省 3:4。
- **保留项**（可选）：不能变的细节，如 logo、排水口位置。

## 4. 工作流程
1. 读素材全部视角，认出主体外形、材质、颜色与不能变的细节。
2. 按参考图组织画面：主体置于画面中下部，斜 45° 俯拍，占画面约 60%，地面留白。
3. 调用出图：环境为粗糙的灰褐岩石壁面与深灰哑光石板地面；左上方硬光，岩壁投下清晰阴影；主体与地面接触处有自然投影。
4. 检查主体是否被改动（外形、颜色、材质、logo），有改动回到素材重出。

## 5. 输出要求
- 数量：默认 1 张。
- 比例：3:4。
- 风格：高端卫浴电商，冷峻、克制、低饱和；不出现任何文字、水印、额外商品。

## 6. 约束与禁忌
- 主体一个像素级细节都不重画：不改颜色、不改 logo、不改比例。
- 不加道具、不加人物、不加节日元素。
- 岩壁纹理不得抢过主体。`,
    model: 'gpt-image-2.5-sunburst',
    size: '3:4',
    slots: 1,
    badge: 'Hot',
  },
  {
    id: 'l2',
    name: '素混凝土圆窗',
    purpose: '场景图',
    origin: '预置',
    cover: '/prototype-looks/02.jpg',
    refs: ['/prototype-looks/02.jpg'],
    description: '微水泥墙面、圆形落地窗外雪松林，素净的北欧卫浴场景。',
    prompt: '## 4. 工作流程\n主体居中偏左……【环境】微水泥墙面、圆形落地窗外雪松林、壁龛陈设……',
    model: 'gpt-image-2.5-sunburst',
    size: '3:4',
    slots: 1,
    badge: 'New',
  },
  {
    id: 'l3',
    name: '海景酒店',
    purpose: '海报',
    origin: '预置',
    cover: '/prototype-looks/03.webp',
    refs: ['/prototype-looks/03.webp'],
    description: '海景酒店客房落地窗前，暖色灯带，度假感场景图。',
    prompt: '## 4. 工作流程\n主体置于落地窗前……【环境】海景酒店客房、暖色灯带……',
    model: 'gemini-3.1-flash-image',
    size: '3:4',
    slots: 1,
  },
  {
    id: 'l4',
    name: '暖调琥珀',
    purpose: '主图',
    origin: '预置',
    cover: '/prototype-looks/04.webp',
    refs: ['/prototype-looks/04.webp'],
    description: '暖灰墙面、干花与原木凳，暖调琥珀色主图。',
    prompt: '## 4. 工作流程\n主体置于石台上……【环境】暖灰墙面、干花、原木凳……',
    model: 'gpt-image-2.5-sunburst',
    size: '3:4',
    slots: 1,
  },
  {
    id: 'l5',
    name: '我的 · 北欧客厅',
    purpose: '场景图',
    origin: '自建',
    cover: ph('北欧客厅 · 金样', '#e9ede6', '#6d7a6b'),
    refs: [ph('参考海报', '#e9ede6', '#6d7a6b')],
    description: '浅色橡木地板、米白布艺沙发的北欧客厅。',
    prompt: '## 4. 工作流程\n主体放进北欧客厅【环境】浅色橡木地板、米白布艺沙发……',
    model: 'gpt-image-2.5-sunburst',
    size: '1:1',
    slots: 1,
  },
  {
    id: 'l6',
    name: '我的 · 模特上身图',
    purpose: '详情图',
    origin: '自建',
    cover: ph('模特 + 商品', '#ede6e9', '#7a6b74'),
    refs: [],
    description: '模特穿着商品的上身图，两个素材位。',
    prompt: '## 3. 需要用户提供的输入\n- 人物素材 1 条\n- 服装素材 1 条',
    model: 'grok-imagine-image-2.0',
    size: '3:4',
    slots: 2,
    needsRetune: true,
  },
]

export const PURPOSE_TONE: Record<Purpose, string> = {
  主图: 'bg-info/15 text-info',
  海报: 'bg-warning/15 text-warning',
  场景图: 'bg-success/15 text-success',
  详情图: 'bg-primary/10 text-primary',
}
