# CLAUDE.md

本文件给 Claude Code（claude.ai/code）当作工作约定。**严格遵守**，不要按通用 monorepo 直觉走。

## 部署与灾备

- **生产：Pages + VPS，合并 main 即由 GitHub Actions（`.github/workflows/deploy.yml`）部署：镜像在 Actions 构建、经私有 GHCR 按 digest 拉到 VPS，再发布两套 Pages。会话只合并到 main，不手动发布；手动发布（macmini2 构建）仅作应急。** VPS 只接收镜像，不安装构建依赖或编译。公开提交通过 PR/main CI，私有 overlay 固定到已验证提交；使用独立检出、既有构建锁和发布锁。
- 前端两套 Pages、后端发布、排空、回滚与验收按[部署手册](docs/deploy/image-release.md)。不得强停在途执行器；迁移须兼容新旧版本。验收 API、登录和业务数据后才报告完成。
- **测试环境：推 `test` 分支即由 `.github/workflows/deploy-test.yml` 发布到 https://test.muvloom.online（独立 Pages 项目 `muvloom-test`，与付费站同账号，发的是付费形态的包）。** 流程是「`ci-check-test-branch.sh` 确认 test 不落后 main → lint / typecheck / apps/web build → 克隆 overlay → `scripts/pages-release.sh test`」。**落后 main 直接失败，CI 不自动合**：无人看管地解冲突会让测试站跑着一份哪里都不存在的代码；红灯时把 main 合进 test 再推一次。只发前端，**`TEST_BFF_BASE_URL` 目前就是付费站的生产 API，测试站读写生产数据**。别在 `test` 上直接改代码，也别拿它当长期集成分支。细节见[测试环境手册](docs/deploy/test-environment.md)。
- 前端发布只有 `scripts/pages-release.sh` 一个入口，用 `internal|paid|test` 选目标，每个目标的 Pages 项目与域名在 `pages.env` 里各自写死。底层的 `scripts/pages-deploy.sh` 不直接调——漏掉分支参数曾把未合并的分支发到生产。
- macmini2 旧备用已停止，Tunnel 禁用；配置、镜像及数据卷保留。启停与历史数据状态见[灾备附录](docs/deploy/cold-recovery.md#附录旧备用服务)。
- 灾备采用[R2 按需冷恢复](docs/deploy/cold-recovery.md)，不定时同步备用 PG；新实例只用 R2。保持原域名、会话密钥和账号命名空间，切回前核对两端增量；不得直接覆盖原库或自动绑定匿名数据。
- 固定 API 切换和跨机器单写者保护尚未上线；不得将恢复演练或同库发布排空视为完整灾备。

## 项目概况

`ai-image-playground` — AI 生图工作台。fork 自 [CookSleep/gpt_image_playground](https://github.com/CookSleep/gpt_image_playground)，扩展了 Gemini 原生协议、异步队列模式、可选 BFF 后端、内置 channel discovery。

- `apps/web/` — 前端工作台。画布、已缓存产物与配置存浏览器 IndexedDB；完整 Agent 对话存对应 BFF 的 PostgreSQL，本地不是完整消息备份。
- `apps/bff/` — **可选**任务队列 BFF（`:37377`），托管 web/dist 同源，跑长任务（绕浏览器 / Edge 长超时）。
- `apps/admin/` — 可选运维面板（`:37378`）。HMAC cookie 鉴权；数据库连接只读，用户与运营写操作一律代理到 BFF。
- `packages/shared/` — 跨 app 协议类型。

两种部署形态（详见仓库根 `README.md`）：

- **Tier 1：纯静态** — 仅 `apps/web/dist`，BYOK only，浏览器直连上游
- **Tier 2：静态 + BFF** — Docker 镜像或裸跑 BFF + web/dist 同进程托管

各 app 的内部约定（服务商架构、内置 channel、BFF 定位、queue 协议等）放在 `apps/web/CLAUDE.md` 与 `apps/bff/CLAUDE.md`，改到对应目录时自动加载。

## 完成任务的硬性检查清单

**任何一次改完代码、提交前都要跑下面三件事**，缺一不可：

1. `pnpm exec biome check --write .` — 自动修 format + import 排序；然后 `pnpm lint` 二次确认 0 errors（biome.json 自身的 schema deprecation warning/info 是已知 noise，可忽略）。`pnpm format` 只改 format、不动 import 顺序，修 lint 错不要用它。
2. `pnpm typecheck` — TypeScript 跨包 build 检查
3. **测试**：顶层 `pnpm test`，或在改动涉及的 app 目录里跑 `pnpm test`。PostgreSQL 集成测试需要 `TEST_DATABASE_URL`（本机例：`TEST_DATABASE_URL=postgres://qiqian@127.0.0.1:5432/aip_test`），未设置会直接报错失败。

任一项不过就不要 push。

CI（`.github/workflows/web.yml`，PR 与 push 到 main 都跑）执行 `pnpm lint`、`pnpm typecheck`、
`apps/web` 构建，并在带 PostgreSQL 的 job 中串行执行公开 workspace 的完整 `pnpm test`，
包含 BFF、Admin 和数据库迁移回滚测试。**私有包不在公开 CI 中**；涉及私有接缝时仍需在
带 `private/` 的环境中完成对应测试，不能只凭 PR 变绿判断。

**默认交付到生产。** 代码修改通过检查后，继续创建 PR、等 CI、合并 `main`；合并后由部署 workflow 自动发布，会话不手动发布，只跟进该 workflow 结果并核验线上版本和行为。除非用户明确要求仅本地修改或暂不合并，否则直接完成整条链路，无需再次询问是否部署。

## 测试约定

- **BFF / Admin 后端测试使用 `bun:test`**：数据库与对象存储客户端依赖 Bun runtime，不要换成 Vitest。前端测试继续使用 [Vitest](https://vitest.dev/) 4。不要在同一测试文件混用两套 API。
- **测试文件统一放在 `<app>/src/__tests__/` 下**，保留与被测代码相同的子目录结构。例：
  - 源 `apps/web/src/lib/api.ts` → 测 `apps/web/src/__tests__/lib/api.test.ts`
  - 源 `apps/bff/src/routes/submit.ts` → 测 `apps/bff/src/__tests__/routes/submit.test.ts`
- 测试文件命名 `*.test.ts(x)`；Vitest 默认配置自动发现，不需要单独注册
- 私有树包不强制使用 `src/` 目录；其测试放在相邻模块的 `__tests__/` 下（例如 `private/apps/bff/billing/__tests__/`）。
- **数据库测试一个文件一个进程**：`apps/bff`、`apps/admin`、`packages/db` 与私有 BFF 的 `pnpm test`
  都走 [`scripts/run-bun-tests-isolated.ts`](./scripts/run-bun-tests-isolated.ts)，逐文件 spawn 一个 bun 进程。
  这些测试在模块顶层把 `DATABASE_URL`、`OPERATOR_CONFIG_FILE` 之类 env 定死，再 import `app`、
  `db/client`、`operator-config` 这些模块单例；同一个 bun 进程里跑多个文件，后导入的文件只会拿到
  先导入者绑好的库和配置。所以**跑包级别的 `pnpm test`，不要用 `bun test <过滤词>`**——后者一次
  加载多个文件。真这么跑时，`resetTestDatabase` 会在第二个 suite 上立刻抛错并指回 `pnpm test`，
  不再伪装成一串 `PostgresError: Connection closed`。
- 外部网络 / 上游 API 必须 mock，测试不能依赖在线服务或宿主机固定文件。PostgreSQL 集成测试可通过 `TEST_DATABASE_URL` 创建并清理独立测试库；文件存在性接缝测试可使用测试进程创建并清理的临时目录。
- `vi.mock` 的字符串路径用相对路径从测试文件位置出发；测试位于 `__tests__/` 下时，到 source 的相对路径要回上若干层，例如 `apps/web/src/__tests__/lib/api.test.ts` 里 mock 源代码：
  ```ts
  vi.mock('../../lib/channels/publicChannels', () => ({ ... }))
  ```

## Runtime 配置

[`packages/shared/src/runtime-config.ts`](./packages/shared/src/runtime-config.ts) 定义 schema。
`runtime-config.json` 只保存连接 BFF 前必须知道的启用状态与地址：`bff.enabled`、默认
`bff.baseUrl`，以及可选的 `bff.baseUrlsByOrigin`。多个前端域名共享发布包时，按当前前端
origin 精确选择映射中的 API；未匹配时沿用默认地址，以保留各域名原有的第一方登录 Cookie。schema
无效或文件不存在时回退到 `BAKED_DEFAULTS`（`bff.enabled=false`）。能力只能由 BFF 求值，前端并行读取
`/api/capabilities` 与 channel 列表，清单不可用时全部按关闭处理，禁止把能力写回 runtime
配置。Docker entrypoint 从 env 生成 runtime 配置；裸跑或纯静态部署可自行生成。

## 私有树接缝

`private/apps/{bff,web,admin}` 是可选 overlay 工作区；目录缺席时公开树必须独立
typecheck、测试和构建。两个方向的边界都由 `scripts/check-private-boundary.ts`（`pnpm lint`）强制：

公开树只允许以下三个审计接缝引用 `private/`：

- `apps/bff/src/lib/private-overlay.ts`：任务事务 hook 与私有 BFF routes
- `apps/web/src/lib/privateOverlay.tsx`：用户侧 header、提交门禁和状态 UI
- `apps/admin/src/lib/private-overlay.tsx`：运营概览、用户摘要和用户详情 UI

overlay 反过来只允许通过上面三个接缝与三个**宿主面**引公开树，不许 `../../../apps/*/src/...`
深路径（测试文件除外）：

- `apps/bff/src/lib/private-host.ts`、`apps/web/src/lib/privateHost.ts`、`apps/admin/src/lib/private-host.ts`（lib）与 `private-host-ui.ts`（shadcn 组件，走 `@/` 别名，bun 测试不能碰）

宿主面里每一行都是对收费版的承诺。改动只能**先扩后缩**：加成员随时；改名 / 删除 / 换签名前
先确认 `private.lock` 钉住的 overlay 不再引用它——公开 CI 的 `with-overlay` 作业（候选公开树 +
钉住的 overlay 一起 lint / typecheck / build）会替你查。overlay 需要新宿主成员时，先在公开树
加成员合进 main，再合 overlay；反过来合会让 overlay CI 红、`verified` 指针停在旧版。

**overlay 版本由 `private.lock` 钉住**（一行 sha）。生产部署与 `with-overlay` 都按它取，不读活动
指针。overlay CI 全绿把 `verified` 前移后，`.github/workflows/overlay-bump.yml`（每 10 分钟，
也可手动跑）把 lock 抬到它：先把这对组合构建一遍，通过才提交，并显式触发一次生产部署——
所以 overlay 合并**会**上线，不必等公开 main 另有提交。本地 `private/` 用
`scripts/sync-private-overlay.sh` 对齐到 lock；两边错位时 typecheck / 全量测试会红（overlay 引了
公开树没有的宿主面成员），那是版本没对上，不是代码坏了。测试环境仍取 overlay main HEAD（预览下
一版），所以 test 可能比生产多出尚未钉住的 overlay 提交。

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
会静默删掉这三个 importer，收费镜像与收费 Pages 的 `--frozen-lockfile` 随即以
`ERR_PNPM_OUTDATED_LOCKFILE` 失败。

## 版本模型与分支

**服务端只有一套。** `apps/bff`、`apps/admin` 服务端、`packages/db` 同时兼容收费与免费部署：
能力注册表 deny by default，由运营配置 `operator-config.json` 决定开哪些能力，代码不分版本。

**收费与免费的区别只在前端构建参数。** 构建时带上私有 overlay 就是收费形态，不带就是免费形态：

- 生产镜像由部署 workflow 执行 `./scripts/build-vps-release.sh all <目录>` 构建（付费版带入私有 overlay 的 main HEAD）；应急时在 macmini2 手动执行同一脚本（`internal`/`paid`/`all`）。

**分支：** `main` 是唯一长期分支，所有改动开 PR 直合 main，没有其他长期分支。

**形态由构建输入决定，不由分支决定：**

- 收费 = `main` + 仓库根 `private/` overlay（来源 `Muluk-m/ai-image-playground-private`，clone 到 `private/`）+ 仓库外 env 文件
- 免费 = `main` 不带 overlay

## 提交规范

- 不要 `git add -A`，工作区常有未追踪的本地配置（`.env.local`、`out.png` 等），容易夹带。**只 add 明确改动的文件**。
- Commit message 用 Conventional Commits（`feat:` / `fix(scope):` / `docs:` …）。
- 在 monorepo 内通常用 scope 指 app，如 `feat(web): ...` / `feat(bff): ...` / `feat(admin): ...`。
- **一个模块/一件事做完就立刻 commit，不要把多件事堆在工作区或暂存区。** 一次会话里改了四处不相干的东西，就是四个 commit；堆成一坨之后既没法单独 review，也没法单独 revert，冲突时更难挑拣。
- 提交的时机是「这件事自己能跑通且验证过」，不是「全部功能都做完」。后续还要改的部分另起 commit。

## Spec / Plan 流程（ask-matt）

复杂改动走 Matt Pocock skills 主流程。**不用 openspec**，也不要新建 `openspec/` 目录：那套流程已退役。

1. `/grill-with-docs` — 面谈把想法磨清；决策落 `CONTEXT.md` 与 `docs/adr/`。
2. 有必须跑起来才能回答的问题（状态模型、业务逻辑、要看见的 UI）→ `/prototype`，用 `/handoff` 进出。
3. 跨 session 的活：`/to-spec` 把对话写成 spec 发到 GitHub Issue（标 `ready-for-agent`）→ `/to-tickets`
   拆成带 blocking 边的 tracer-bullet tickets → 每张 ticket 单独 `/implement`（内部走 `/tdd` 与 `/code-review`），
   ticket 之间 `/clear`。步骤 1–3 保持在同一个 context 里，`/to-tickets` 之前不 compact。
4. 单 session 能做完的：直接 `/implement`。

不确定该用哪个 skill 就 `/ask-matt`。简单 bug fix 直接动手；难查的 bug 走 `/diagnosing-bugs`；
大到一个 session 装不下、方向还在雾里的走 `/wayfinder`。`docs/ROADMAP.md` 里的每一项动工都从第 1 步开始。

## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues of `Muluk-m/ai-image-playground` (`gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary (`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`). See `docs/agents/triage-labels.md`.

### Roadmap

Product directions, dependencies and open decisions live in `docs/ROADMAP.md`; tracking issues carry the `roadmap` label.

### Domain docs

Single-context: root `CONTEXT.md` + `docs/adr/`. See `docs/agents/domain.md`.
