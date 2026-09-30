import { visibleRegionBounds } from './regionBounds'

self.onmessage = (event: MessageEvent<import('./regionBounds').RegionBoundsRequest>) => {
  const { version, pixels, width, height, shapes } = event.data
  self.postMessage({ version, regions: visibleRegionBounds(pixels, width, height, shapes) })
}
