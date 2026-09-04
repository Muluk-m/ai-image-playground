/** 平台导出尺寸。上游返回尺寸会浮动，导出前按这里的宽高归一化。 */
export interface ExportPreset {
  readonly id: string
  readonly label: string
  readonly width: number
  readonly height: number
}

export const EXPORT_PRESETS: readonly ExportPreset[] = [
  { id: 'amazon', label: '亚马逊 2000×2000', width: 2000, height: 2000 },
  { id: 'alibaba', label: '阿里巴巴 800×800', width: 800, height: 800 },
  { id: 'pinduoduo', label: '拼多多 750×1000', width: 750, height: 1000 },
  { id: 'site', label: '独立站 1200×1200', width: 1200, height: 1200 },
]

export function findExportPreset(id: string): ExportPreset | null {
  return EXPORT_PRESETS.find((preset) => preset.id === id) ?? null
}

/** 换背景的一条风格。三段分开存，提示词按段拼，用户可以只改其中一段。 */
export interface BackgroundPreset {
  readonly id: string
  readonly label: string
  readonly wall: string
  readonly floor: string
  readonly props: readonly string[]
}

export const BACKGROUND_PRESETS: readonly BackgroundPreset[] = [
  {
    id: 'warm-microcement',
    label: '暖灰微水泥',
    wall: '暖灰色微水泥墙面，手工批刮的细微色差与颗粒',
    floor: '同色系微水泥地面，哑光',
    props: ['落地黑色龙头', '亚麻浴巾', '陶土色小凳'],
  },
  {
    id: 'white-mosaic',
    label: '白色小方砖',
    wall: '白色小方砖墙面，浅灰勾缝，砖面轻微高低不平',
    floor: '浅灰水磨石地面',
    props: ['黑色圆镜', '玻璃瓶插枝', '白色台盆柜'],
  },
  {
    id: 'dark-sintered-stone',
    label: '深色岩板',
    wall: '深灰岩板墙面，细密纹理，哑光',
    floor: '深灰细磨混凝土地面',
    props: ['壁龛与两支洗护瓶', '深灰长绒地垫', '黑色落地龙头'],
  },
  {
    id: 'wood-batten',
    label: '木格栅灯带',
    wall: '浅木色竖向格栅墙面，格栅后藏暖白灯带',
    floor: '灰色大理石地面，轻微反射',
    props: ['黑色落地龙头', '木托盘与折叠毛巾'],
  },
  {
    id: 'cream-marble',
    label: '奶油大理石',
    wall: '奶油白大理石墙面，浅金色纹路走向自然',
    floor: '同款大理石地面',
    props: ['香槟金龙头', '白瓷花器', '奶白色蜡烛'],
  },
  {
    id: 'oat-tile',
    label: '燕麦瓷砖',
    wall: '燕麦色哑光瓷砖墙面，砖缝同色',
    floor: '燕麦色哑光地砖',
    props: ['原木矮凳', '米色浴巾', '藤编收纳篮'],
  },
  {
    id: 'dark-walnut',
    label: '深胡桃木',
    wall: '深胡桃木饰面墙，木纹清晰，边缘收口利落',
    floor: '深灰哑光石材地面',
    props: ['黄铜龙头', '深色石托盘', '干枝插花'],
  },
  {
    id: 'raw-concrete',
    label: '清水混凝土',
    wall: '清水混凝土墙面，保留模板拼缝与对拉螺栓孔',
    floor: '同色系混凝土地面',
    props: ['黑色落地龙头', '灰色长绒地垫'],
  },
  {
    id: 'green-window',
    label: '绿植窗景',
    wall: '浅米色艺术漆墙面，右侧整面落地窗',
    floor: '浅色人字拼木地板',
    props: ['龟背竹', '原木凳与亚麻毯', '窗外绿色庭院虚化'],
  },
  {
    id: 'light-terrazzo',
    label: '浅灰水磨石',
    wall: '浅灰水磨石墙面，细小骨料分布均匀',
    floor: '同款水磨石地面',
    props: ['拉丝不锈钢龙头', '白色浴巾架', '透明玻璃隔断'],
  },
]

export function findBackgroundPreset(id: string): BackgroundPreset | null {
  return BACKGROUND_PRESETS.find((preset) => preset.id === id) ?? null
}
