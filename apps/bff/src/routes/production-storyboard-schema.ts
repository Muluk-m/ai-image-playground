import { PRODUCTION_SHOTS_MAX } from '@image-playground/shared'
import { t } from 'elysia'
import { productionReferenceSchema } from './production-asset-schema'

export const productionShotsSchema = t.Array(
  t.Object({
    id: t.String({ minLength: 1, maxLength: 128 }),
    scriptSceneId: t.Optional(t.String({ minLength: 1, maxLength: 128 })),
    locationId: t.Optional(t.String({ minLength: 1, maxLength: 128 })),
    lookIds: t.Array(t.String({ minLength: 1, maxLength: 128 }), { maxItems: 30 }),
    description: t.String({ maxLength: 10000 }),
    dialogue: t.Optional(t.String({ maxLength: 10000 })),
    camera: t.Optional(t.String({ maxLength: 10000 })),
    durationSeconds: t.Optional(t.Number({ exclusiveMinimum: 0 })),
    keyframe: t.Optional(productionReferenceSchema),
  }),
  { maxItems: PRODUCTION_SHOTS_MAX },
)
