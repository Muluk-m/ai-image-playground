# 私有 overlay 与版本模型（已退役）

> **状态：已退役（ADR 0034 Phase 1）**。自单仓收敛完成后，`private/` 嵌套仓库、`private.lock`、
> `overlay-bump.yml`、`scripts/check-private-boundary.ts`、`scripts/sync-private-overlay.sh`
> 及 CI 的 `with-overlay*` 重复作业均已下线。

## 当前单仓模型

- 所有业务模块（含计费、订单、邀请、飞书 OAuth 与对应 Web/Admin 界面）已直接并入公开主仓：
  - 共享契约：`packages/shared/src/billing-contracts.ts`、`packages/shared/src/membership-tier.ts`
  - 计费表结构与迁移：`packages/db/src/schemas/billing.ts`、`packages/db/drizzle-billing/`（继续沿用既有的 `private_billing.migrations` 历史表，兼容生产与测试库）
  - BFF 模块：`apps/bff/src/modules/billing/`、`apps/bff/src/modules/identity/oauth/feishu.ts`，由 `apps/bff/src/bootstrap/billing.ts` 在组合根注册
  - 前端模块：`apps/web/src/features/billing/`、`apps/admin/src/features/billing/`、`apps/admin/src/routes/_authed.billing.{orders,settings}.tsx`
- 商业能力完全由运行时 `operator-config` 控制（默认 `billing:credits=false`，关闭时计费路由返回 `404 capability_unavailable`，计费钩子不触碰计费表，前端不展示计费入口）。
- 运营收款码与客服二维码保留在私有对象存储，通过 `billing_settings.payment_qr_url` / `contact_qr_url` 配置，不入仓。
- 架构边界与后续演进见 [ADR 0034](../adr/0034-modular-monolith-and-single-repo.md)。
