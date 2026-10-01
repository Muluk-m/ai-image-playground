import sharp from 'sharp'

/** Keep image fixture dependencies in the BFF package that owns the media pipeline. */
export function fixturePng(background: string) {
  return sharp({ create: { width: 8, height: 6, channels: 4, background } })
    .png()
    .toBuffer()
}
