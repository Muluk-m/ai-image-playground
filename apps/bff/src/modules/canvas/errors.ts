/**
 * 画布节点与分镜表领域校验错误。
 * 保持 `modules/canvas` 零依赖 `modules/agent`；调用方（如 Agent 工具层）可按需转换为工具错误。
 */
export class CanvasValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CanvasValidationError'
  }
}

export function throwCanvasInvalid(message: string): never {
  throw new CanvasValidationError(message)
}
