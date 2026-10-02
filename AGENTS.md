# AGENTS.md

本文件是代码 Agent 的工作约定。**严格遵守**，不要按通用 monorepo 直觉走。

## 部署与灾备

- **生产：Pages + VPS，合并 main 即由 GitHub Actions（`.github/workflows/deploy.yml`）部署：镜像在 Actions 构建、经私有 GHCR 按 digest 拉到 VPS，再发布两套 Pages。会话只合并到 main，不手动发布；手动发布（macmini2 构建）仅作应急。** VPS 只接收镜像，不安装构建依赖或编译。公开提交通过 PR/main CI，私有 overlay 固定到已验证提交；使用独立检出、既有构建锁和发布锁。
- 前端两套 Pages、后端发布、排空、回滚与验收按[部署手册](docs/deploy/image-release.md)。不得强停在途执行器；迁移须兼容新旧版本。验收 API、登录和业务数据后才报告完成。
- **测试环境**：推 `test` 分支由 `.github/workflows/deploy-test.yml` 发布到 https://test.muvloom.online（付费形态前端）。test 落后 main 会直接失败，把 main 合进 test 再推；别在 `test` 上直接改代码。**测试站的 API 就是付费站生产 API，读写生产数据。** 细节见[测试环境手册](docs/deploy/test-environment.md)。
- 前端发布只用 `scripts/pages-release.sh internal|paid|test|admin`；各目标的 Pages 项目与域名写在仓库外的 `pages.env`（默认 `$XDG_CONFIG_HOME/ai-image-playground/pages.env`，可用 `PAGES_ENV_FILE` 覆盖）。不要直接调底层 `scripts/pages-deploy.sh`——漏掉分支参数曾把未合并分支发到生产。
- 灾备采用[R2 按需冷恢复](docs/deploy/cold-recovery.md)；macmini2 旧备用已停止。固定 API 切换和跨机器单写者保护尚未上线，恢复演练或同库发布排空都不算完整灾备。

## 项目概况

`ai-image-playground` — AI 生图工作台。fork 自 [CookSleep/gpt_image_playground](https://github.com/CookSleep/gpt_image_playground)，扩展了 Gemini 原生协议、异步队列模式、可选 BFF 后端、内置 channel discovery。

- `apps/web/` — 前端工作台。画布、已缓存产物与配置存浏览器 IndexedDB；完整 Agent 对话存对应 BFF 的 PostgreSQL，本地不是完整消息备份。
- `apps/bff/` — **可选**任务队列 BFF（`:37377`），托管 web/dist 同源，跑长任务（绕浏览器 / Edge 长超时）。
- `apps/admin/` — 可选运维面板（`:37378`）。HMAC cookie 鉴权；数据库连接只读，用户与运营写操作一律代理到 BFF。
- `packages/shared/` — 跨 app 协议类型。

两种部署形态（详见仓库根 `README.md`）：

- **Tier 1：纯静态** — 仅 `apps/web/dist`，BYOK only，浏览器直连上游
- **Tier 2：静态 + BFF** — Docker 镜像或裸跑 BFF + web/dist 同进程托管

各 app 的内部约定（服务商架构、内置 channel、BFF 定位、queue 协议等）放在 `apps/web/AGENTS.md` 与 `apps/bff/AGENTS.md`，改到对应目录时自动加载。

## 完成任务的硬性检查清单

**任何一次改完代码、提交前都要跑下面三件事**，缺一不可：

1. `pnpm exec biome check --write .` — 自动修 format + import 排序；然后 `pnpm lint` 二次确认 0 errors（biome.json 自身的 schema deprecation warning/info 是已知 noise，可忽略）。`pnpm format` 只改 format、不动 import 顺序，修 lint 错不要用它。
2. `pnpm typecheck` — TypeScript 跨包 build 检查
3. **测试**：本机只跑改动涉及的包（在该包目录 `pnpm test`，Bun 数据库测试可加 `--filter <路径片段>` 收窄；admin 的 `pnpm test` 先跑全部 vitest，`--filter` 只作用于后面的 Bun 部分）；全量测试交 macmini2 或 CI。PostgreSQL 集成测试需要 `TEST_DATABASE_URL`（本机例：`TEST_DATABASE_URL=postgres://qiqian@127.0.0.1:5432/aip_test`），未设置会直接报错失败。

任一项不过就不要 push。

CI（`.github/workflows/web.yml`，PR 与 push 到 main 都跑）执行 `pnpm lint`、`pnpm typecheck`、
`apps/web` 构建；公开 workspace 的完整 `pnpm test` 分两个并行 job：web 的 vitest 单独一个，其余包在带 PostgreSQL 的 job 中跑（Bun 数据库测试 4 路并发）；
`with-overlay` job 再用 `private.lock` 钉住的 overlay 跑 lint / typecheck / build 与私有包测试。

**默认交付到生产。** 代码修改通过检查后，继续创建 PR、等 CI、合并 `main`；合并后由部署 workflow 自动发布，会话不手动发布，只跟进该 workflow 结果并核验线上版本和行为。除非用户明确要求仅本地修改或暂不合并，否则直接完成整条链路，无需再次询问是否部署。

## 测试约定

- **BFF / Admin 后端测试使用 `bun:test`**：数据库与对象存储客户端依赖 Bun runtime，不要换成 Vitest。前端测试继续使用 [Vitest](https://vitest.dev/) 4。不要在同一测试文件混用两套 API。
- **测试文件统一放在 `<app>/src/__tests__/` 下**，保留与被测代码相同的子目录结构。例：
  - 源 `apps/web/src/lib/api.ts` → 测 `apps/web/src/__tests__/lib/api.test.ts`
  - 源 `apps/bff/src/routes/submit.ts` → 测 `apps/bff/src/__tests__/routes/submit.test.ts`
- 测试文件命名 `*.test.ts(x)`；Vitest 默认配置自动发现，不需要单独注册
- 私有树包不强制使用 `src/` 目录；其测试放在相邻模块的 `__tests__/` 下（例如 `private/apps/bff/billing/__tests__/`）。
- **数据库测试一个文件一个进程**：`apps/bff`、`apps/admin`、`packages/db` 与私有 BFF 的 `pnpm test`
  都走 [`scripts/run-bun-tests-isolated.ts`](./scripts/run-bun-tests-isolated.ts)，逐文件 spawn 一个 bun 进程
  （`--filter` 收窄文件，`BUN_TEST_JOBS` 并发，默认 1；跑完全部文件后汇总失败）。每个 suite 从按迁移指纹
  建好的模板库克隆自己的库。
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

## 私有 overlay 与版本

- 服务端只有一套，能力由运营配置决定；收费与免费只差前端是否带 `private/` overlay 构建。`main` 是唯一长期分支。
- overlay 版本由 `private.lock` 钉住，生产部署与 CI 都按它取；本地用 `scripts/sync-private-overlay.sh` 对齐。
- 公开树与 overlay 只经三个接缝和宿主面互相引用，`pnpm lint` 强制；宿主面改动「先扩后缩」。
- **任何** `pnpm-lock.yaml` 重新生成都要带着 `private/`，否则会删掉三个 private importer，收费构建失败。

改到 `private/`、接缝/宿主面、`private.lock`、lockfile、私有迁移或收费构建时，先读 [私有 overlay 与版本模型](docs/agents/private-overlay.md)。

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

DO NOT send optional commentary
