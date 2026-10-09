import type { ImageContent } from '@earendil-works/pi-ai'
import type { ResolvedAgentImage } from './images'
import { type EvidenceListing, evidenceManifest, referenceEvidence } from './selection-preview'
import { assertVisualBytes, visualMetadata, withVisualPreparation } from './visual-resources'

export type VisualEvidence = import('@image-playground/shared').AgentVisualEvidence
export type VisualEvidenceSource = string | ((image: ResolvedAgentImage) => string)

const evidence = new WeakMap<ImageContent, VisualEvidence>()
export const visualEvidenceOf = (block: ImageContent) => evidence.get(block)

async function registerBlock(
  block: ImageContent,
  identity: Pick<VisualEvidence, 'imageId' | 'source' | 'representation' | 'selection'>,
): Promise<void> {
  if (evidence.has(block)) return
  assertVisualBytes(Buffer.byteLength(JSON.stringify(block), 'utf8'))
  const bytes = Buffer.from(block.data, 'base64')
  const metadata = await visualMetadata(bytes)
  evidence.set(block, {
    ...identity,
    width: metadata?.width ?? null,
    height: metadata?.height ?? null,
    bytes: bytes.byteLength,
  })
}

/** Every model image originates here; original identities survive preview and selection derivation. */
async function prepareEvidence(
  references: readonly ResolvedAgentImage[],
  source: VisualEvidenceSource,
  representation: NonNullable<ResolvedAgentImage['visualVariant']> = 'original',
) {
  const content: ImageContent[] = []
  const listed: EvidenceListing[] = []
  let bytes = 0
  for (const reference of references) {
    const prepared = await referenceEvidence([reference])
    const representations: VisualEvidence['representation'][] = reference.maskDataUrl
      ? ['original', 'selection-location', 'selection-crop']
      : [reference.visualVariant ?? representation]
    for (const [index, kind] of representations.entries()) {
      const block = prepared.content[index]!
      bytes += Buffer.byteLength(JSON.stringify(block), 'utf8')
      assertVisualBytes(bytes)
      await registerVisualBlock(block, {
        imageId: reference.imageId,
        source: typeof source === 'string' ? source : source(reference),
        representation: kind,
        selection: Boolean(reference.maskDataUrl),
      })
      content.push(block)
    }
    listed.push(
      ...prepared.listed.map((entry) => ({
        ...entry,
        representation: reference.visualVariant ?? representation,
      })),
    )
  }
  return { content, manifest: evidenceManifest(listed) }
}

export const registerVisualBlock = (
  block: ImageContent,
  identity: Pick<VisualEvidence, 'imageId' | 'source' | 'representation' | 'selection'>,
): Promise<void> => withVisualPreparation(() => registerBlock(block, identity))
export const prepareVisualEvidence = (
  references: readonly ResolvedAgentImage[],
  source: VisualEvidenceSource,
  representation: NonNullable<ResolvedAgentImage['visualVariant']> = 'original',
) => withVisualPreparation(() => prepareEvidence(references, source, representation))
