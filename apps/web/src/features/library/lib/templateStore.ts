import { STORE_TEMPLATES } from '../../../lib/db'
import type { TemplateRecord } from '../types'
import { createRecordStore } from './recordStore'

/** 模板存储后端。服务端实现替换 templateStore 这一个绑定即可。 */
export const templateStore = createRecordStore<TemplateRecord>(STORE_TEMPLATES)
