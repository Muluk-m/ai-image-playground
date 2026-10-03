import { t } from 'elysia'

const id = t.String({ minLength: 1, maxLength: 128 })
export const productionReferenceSchema = t.Union([
  t.Object({ kind: t.Literal('media'), mediaId: id }),
  t.Object({ kind: t.Literal('artifact'), artifactId: id }),
  t.Object({ kind: t.Literal('asset'), imageId: id }),
])
const entity = {
  id,
  name: t.String({ maxLength: 200 }),
  description: t.String({ maxLength: 10000 }),
}
export const productionLocationSchema = t.Object({
  ...entity,
  reference: t.Optional(productionReferenceSchema),
})
export const productionCharacterSchema = t.Object({
  ...entity,
  looks: t.Array(productionLocationSchema, { maxItems: 100 }),
})
export const productionAssetFields = {
  characters: t.Array(productionCharacterSchema, { maxItems: 100 }),
  locations: t.Array(productionLocationSchema, { maxItems: 100 }),
}
