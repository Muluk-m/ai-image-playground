import { createDb } from '@image-playground/db'
import { config } from '../config'

const { db, schema, close } = createDb(config.databaseUrl)

export { close, db, schema }
