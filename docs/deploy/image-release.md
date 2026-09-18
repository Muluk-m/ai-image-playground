# 镜像发布

macmini2 构建，VPS 仅运行预构建镜像；前端由 Pages 托管。禁止在 VPS 安装构建依赖、编译或执行 `docker build`。

## 构建与发布

1. 在 macmini2 独立检出已通过 PR/main CI 的公开提交；paid/all 还需已验证的 `private/` Git 检出。不得占用其他会话目录。
2. 构建到尚不存在的目录：

```sh
export PATH=/opt/homebrew/bin:$PATH
./scripts/build-vps-release.sh all /Users/mac/releases/aip-<release-id>
```

构建输入固定为 Git 提交，不含未提交文件或凭据。使用 `aip-release` builder（4 核、6 GiB、无额外 Swap、阶段并发 1）生成 `linux/amd64` 镜像；保留现有构建锁，并与其他重型任务错峰。

3. 工作站中转完整发布包，再从产物内执行接收脚本：

```sh
scp -r macmini2:/Users/mac/releases/aip-<release-id> /tmp/
scp -r /tmp/aip-<release-id> tx-vps:/home/ubuntu/releases/
ssh tx-vps '/home/ubuntu/releases/aip-<release-id>/scripts/vps-deploy.sh all /home/ubuntu/releases/aip-<release-id>'
```

发布包须包含应用及备份镜像、提交/镜像清单、部署脚本和 SHA-256 校验单。接收脚本持有发布锁，校验文件、镜像 ID、架构、`APP_VERSION`、原生依赖，再执行兼容迁移与启动；保留 VPS 原有运行配置。

## 排空与验收

- 新 worker 暂停接单启动；旧 worker 全部进入 drain 后才启用新 worker，并将 `release-router` 原子切到新 BFF。
- 旧实例仅在 drain 返回 `safeToStop=true` 后停止。默认等待 30 分钟；超时保留执行器并以非零状态退出。核对任务、会话与日志后重跑同一发布入口收尾。
- 首次升级旧协议时，数据库先禁用旧式 claim，待旧任务完成再启用新 worker。旧 BFF 作为 `legacy-origin` 保留；确认旧对话结束后才能人工停止并删除该标记。任务表为空不能证明对话结束。
- 验收内部/付费版 API、版本、容器、备份、登录和业务数据。涉及执行器切换时，验证旧生成任务与对话能完成、新任务进入新实例、刷新可续接、上游调用和结算不重复。
- 仅发布后端不重发 Pages；不更新共享源码目录。

## 回滚与失败处理

```sh
scripts/app-compose.sh rollback <project> <旧镜像>
```

回滚同样启动新实例并排空当前实例。禁止强停排空中的容器或执行 `compose up --force-recreate`、`compose down`。数据库不自动回滚；迁移须兼容新旧版本，破坏性 schema 另行设计恢复方案。

切换前检查失败保留原入口；切换后排空超时，新请求可能已由新版本处理，不能仅凭命令失败判断版本。通过 drain/status 核对；不手工修改 `releases/current`、`route.json`、`retained`、`activated/`。镜像保留数量以脚本策略为准，运行中镜像不得删除。

旧的 `vps-deploy.sh all [git-ref]` 不再适用，必须传发布目录；VPS 旧检出中的入口脚本也须保持更新，防止绕回源码构建。备用数据保留规则见[备用服务手册](backup-backend.md)，灾备见[冷恢复手册](cold-recovery.md)。
