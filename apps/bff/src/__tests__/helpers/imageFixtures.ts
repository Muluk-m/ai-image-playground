import sharp from 'sharp'

async function image(background: string) {
  const png = await sharp({ create: { width: 8, height: 8, channels: 4, background } })
    .png()
    .toBuffer()
  const webp = await sharp(png).resize(4, 4).webp().toBuffer()
  return {
    png,
    webp,
    pngDataUrl: `data:image/png;base64,${png.toString('base64')}`,
    webpDataUrl: `data:image/webp;base64,${webp.toString('base64')}`,
  }
}

/** Real decodable bytes keep image transport fixtures subject to production validation. */
export const TEST_IMAGE = await image('#ffffff')
export const OTHER_IMAGE = await image('#0000ff')
