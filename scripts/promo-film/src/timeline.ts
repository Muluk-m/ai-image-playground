// 全片按配乐拍子排。Warm Acoustic Guitar（Pixabay 232912）实测 82.5 BPM，第一拍在 0.670s。
export const FPS = 30
export const BEAT = 60 / 82.5
/** 第 n 拍对应的成片帧号 */
export const b = (n: number) => Math.round(n * BEAT * FPS)

/** 配乐从曲子的第 40 拍开始，让曲尾的收束和弦落在片尾 logo 后面 */
export const MUSIC_FROM = 0.67 + 40 * BEAT

// 场景起止（拍）
export const S = {
  original: [0, 6],
  batchType: [6, 17],
  batchDone: [17, 21],
  glazes: [21, 29],
  row: [29, 32],
  edit: [32, 45],
  wipe: [45, 51],
  detailType: [51, 59],
  closeup: [59, 64],
  grid: [64, 70],
  end: [70, 80],
} as const satisfies Record<string, readonly [number, number]>

export const TOTAL = b(80)

/**
 * 录屏母带里的时间点（秒）。母带是 2880×1620、30fps 的真实操作录屏。
 * 重录后按 raw/*.marks.json 与出图检测结果更新。
 */
export const SRC = {
  batch: { from: 2.8, sent: 15.4, arrivals: [95.0, 129.5, 165.0, 209.5], done: 212.5 },
  edit: { from: 6.6, editor: 8.27, masked: 13.5, typed: 17.8, sent: 19.85 },
  detail: { from: 3.4, sent: 13.1 },
}

/** 裁切框：源坐标（2880×1620）下的左上角与宽度，高度按 16:9 推出 */
export type Rect = { x: number; y: number; w: number }
export const CROP = {
  composer: { x: 823, y: 95, w: 1760 },
  // 四张出齐后的对话：上沿避开顶栏，下沿避开带积分数字的用时行
  chatDone: { x: 904, y: 92, w: 1600 },
  full: { x: 0, y: 0, w: 2880 },
  editorImage: { x: 490, y: 190, w: 1900 },
} satisfies Record<string, Rect>
