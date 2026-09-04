import { describe, expect, it } from 'vitest'
import { cameraToAngle, matchProductAsset } from '../../../../features/remix/lib/angleMatch'
import type { RemixProductAsset } from '../../../../features/remix/types'

describe('reading the camera field as a product angle', () => {
  it('reads a straight-on camera as the front angle', () => {
    expect(cameraToAngle('Eye level, straight on, 50mm')).toBe('front')
    expect(cameraToAngle('正面平视，无透视变形')).toBe('front')
  })

  it('reads a 45 degree camera as the three-quarter angle', () => {
    expect(cameraToAngle('Three-quarter view from the left at hip height')).toBe('three-quarter')
    expect(cameraToAngle('45度斜侧机位')).toBe('three-quarter')
  })

  it('separates a tilted-down camera from one directly overhead', () => {
    expect(cameraToAngle('High angle looking down from shoulder height')).toBe('high-angle')
    expect(cameraToAngle('Top-down flat lay directly above the tub')).toBe('top-down')
    expect(cameraToAngle('俯拍，略带角度')).toBe('high-angle')
    expect(cameraToAngle('正顶俯视')).toBe('top-down')
  })

  it('reads a profile camera as the side angle', () => {
    expect(cameraToAngle('Side profile, camera parallel to the rim')).toBe('side')
    expect(cameraToAngle('侧面机位')).toBe('side')
  })

  it('falls back to three-quarter when the camera says nothing usable', () => {
    expect(cameraToAngle('')).toBe('three-quarter')
    expect(cameraToAngle('shot on a tripod')).toBe('three-quarter')
  })
})

describe('picking the product base image for one shot', () => {
  const assets: RemixProductAsset[] = [
    { assetId: 'a-front', angle: 'front' },
    { assetId: 'a-side', angle: 'side' },
  ]

  it('takes the asset labelled with the same angle', () => {
    expect(matchProductAsset('side', assets)).toEqual({ assetId: 'a-side', angle: 'side' })
  })

  it('reports no match rather than a wrong angle', () => {
    expect(matchProductAsset('top-down', assets)).toBeNull()
    expect(matchProductAsset('front', [])).toBeNull()
  })
})
