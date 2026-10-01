import { VIDEO_ASPECT_RATIOS, VIDEO_RESOLUTIONS } from '@image-playground/shared'
import { t } from 'elysia'
import { productionReferenceSchema } from './production-asset-schema'

export const productionClipSchema = t.Array(
  t.Object({
    id: t.String({ minLength: 1, maxLength: 128 }),
    name: t.String({ maxLength: 200 }),
    shotIds: t.Array(t.String({ minLength: 1, maxLength: 128 }), { minItems: 1, maxItems: 100 }),
    prompt: t.String({ maxLength: 32000 }),
    model: t.String({ minLength: 1, maxLength: 200 }),
    sourceRevision: t.Integer({ minimum: 0 }),
    references: t.Array(
      t.Object({
        reference: productionReferenceSchema,
        usage: t.Union([t.Literal('first-frame'), t.Literal('last-frame'), t.Literal('reference')]),
      }),
      { maxItems: 16 },
    ),
    video: t.Object({
      duration_seconds: t.Number(),
      aspect_ratio: t.Union(VIDEO_ASPECT_RATIOS.map((value) => t.Literal(value))),
      resolution: t.Union(VIDEO_RESOLUTIONS.map((value) => t.Literal(value))),
      first_frame_index: t.Optional(t.Integer({ minimum: 0 })),
      last_frame_index: t.Optional(t.Integer({ minimum: 0 })),
      reference_image_indices: t.Optional(t.Array(t.Integer({ minimum: 0 }))),
      mode: t.Optional(t.Literal('generate')),
    }),
    adopted: t.Optional(
      t.Object({
        draftId: t.String({ minLength: 1, maxLength: 128 }),
        artifactId: t.String({ minLength: 1, maxLength: 128 }),
        adoptedAt: t.Number(),
      }),
    ),
  }),
  { maxItems: 40 },
)
