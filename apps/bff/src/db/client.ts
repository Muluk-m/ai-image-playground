import { createDb } from '@image-playground/db'
import { config } from '../config'

const { db, schema, checkpointWal } = createDb(config.databaseUrl)

export { checkpointWal, db, schema }
