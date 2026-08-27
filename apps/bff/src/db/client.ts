import { createSqlitePersistence } from '@image-playground/db'
import { config } from '../config'

export const persistence = createSqlitePersistence(config.databaseUrl)
export const taskStore = persistence.tasks
export const pixelStore = persistence.pixels
export const { checkpointWal, db, schema } = persistence
