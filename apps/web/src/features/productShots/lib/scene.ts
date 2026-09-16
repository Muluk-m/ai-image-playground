import type { BgSceneType } from '@image-playground/shared'
import { i18next } from '../../../i18n'

export function diagramLabel(): string {
  return i18next.t('scene.diagram', { ns: 'productShots' })
}

/** 示意图、带标注的特写与卖点拼图换背景会丢掉说明；没预检过的图按普通图走。 */
export function isDiagram(sceneType: BgSceneType | undefined): boolean {
  return sceneType !== undefined && sceneType !== 'photo'
}
