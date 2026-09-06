import type { BgSceneType } from '@image-playground/shared'

export const DIAGRAM_LABEL = '含说明文字，换背景会丢失'

/** 示意图、带标注的特写与卖点拼图换背景会丢掉说明；没预检过的图按普通图走。 */
export function isDiagram(sceneType: BgSceneType | undefined): boolean {
  return sceneType !== undefined && sceneType !== 'photo'
}
