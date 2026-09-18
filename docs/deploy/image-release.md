# macmini2 构建，VPS 接收镜像

生产 VPS 不运行编译、依赖安装或 `docker build`。前端仍由 Pages 发布；后端完整镜像在 macmini2 构建。

## 发布步骤

1. 使用已通过 PR/main CI 的公开提交及已验证私有提交，在 macmini2 独立检出目录准备源码。不要在另一个会话的工作目录切分支。paid/all 要有 `private/` Git 检出。
2. 在 macmini2 执行（输出目录必须不存在）：

```sh
export PATH=/opt/homebrew/bin:$PATH
./scripts/build-vps-release.sh all /Users/mac/releases/aip-<release-id>
```

脚本通过 `git archive HEAD` 固定公开和私有输入，忽略未提交文件与凭据。使用独立 `aip-release` BuildKit builder，最多 4 核、6 GiB 内存、无额外 Swap，Dockerfile 阶段并发数为 1；镜像明确构建为 `linux/amd64`。依赖安装和前端编译使用构建机原生 ARM CPU，同时安装目标 x64 的原生依赖；VPS 在迁移前实际执行 Bun + sharp 图片编解码检查。所有本项目检出共用 `~/.config/ai-image-playground/image-build.lock`，第二个构建立即拒绝。仍须按全局规则与其他项目的重型任务错峰。

3. 从工作站中转产物，避免为 macmini2 新增 VPS SSH 凭据：

```sh
scp -r macmini2:/Users/mac/releases/aip-<release-id> /tmp/
scp -r /tmp/aip-<release-id> tx-vps:/home/ubuntu/releases/
ssh tx-vps '/home/ubuntu/releases/aip-<release-id>/scripts/vps-deploy.sh all /home/ubuntu/releases/aip-<release-id>'
```

产物含应用及 PG 备份 sidecar 的镜像归档、镜像 ID/提交清单、Compose 与必要部署脚本及 SHA-256 校验单。完整传输后才运行接收脚本；中断传输或缺少校验单不得继续。

Compose 不含任何 `build` 配置。VPS 接收过程共用原 `deploy.lock`，先校验文件，再 `docker load`，核对所有镜像 ID、CPU 架构及 `APP_VERSION`，全部通过后才依次执行 dependency-check、向后兼容的 schema 迁移与服务启动。原环境变量、数据库和对象存储保持各自归属，不从构建机覆盖。

后端切换由稳定的 `release-router` 和不可变的 BFF/worker 容器完成：新 worker 先以暂停接单启动；旧 worker 全部进入 drain 后，新 worker 才恢复接单；路由随后原子切到新 BFF。旧 BFF 和 worker 只有在 `/internal/deployment/drain` 返回 `safeToStop=true` 后才停止。默认最长等待 30 分钟；超时会让发布以非零状态结束并保留旧容器，绝不会取消任务或强停容器。排空未完成时先查任务/对话和容器日志，完成后重新运行同一发布入口清理保留实例。

第一次从旧 Compose 版本升级时，旧 worker 没有租约协议。脚本先在数据库关闭旧式 claim，等它手上的任务完成，再启用新 worker。旧 BFF 没有可证明的对话空闲信号，因此会作为 `legacy-origin` 保留，供升级前已开始的会话重连；确认旧会话全部结束后才能人工停止它并删除 `releases/legacy-origin`。不要用“任务表为空”推断内部版智能体会话已经结束。

4. 检查内部/付费两套容器健康、真实 API、版本与浏览器行为。发布验收必须覆盖：切换前同时启动图片生成和智能体对话；切换后旧任务继续完成、新任务进入新实例；刷新后能续接；上游调用和结算各只发生一次。只需要后端发布时，不重发 Pages。新镜像只在自己的发布目录执行，不更新共享源码目录。

## 回滚与数据

保留最近 5 代镜像及当前仍在运行的镜像。回滚也是一次受控发布：`scripts/app-compose.sh rollback <project> <旧镜像>` 会启动旧镜像的新实例、排空当前实例再切路由。不要对正在排空的容器执行 `docker stop`、`compose up --force-recreate` 或 `compose down`。数据库迁移不自动倒退，发布迁移必须先保持新旧二进制同时兼容；破坏性 schema 另行设计恢复方案。

新实例健康检查、迁移、路由检查任一步失败，都保留原入口和执行器。若路由已经切换但旧执行器仍忙，用户新请求已由新版本处理，发布命令仍会以失败退出以提醒继续观察排空。`releases/current`、`route.json`、`retained` 和 `activated/` 是发布状态，不要手工改写；先用容器的 drain/status 端点核对事实。

不要删除 macmini2 备用数据库及 MinIO。备用期间新增数据与 VPS 独立，切回不代表已合并；备用运行手册见 [backup-backend.md](backup-backend.md)。

## 防止旧入口误用

旧的 `vps-deploy.sh all [git-ref]` 用法已失效：现在必须提供预构建产物目录，并从产物内运行。`app-compose.sh build/build-private` 在 Linux 拒绝执行。首次迁移时须把 VPS 旧检出中的这两个脚本替换为同版接收入口，防止其他会话继续运行旧版本；不得只更新文档。

2026-09-18 的事故由两次生产构建重叠触发。仅有发布锁仍不足以隔离单次构建的资源峰值，所以构建移出 VPS 是长期约束。
