import { Composition } from 'remotion'
import { FPS, TOTAL } from './timeline'
import { Promo } from './Promo'

export const Root = () => (
  <Composition id="Promo" component={Promo} durationInFrames={TOTAL} fps={FPS} width={1920} height={1080} />
)
