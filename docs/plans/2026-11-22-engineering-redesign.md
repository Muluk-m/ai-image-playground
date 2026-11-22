# 工程化重设计提案：交付链路与前端状态层

日期：2026-11-22

状态：提案，待 Nain 逐项裁决。服务端模块化（限界上下文、`schema.ts` 拆分、`private/` 并入）已由
[ADR 0034](../adr/0034-modular-monolith-and-single-repo.md)（PR #1950）覆盖，本文不重复。

## 一、依据

| 观察 | 数据（采集于 2026-11-22） |
| --- | --- |
| 合并节奏 | 11-06 至 11-22 共 200 个 PR，合并 191 个；创建到合并中位 0.7 小时，P90 10.4 小时；30 个超过 1000 行 |
| 绕过 PR | 同期 `main` 上 23 个非机器人提交没有 PR 号（含 `feat(auth)` 双 token 刷新）；`main` 无分支保护，唯一 ruleset 处于 disabled |
| CI 失败 | 11-19 至 11-22 `Web checks` 183 次，失败 28、取消 26；最近 25 次失败中约 10 次是 typecheck；`main` 与 3 个 PR 被同一个 5 秒超时用例打红（CI 上实测 3.6–3.9 秒） |
| CI 速度 | 各 job 并行，墙钟约 3 分钟，最慢的是两个 build（约 2.5 分钟）。速度不是瓶颈，信号质量才是 |
| 测试环境 | 单一共享 `test` 分支；Deploy test 24 次中失败 2、取消 5，P90 18.8 分钟 |
| 生产发布 | 每日 3 个窗口，16/16 成功，中位 8.9 分钟；合并到上线最长约 13 小时 |
| 前端热点 | 两个月改动次数 × 行数：`features/agent/store.ts`（84 次 × 2898 行）、`NodeCanvas.tsx`（58 × 3172）、`store.ts`（56 × 3276，被 143 个文件引用）、`AgentComposer.tsx`（84 × 1662）、`InputBar.tsx`（68 × 1889） |
| 规则形态 | 约 2200 行 Agent / 发布文档，大量「不要做 X」只存在于文档，靠每个会话读完后自觉遵守 |

## 二、本轮已落地（PR：ci/delivery-guardrails）

- `main` ruleset 启用：必须经 PR、只允许 squash、14 个 `Web checks` job 为必需检查；管理员只能在 PR 内绕过，不能直推。
  overlay-bump 改用唯一豁免的写 deploy key `MAIN_PUSH_SSH_KEY` 推送 lock。
- 仓库开启 `delete_branch_on_merge` 与 `allow_auto_merge`：Nain 确认后可直接点 auto-merge，CI 绿了自动合并。
- `scripts/check-migrations.mjs` 进 `pnpm lint`、pre-push 与 CI：迁移相对 `main` 只追加，新迁移 `when` 必须晚于 `main` 最新一条。
- `pnpm install` 自动启用 pre-push（受限机器默认只跑 lint）。
- 隔离 Bun 测试的单用例超时从 5 秒提到 15 秒（`BUN_TEST_TIMEOUT`）。

## 三、需要重新设计的地方

### A. 合并：把仓库迁到组织，换用 merge queue

现状：12 个 PR/天，PR 之间互不感知，合并后 `main` 才发现组合问题（见 11-20 `main` 失败）。
带迁移的 PR 还要人工按时间戳排队。

参考：GitHub merge queue 把待合并 PR 依次叠在最新 `main` 上重跑必需检查，通过才入主干。它只对
**组织拥有的公开仓库**开放，个人仓库不可用。

提案：新建一个免费组织并把仓库转过去（重定向自动保留，Pages / Actions secrets / deploy key 需核对），
ruleset 增加 merge queue 规则。之后「带迁移的 PR 按时间戳先后合并」这条人工规则可以删除：
`check-migrations` 在队列里对叠好的提交运行，冲突的那一个会被踢出。

代价：一次性迁移；`Muluk-m/...` 硬编码处（workflow、文档、CLI 下载地址）需要替换。

### B. 测试环境：从共享 `test` 分支改为每个 PR 一个预览环境

现状：所有工作分支轮流合进同一个 `test`，`test` 落后 `main` 就失败；两个会话同时验收会互相覆盖；
「测试环境验收截图」这类证据也说不清对应哪个提交。

参考：Plane 公开写过用每 PR 临时预览替代共享 staging；Fly.io 的做法是一个常驻预览集群加每 PR
一个数据库，让一个分支的坏迁移不影响其他 PR；PullPreview / Preevy 是开源的 Compose 预览实现。

提案（分两步）：

1. 前端：Cloudflare Pages 原生支持分支预览别名，`pages-release.sh` 增加 `preview <PR号>` 目标，
   固定连 `test-api`。仅前端改动的 PR 立刻摆脱共享分支。
2. 后端：测试 VPS 上按 `compose project = pr-<号>` 起 BFF + worker，数据库从现有「按迁移指纹建好的
   模板库」克隆（测试基础设施已有这套能力），PR 关闭时销毁。容量按单机 PostgreSQL 多库估算，
   设并发上限（例如 4 个），超出排队。

`test` 分支保留为「下一个生产窗口的预发」，只由 workflow 从 `main` 快进，不再接受工作分支。

### C. 发布：从固定窗口过渡到「健康门控 + 自动回滚」的持续发布

现状：窗口限制了风险，但最长 13 小时延迟，紧急修复要走手动 `workflow_dispatch`。生产 16/16 成功，
说明发布本身已经可靠，限制吞吐的是缺少自动回滚。

参考：Kamal 2 / kamal-proxy 的做法是新实例健康检查通过才切流，旧实例排空后下线，失败即中止；
GitLab 的迁移规范要求破坏性变更拆成 expand → migrate → contract，并分到不同发布中。

提案：

1. 先补自动回滚：`rollout` 后跑 `agent-smoke` 与关键 API 只读探针，失败自动切回上一 digest（已有回滚手册，改为脚本）。
2. 迁移加静态检查：对新增 `.sql` 跑 squawk（PostgreSQL 迁移 linter，有官方 GitHub Action），
   拦截锁表操作与不兼容旧版本的改动，把「迁移须兼容新旧版本」从文档变成检查。
3. 两者稳定运行两周后，窗口改为「`main` 有新提交且检查通过即发」，保留窗口作为可选的冻结开关。

不建议直接引入 Kamal 替换现有脚本：现有 rollout 已经处理了执行器排空和私有 overlay，换工具的
收益主要是少维护几百行 shell，迁移风险大于收益。借鉴它的健康切流语义即可。

### D. 规则即代码：文档里的约束迁到 PR 机器人

现状：PR 模板的风险等级、关键流程证据、成本说明、界面截图都靠作者自觉填写；`cost-impact.yml`
是唯一自动化的一项。

参考：Danger JS 在 CI 里读取 diff 与 PR 元数据，按 `dangerfile.ts` 规则发评论或判失败，
是大量开源项目的标准做法；Grafana 一类项目用「棘轮基线」处理存量问题（本仓库
`check-arch-boundaries` 已采用同样做法）。

提案（已落地：`dangerfile.js` + `scripts/pr-rules.mjs`，workflow `PR rules`，替换 `cost-impact.yml`）：

- 改动命中 `apps/web` / `apps/admin` 界面文件但 PR 描述没有 test.muvloom.online 截图 → 失败；
- 命中注册登录、计费、生成路径但「关键流程证据」未勾选 → 失败；
- 命中成本清单但「成本与影响」为「不涉及」→ 失败并打标签；
- 超过 1000 行 → 警告并建议拆分；
- 带迁移 → 自动附上 squawk 结果与回滚 SQL 是否存在（`drizzle/rollback/*.down.sql`）。

每迁一条规则，就从 AGENTS.md 删掉对应段落，目标是文档只写「为什么」和流程，约束由检查承担。

不稳定测试按 GitLab 的隔离流程处理：用 `test.skip` 加注释 `quarantine: #issue 到期日`，
由脚本检查到期日，过期即 lint 失败，避免隔离变成永久跳过。

### E. 前端状态层：按改动热度拆分三个巨型模块

**根 `store.ts`（143 个文件引用）**：一个 zustand store 混着设置、生图输入区（prompt、参考图、
蒙版、参数）、任务与筛选、界面外壳（侧栏、弹窗、toast、引导标记）、画布交接，外加约 109 个
模块级函数。提案按领域拆成独立 store：`settingsStore`、`composerStore`、`libraryStore`、
`uiStore`（不持久化）与 `canvasHandoff`，原 `useStore` 保留为兼容 facade，按引用逐步迁移，
用 `check-arch-boundaries` 同款棘轮锁住 facade 引用数只减不增。

**`features/agent/store.ts`（两个月 84 次改动）**：流式事件处理、乐观消息、重试、历史缓存、
标题改写都在一个 store 里。参考 Vercel AI SDK 把对话建模为 `UIMessage.parts`（文本、工具调用、
工具结果、自定义数据各为一种 part，带 streaming / approval 等状态），并把「传输」与「状态」分开。
提案：

1. 抽出纯函数 `reduceAgentEvent(state, event)`，SSE / 重放 / 本地乐观更新都只产生事件；
2. 轮次生命周期用仓库已有的 `defineMachine` 建表（`docs/state-machines/` 已有先例）；
3. store 只做「事件 → reducer → 订阅」，传输层（`agentClient.ts`）不直接改 store。

这样大部分 bug 能用 reducer 单测复现，不再需要 jsdom 加 mock 流。

**`NodeCanvas.tsx`（3172 行组件）**：参考 tldraw 的 `Editor` 加 managers 结构，把命令式逻辑
（选择、拖拽、对齐、视口、云端同步桥）移进与 React 无关的 `CanvasController` 及其 managers，组件
只负责渲染与事件转发。先迁移改动最多的两个关注点，不一次性重写。

## 四、建议顺序与待裁决事项

| 顺序 | 事项 | 需要 Nain 决定 |
| --- | --- | --- |
| 1 | 合并本 PR（ruleset 已生效，overlay-bump 在本 PR 合并前推送会失败并自动重试） | 是否合并 |
| 2 | D：Danger 规则替换 `cost-impact.yml`，同步删减 AGENTS.md | 规则清单是否认可 |
| 3 | E：agent reducer 抽离（收益最大、风险可控） | 是否先做 agent 还是根 store |
| 4 | C1 + C2：自动回滚与 squawk | — |
| 5 | B1：前端 PR 预览 | — |
| 6 | A：迁到组织启用 merge queue | 是否接受仓库转移 |
| 7 | B2、C3：后端 PR 预览、取消固定窗口 | 是否取消窗口 |

## 参考

- [GitHub：使用 merge queue 合并 PR](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/merging-a-pull-request-with-a-merge-queue)
- [Plane：用临时预览替代共享 staging](https://plane.so/blog/how-we-replaced-shared-staging-with-ephemeral-deployment-preview)
- [Fly.io：面向编码 Agent 的每 PR 预览环境](https://fly.io/learn/per-pr-preview-environments-for-coding-agents/)
- [Preevy](https://github.com/livecycle/preevy)
- [kamal-proxy](https://github.com/basecamp/kamal-proxy)
- [GitLab：多版本兼容（expand / migrate / contract）](https://docs.gitlab.com/development/multi_version_compatibility)
- [GitLab：post-deployment migrations](https://docs.gitlab.com/development/database/post_deployment_migrations)
- [squawk](https://github.com/sbdchd/squawk)
- [Danger JS](https://danger.systems/js/)
- [GitLab：测试隔离流程](https://handbook.gitlab.com/handbook/engineering/testing/quarantine-process/)
- [Vercel AI SDK：stream protocol](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol)
- [tldraw：Editor](https://tldraw.dev/docs/editor) 与 [Store](https://tldraw.dev/sdk-features/store)
