# 0036：全仓架构降熵、规范化归一与面向多 Agent 并行开发的复杂度治理

日期：2026-11-28。状态：实施中（Wave 1 已合并 `#2053`，Wave 2 已落地）。关联：[ADR 0034](0034-modular-monolith-and-single-repo.md)、[#1848](https://github.com/Muluk-m/ai-image-playground/issues/1848)。

## 背景

[ADR 0034](0034-modular-monolith-and-single-repo.md) 已完成单仓合并、数据库热路径瘦身以及 `apps/bff/src`、`apps/admin/server`、`packages/db/src`、`packages/read-models/src` 的 0 运行时循环依赖锁定。但对 `main`（`82c03cd02`）做全仓静态量化盘点后，仍存在五类系统性结构熵，显著抬高理解成本并限制多 Agent 并行开发：

1. **共享契约与前端/站点缺少全仓无环护栏**：
   - `packages/shared/src` 存在 3 文件运行时循环依赖（`canvas-cloud.ts <-> canvas-document.ts <-> canvas-results.ts`），且 `packages/shared/src/agent.ts` 单文件承载 1,697 行跨子域契约。
   - `scripts/check-arch-boundaries.ts` 未覆盖 `packages/shared/src`、`packages/node-kit/src`、`apps/web/src`、`apps/admin/src`、`apps/website/src`，且未解析 `@/` 路径别名。
2. **BFF 遗留兼容壳与双路径导入税**：
   - `apps/bff/src/lib/` 仍残留 99 个纯重导出兼容壳（98 个在 `lib/agent/`，其中 `lib/agent/reply-script.ts` 重导出自 `@image-playground/shared`，其余指向 `modules/agent/*`；另 1 个 `lib/task-access.ts` 指向 `modules/execution`），同一符号存在 `lib/*` 与 `modules/*` 两套路径，迫使 `check-arch-boundaries.ts` 维护 68 项 `LEGACY_AGENT_MIGRATED_SHIMS` 硬编码表（其中 4 个文件 `background-jobs.ts`、`events.ts`、`inbox-pickup.ts`、`turn.ts` 含运行时装配/兜底逻辑，非纯重导出壳）。
3. **BFF 数据库层倒挂与路由单体**：
   - `ALLOWED_DB_TO_OUTSIDE` 残留 12 条，其中 9 条来自 `apps/bff/src/db/maintenance.ts`（在 `db/` 目录里直接编排 `modules/agent`、`modules/execution`、`lib/objectStore` 等上层能力）。
   - `apps/bff/src/routes/agent.ts` 单文件 1,278 行，把会话、消息/轮次、收件箱队列、后台任务、阶段与技能路由混放一处。
4. **前端工作台巨型循环依赖与上帝状态文件**：
   - `apps/web/src` 存在 3 处运行时循环依赖，其中包括横跨 `store.ts`、`lib/*`、`features/canvas/lib/*` 与 `features/agent/lib/artifactSource.ts` 的 26 文件巨型强连通分量。
   - `apps/web/src/store.ts`（3,643 行，146 处直接运行时导入）与 `apps/web/src/features/agent/store.ts`（2,418 行）成为多 Agent 并行改动的高冲突热点；`lib/ -> features/` 存在 24 条反向边。
5. **多 Agent 并行开发的边界可发现性**：
   - 模块门面、依赖方向与允许的例外必须由 CI 棘轮自动守护，而非依赖人工记忆。

## 决定

以「零行为变更、小步切片、每波锁定 CI 棘轮」的原则分波推进全仓降熵：

1. **Wave 1 — 共享契约无环化、拆包与全仓无环护栏扩容**：
   - 将 `canvas-upload-claim.ts` 与 `canvas-result-store.ts` 下沉为无环底层原语，保留 `canvas-cloud.ts` / `canvas-results.ts` / `index.ts` 原有导出不变，清零 `packages/shared/src` 运行时循环依赖。
   - 将 `packages/shared/src/agent.ts` 按域拆为 `agent/{skills,turn-params,tools,messages,stream}.ts` 五个严格单向子模块，`agent.ts` 退化为薄门面。
   - 扩展 `scripts/check-arch-boundaries.ts` 支持按目录显式声明 `rootAlias`（如 `apps/admin/src` 启用 `@/`），并将 `packages/shared/src`、`packages/node-kit/src`、`apps/admin/src`、`apps/website/src` 纳入 CI 0 循环依赖门禁。
2. **Wave 2 — 清除 BFF 99 个纯重导出兼容壳，归一单一权威导入路径**：
   - 将所有仍引用纯重导出壳的源码与测试统一切至 `modules/agent/*`、`modules/execution` 或 `@image-playground/shared`，删除全部 99 个纯重导出壳；将 `LEGACY_AGENT_MIGRATED_SHIMS` 收窄至仅剩 4 个含运行时装配逻辑的过渡文件（`background-jobs.ts`、`events.ts`、`inbox-pickup.ts`、`turn.ts`），待其装配逻辑迁至组合根后再彻底清零。
3. **Wave 3 — 剥离 `db/maintenance.ts` 上层编排并拆分 `routes/agent.ts`**：
   - 将维护编排迁出 `apps/bff/src/db/`，把 `ALLOWED_DB_TO_OUTSIDE` 从 12 条压降至仅剩基础设施启动必需边。
   - 将 `apps/bff/src/routes/agent.ts` 按子资源拆为 `routes/agent/*.ts`，由薄装配入口组合。
4. **Wave 4 — 清零 `apps/web/src` 全部运行时循环依赖并建立前端边界棘轮**：
   - 打破 26 文件巨型 SCC 及另外 2 处 2 文件循环，使全仓所有包与 app 均达到 0 运行时循环依赖，在 `scripts/check-arch-boundaries.ts` 锁定 `apps/web/src` 无环门禁及 `lib/ -> features/` 只减不增白名单棘轮。
5. **Wave 5 — `apps/web/src/store.ts` 按领域切片拆解**：
   - 在保持 `store.ts` 对外接口与 146 处调用方零破坏的前提下，将 3,643 行状态与动作拆为 `store/` 下的独立领域模块。
6. **Wave 6 — `features/agent/store.ts` 拆解与剩余棘轮收紧**：
   - 将 `apps/web/src/features/agent/store.ts` 按域拆解，并持续压降 `ALLOWED_EXECUTION_TO_LEGACY_LIB` 与前端反向依赖白名单。

## 纪律

- 每波拆成独立、可审阅、行为等价的 PR，不混入产品功能变化、计费结算逻辑变更或破坏性迁移。
- 涉及大范围 `.tsx` / `.css` 视觉结构改动时遵循 `PR rules` 与测试环境截图要求；纯 `.ts` 架构与状态切片保持零视觉漂移。
- 每消除一类坏边即同步收紧 `scripts/check-arch-boundaries.ts` 与 `checkStaleAllowlist`，防止熵回流。

## 实施进度

| 波次 | 范围 | 状态 |
| --- | --- | --- |
| Wave 1 | `packages/shared` 去环与 `agent.ts` 拆包、`check-arch-boundaries` 扩展至 shared/node-kit/admin/website | 已合并（#2053） |
| Wave 2 | 移除 BFF 99 个纯重导出壳并归一导入路径，收窄 `LEGACY_AGENT_MIGRATED_SHIMS` 至 4 项 | 已落地 |
| Wave 3 | `db/maintenance.ts` 编排迁出与 `routes/agent.ts` 子路由拆解 | 待开始 |
| Wave 4 | `apps/web/src` 0 运行时循环依赖与前端边界棘轮 | 待开始 |
| Wave 5 | `apps/web/src/store.ts` 按领域拆解 | 待开始 |
| Wave 6 | `features/agent/store.ts` 拆解与存量白名单收紧 | 待开始 |
