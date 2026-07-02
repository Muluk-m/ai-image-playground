/**
 * 画布页面坐标下的轻量包围盒。替代原 tldraw 的 `Box`：
 * 业务层（选区分析 / 放置算法）只用到这几个访问器与碰撞 / 合并，自建后与画布库解耦。
 */
export class Box {
  constructor(
    public x: number,
    public y: number,
    public w: number,
    public h: number,
  ) {}

  get maxX(): number {
    return this.x + this.w
  }

  get maxY(): number {
    return this.y + this.h
  }

  get midX(): number {
    return this.x + this.w / 2
  }

  get midY(): number {
    return this.y + this.h / 2
  }

  /** 与另一 box 是否相交（含边缘接触视为不相交，与 tldraw Box.collides 语义一致）。 */
  collides(other: Box): boolean {
    return !(
      other.x >= this.maxX ||
      other.maxX <= this.x ||
      other.y >= this.maxY ||
      other.maxY <= this.y
    )
  }

  /** 一组 box 的联合包围盒。调用方保证非空。 */
  static Common(boxes: Box[]): Box {
    let minX = Number.POSITIVE_INFINITY
    let minY = Number.POSITIVE_INFINITY
    let maxX = Number.NEGATIVE_INFINITY
    let maxY = Number.NEGATIVE_INFINITY
    for (const b of boxes) {
      minX = Math.min(minX, b.x)
      minY = Math.min(minY, b.y)
      maxX = Math.max(maxX, b.maxX)
      maxY = Math.max(maxY, b.maxY)
    }
    return new Box(minX, minY, maxX - minX, maxY - minY)
  }
}
