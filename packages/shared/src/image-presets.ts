/** Shared by the canvas generator and the corresponding Agent skills. */
export const IMAGE_PRESETS = [
  {
    skillName: 'character-sheet',
    icon: 'person-standing',
    instruction:
      '生成一张人物三视图设定图：同一人物的正面、90°侧面、180°背面全身视图，从左到右并排在同一张图中。三个视角保持同一身份、发型、服装、配饰、身高与身体比例，头顶与脚底对齐，完整露出全身且互不遮挡。参考图中有多个人物时，只处理用户明确指定的一个人物；未指定时先明确人物，不把多人混成同一角色。使用干净浅色背景与均匀布光，不添加文字、序号、水印、无关道具。只交付一张完整三视图，不先单独出正面图，不生成视频。',
  },
  {
    skillName: 'multi-camera-grid',
    icon: 'grid-3x3',
    instruction:
      '生成一张3×3多机位九宫格图片。九格是同一场景、同一人物、同一时刻的九个摄影机视角，不是剧情推进，也不是九张相同构图的裁切或缩放。保持人物身份、服装、姿态、道具、光线方向与场景布局一致；门窗、桌椅等空间锚点固定，只改变摄影机的位置、朝向与景别。按从左到右、从上到下安排：平视全景、左前方中景、右前方中景、低机位仰拍、高机位俯拍、侧面远景、背面过肩、主体近景、环境大远景。九格等大、边界清楚，不添加文字、序号或水印。只生成一张九宫格拼图，不拆成九次生成，不生成视频。',
  },
  {
    skillName: 'continuous-storyboard',
    icon: 'film',
    instruction:
      '根据用户剧情生成一张情节连续的分镜拼图，默认2行3列共六格，按从左到右、从上到下阅读。先把剧情拆成六个具体可见的动作或事件，每格只画一个关键时刻：交代地点与人物、发现目标、作出反应、开始行动、关键动作、结果或留白；这些是叙事职能，必须改写成用户故事里的实际内容，不能把这六句话当成画面文字。保持同一人物身份、发型、服装、道具和场景空间关系，动作与道具位置随剧情合理连续变化，维持运动方向和视线关系。相邻格有明确进展，不用同一画面换机位凑数。用户指定格数与布局时遵循用户要求。各格边界清楚，不添加文字、字幕、序号或水印。只交付一张分镜拼图，不自动切图，不生成视频。',
  },
] as const

export type ImagePreset = (typeof IMAGE_PRESETS)[number]
export type ImagePresetName = ImagePreset['skillName']

export function imagePreset(name: string | undefined): ImagePreset | undefined {
  return IMAGE_PRESETS.find((preset) => preset.skillName === name)
}

export function imagePresetPrompt(preset: ImagePreset, requirement: string): string {
  return [preset.instruction, requirement.trim() ? '用户补充要求：\n' + requirement.trim() : '']
    .filter(Boolean)
    .join('\n\n')
}
