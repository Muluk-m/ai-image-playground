import { db, schema } from '../db/client'

const AUDIT_ACTIONS = new Set(['tasks.export'])

export class OperatorAuditError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OperatorAuditError'
  }
}

/** Admin 进程只有只读库权限，导出这类读操作的审计从这里写入。 */
export async function recordOperatorAudit(input: {
  operatorId?: string
  action: string
  targetType: string
  targetId: string
  details: Record<string, unknown>
}): Promise<void> {
  if (!AUDIT_ACTIONS.has(input.action)) throw new OperatorAuditError('不支持的审计动作')
  const operatorId = input.operatorId?.trim()
  if (input.targetType.length === 0 || input.targetType.length > 64)
    throw new OperatorAuditError('无效的审计对象')
  if (input.targetId.length === 0 || input.targetId.length > 128)
    throw new OperatorAuditError('无效的审计对象')
  await db.insert(schema.operator_audits).values({
    id: crypto.randomUUID(),
    operator_id: operatorId && operatorId.length <= 320 ? operatorId : 'admin',
    action: input.action,
    target_type: input.targetType,
    target_id: input.targetId,
    details: input.details,
    created_at: Date.now(),
  })
}
