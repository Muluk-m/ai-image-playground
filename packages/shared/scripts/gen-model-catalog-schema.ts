import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderModelCatalogSchema } from '../src/model-catalog/schema'

const target = join(import.meta.dir, '../src/model-catalog/schema.json')
writeFileSync(target, renderModelCatalogSchema())
console.log(`wrote ${target}`)
