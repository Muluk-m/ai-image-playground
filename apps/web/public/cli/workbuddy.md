# 在 WorkBuddy 中接入幕芽

默认完成 CLI 安装、技能导入和账号连接；不生成图片。

如果用户只要求安装或验收技能，直接执行第 2 节：保留已有 CLI、服务地址和账号，不运行 `auth status`、`auth login` 或 `capabilities`，不访问凭据存储。此时完成条件仅为技能已安装、启用，并且新任务中输入 `/muv` 能找到幕芽。

## 1. 安装 CLI

先运行 `muvloom version`；未安装时按 [CLI 安装指南](setup.md) 第 1 节安装。无论 CLI 是否已安装，都先按该指南第 2 节，根据当前 WorkBuddy 指南页面的域名为本次会话选择服务，再检查此服务的登录状态；只有服务一致时才复用已有连接。然后回到本文继续。

## 2. 在对话中安装幕芽技能

由你（WorkBuddy）完成安装，不要让用户去技能管理页上传 ZIP。先加载客户端内置的技能创建能力（可用时使用 `skill-creator`），下载本页同源的 [幕芽技能包](muvloom-workbuddy.zip)。这是幕芽提供的本地技能包，不需要去技能市场搜索同名技能。

将包内的 `muvloom/` 目录安装到当前用户的 `~/.workbuddy/skills/muvloom/`（Windows 为用户主目录下的 `.workbuddy/skills/muvloom/`）。目标文件为 `muvloom/SKILL.md` 及其 `references/`，不要多套一层同名目录。下载和解压使用当前宿主可用的文件工具或命令：

- 解压前确认只有 `muvloom/` 根目录，拒绝绝对路径、`..` 路径和符号链接；先阅读 `SKILL.md` 和引用的安装说明，再安装。不要执行包内命令来完成安装。
- 已有正确安装的幕芽技能时复用；若目标目录有不同内容，先核对版本和用户改动，不删除其他技能或覆盖无法确认来源的文件。
- 遇到必要的目录写入或技能安全确认时，使用宿主正常的权限提示；不要关闭安全检查、改全局权限或把手动上传当作默认下一步。
- 安装后读回 `SKILL.md`，确认 `name: muvloom`、展示名「幕芽 Muvloom」以及引用文件完整。使用宿主提供的技能重新加载能力（如有），再确认技能已被发现并启用；不能把文件落盘或“新开对话即可加载”当作发现成功。若新任务输入 `/muv` 仍无候选，保留已安装文件，请用户完整退出并重新打开 WorkBuddy，再输入 `/muv` 并选择 `muvloom` 验证。本机 WorkBuddy 5.9.3 已实测通过这一恢复步骤；其他版本仍以实际候选和选择结果为准，不重复安装。

CLI 0.1.3 不支持 `muvloom skill install --host workbuddy`，不要发明这个命令，也不要修改客户端内部数据库或未知配置。只有用户选择「我自己来」时才提供「添加技能 → 上传技能」的手动路径。

## 3. 按技能完成账号连接

按包内 `references/workbuddy.md` 执行账号连接与本地权限错误处理。关键顺序：

1. 前台运行 `muvloom auth status`，已经 `ready` 就保留连接。
2. 未登录时前台执行 `muvloom auth login --no-wait`，打开授权链接，提示用户确认，然后立即结束本回合。
3. 用户确认后先再次检查状态；仍未就绪时，前台执行 `muvloom auth login --timeout 15` 收尾。
4. 遇到本地写入失败时，暂停并说明必要权限；不要将其说成授权码过期，也不要循环发码。

认证不使用后台任务，不引导用户开启全局完全访问。凭据仍由 CLI 安全存储管理，Agent 不手动操作凭据文件。

## 4. 验收

技能安装必须验证已启用，且新任务的 `/muv` 候选中能找到幕芽；只存在技能文件不算验收通过。用户还要求连接账号时，再确认 `muvloom auth status` 返回 `ready`、`muvloom capabilities` 成功。任何一项未完成，就说明当前状态与剩余操作，不能仅凭浏览器显示已授权就宣告成功。

参考：[WorkBuddy 官方技能导入说明](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Skills-Market)、[官方权限说明](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Permission-Modes)。
