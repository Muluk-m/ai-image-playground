import { registerInterruptedTurnRecoverer } from '../modules/agent/contracts'

/**
 * 组合根注册智能体中断轮恢复端口（幂等）：
 * 保持 `modules/agent/runtime/stream-broker` 零依赖 `lib/agent/interrupted` 与工具注册表；
 * 仅静态导入无配置副作用的 `contracts` 注册器，恢复实现按需惰性加载。
 */
export function registerDefaultAgentRuntimeHooks(): void {
  registerInterruptedTurnRecoverer((conversationId, turnId) =>
    import('../lib/agent/interrupted').then((it) =>
      it.recoverInterruptedTurn(conversationId, turnId),
    ),
  )
}

registerDefaultAgentRuntimeHooks()
