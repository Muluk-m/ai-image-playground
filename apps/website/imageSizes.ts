import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { guideEntries, pageBlocks } from '../web/src/features/guide/model'
import { editions } from './src/catalog'

export function guideImageSizes(publicDir: string) {
  const paths = new Set(
    Object.values(editions).flatMap((edition) =>
      guideEntries(edition).flatMap(({ page }) =>
        pageBlocks(page).flatMap((block) =>
          block.type === 'shot' ? [block.src] : block.type === 'video' ? [block.poster] : [],
        ),
      ),
    ),
  )
  return Object.fromEntries(
    [...paths].map((path) => {
      const data = readFileSync(resolve(publicDir, `.${path}`))
      if (data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WEBP')
        throw new Error(`Guide image must be WebP: ${path}`)
      const chunk = data.toString('ascii', 12, 16)
      if (chunk === 'VP8X')
        return [path, { width: 1 + data.readUIntLE(24, 3), height: 1 + data.readUIntLE(27, 3) }]
      if (chunk === 'VP8 ')
        return [
          path,
          { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff },
        ]
      if (chunk === 'VP8L') {
        const bits = data.readUInt32LE(21)
        return [path, { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }]
      }
      throw new Error(`Unknown guide image encoding: ${path}`)
    }),
  )
}
