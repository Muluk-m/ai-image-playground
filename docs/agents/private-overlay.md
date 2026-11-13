# 私有 overlay 与版本模型

改到 `private/`、三个 overlay 接缝或宿主面、`private.lock`、`pnpm-lock.yaml`、私有迁移，或公开树与带 overlay 构建差异时读本文。根 `AGENTS.md` 只保留摘要。

## 版本模型与分支

**生产服务端只有一套 muvloom runtime。** `apps/bff`、`apps/admin` 服务端、`packages/db` 的能力注册表 deny by default，由运营配置 `operator-config.json` 决定开哪些能力。企业域名使用同一套后端，以 origin 配置登录策略。

**overlay 是构建输入。** 生产与独立测试均带私有 overlay；公开树仍须在没有 overlay 时独立通过检查和构建，供开源、自部署与 CI 使用，不代表第二个受管生产部署。

- 生产 workflow 执行 `./scripts/build-vps-release.sh paid <目录>`，带入 `private.lock` 钉住的 overlay 提交，并保留 backup 与 segmenter 镜像；应急时在 macmini2 执行同一脚本。后端只支持 `paid`（生产）和 `test`（隔离测试）两个目标；测试包不携带 segmenter。

**分支：** `main` 是唯一长期开发分支，所有改动开 PR 直合 main。`test` 是独立发布分支，只承接待验收提交，不回流开发分支。

**构建输入与部署环境：**

- muvloom 生产与测试 = 同组公开提交 + 仓库根 `private/` overlay（来源 `Muluk-m/ai-image-playground-private`，提交由 `private.lock` 固定）+ 各自仓库外 env 文件与数据资源。
- 公开树构建 = 不带 overlay 的开源 / 自部署产物与 CI 检查，不是企业域名的独立版本。

## 接缝与宿主面

`private/apps/{bff,web,admin}` 是可选 overlay 工作区；目录缺席时公开树必须独立
typecheck、测试和构建。两个方向的边界都由 `scripts/check-private-boundary.ts`（`pnpm lint`）强制：

公开树只允许以下三个审计接缝引用 `private/`：

- `apps/bff/src/lib/private-overlay.ts`：任务事务 hook 与私有 BFF routes
- `apps/web/src/lib/privateOverlay.tsx`：用户侧 header、提交门禁和状态 UI
- `apps/admin/src/lib/private-overlay.tsx`：运营概览、用户摘要和用户详情 UI

overlay 反过来只允许通过上面三个接缝与以下**宿主面**引公开树，不许 `../../../apps/*/src/...`
深路径（测试文件除外）：

- `apps/bff/src/lib/private-host.ts`、`apps/web/src/lib/privateHost.ts`、`apps/admin/src/lib/private-host.ts`（lib）与 `private-host-ui.ts`（shadcn 组件，走 `@/` 别名，bun 测试不能碰）

- `apps/web/src/lib/privateIcons.ts`：跨 Web / Admin 的纯展示图标与 `cn`，不加载 Web i18n、登录或配置初始化。共享徽标从此入口引用。

宿主面里每一行都是对 muvloom 版的承诺。改动只能**先扩后缩**：加成员随时；改名 / 删除 / 换签名前
先确认 `private.lock` 钉住的 overlay 不再引用它——公开 CI 的 `with-overlay` 作业（候选公开树 +
钉住的 overlay 一起 lint / typecheck / build）会替你查。overlay 需要新宿主成员时，先在公开树
加成员合进 main，再合 overlay；反过来合会让 overlay CI 红、`verified` 指针停在旧版。

**overlay 版本由 `private.lock` 钉住**（一行 sha）。生产部署与 `with-overlay` 都按它取，不读活动
指针。overlay CI 全绿把 `verified` 前移后，`.github/workflows/overlay-bump.yml`（每 10 分钟，
也可手动跑）把 lock 抬到它：先把这对组合构建一遍，通过才提交，由下一个发布窗口上线（不再立即触发生产部署）——
所以 overlay 合并**会**上线，不必等公开 main 另有提交；紧急时手动 `workflow_dispatch` 生产部署并填 `reason`。本地 `private/` 用
`scripts/sync-private-overlay.sh` 对齐到 lock；两边错位时 typecheck / 全量测试会红（overlay 引了
公开树没有的宿主面成员），那是版本没对上，不是代码坏了。测试环境也按 `private.lock` 取，前后端
固定同一 overlay 提交。

私有 Admin 的所有写操作经 `/api/private/*` 代理到 BFF 的
`/internal/admin/private/*`；Admin 数据库角色保持 SELECT-only。添加私有模块后，
必须同时跑公开包和对应私有包的 typecheck，并分别验证「目录存在」与「目录缺席」构建。
验证 overlay 构建一律 `pnpm build --force`：turbo 的输入哈希看不见 gitignored 的 `private/`，
不加 `--force` 会命中不带 overlay 的缓存产物。

私有迁移新建 schema 时，必须把 schema 名登记到部署的 `POSTGRES_EXTRA_SCHEMAS` 并重跑
provision，否则 SELECT-only 的备份角色读不到它，每日 `pg_dump` 全库失败。

给私有 overlay 包加依赖时，必须带着 `private/` 重新生成公开的 `pnpm-lock.yaml` 并提交——公开
lockfile 里带着 `private/apps/*` 三个 importer，这是「公开树零改动」唯一被接受的例外。同理
镜像的 deps stage 也要装 overlay 的 manifest，否则 pnpm 不会把只有 overlay 依赖的包拉进 store，
后续 stage 的 `pnpm install --offline` 会以 `ERR_PNPM_NO_OFFLINE_TARBALL` 失败。

**任何** lockfile 重新生成都必须带着 `private/`：在没有 overlay 的 checkout 里跑 `pnpm install`
会静默删掉这三个 importer，muvloom 镜像与 muvloom Pages 的 `--frozen-lockfile` 随即以
`ERR_PNPM_OUTDATED_LOCKFILE` 失败。
