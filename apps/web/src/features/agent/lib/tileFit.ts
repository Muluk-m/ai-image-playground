/**
 * 结果缩略图在固定比例的格子里怎么放：图比格子宽就按宽铺满（上下留边），否则按高铺满（左右留边）。
 * 图元素只占画面本身那一块，透明棋盘格只垫在图的像素后面；留边处是格子自己的深色底，
 * 不再像一张破图或透明图。比例还不知道（图没加载完）时返回 null，先不垫棋盘格。
 */
export function tileFit(
  imageRatio: number | undefined,
  tileRatio: number | undefined,
): 'width' | 'height' | null {
  if (!imageRatio || !Number.isFinite(imageRatio) || imageRatio <= 0) return null
  const tile = tileRatio && Number.isFinite(tileRatio) && tileRatio > 0 ? tileRatio : imageRatio
  return imageRatio >= tile ? 'width' : 'height'
}
