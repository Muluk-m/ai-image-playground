# 在 WorkBuddy 中接入幕芽

完成 CLI 安装、技能导入和账号连接；仅安装请求不生成图片。

## 1. 安装 CLI

先运行 `muvloom version`。未安装时，按 [CLI 安装指南](setup.md) 的第 1、2 节安装并选择与本页域名对应的服务，然后回到本文继续。已安装时保留现有配置。

## 2. 导入幕芽技能

下载本页同源的 [幕芽 WorkBuddy 技能包](muvloom-workbuddy.zip)。包内根目录为 `muvloom/`，包含 `SKILL.md` 和参考资料。

通过 WorkBuddy「专家·技能·连接器 → 技能 → 添加技能 → 上传技能」导入 ZIP。已有「幕芽 Muvloom」且启用时，无需重复导入。需要用户点击上传时，告知下载位置和这一步操作，结束当前回合等待用户完成。

导入后，在「已安装」列表确认「幕芽 Muvloom」已启用，或在对话输入框输入 `/mu` 看到 `muvloom` 技能。只有自然语言对话能调用 CLI、但技能列表不可见，不算技能安装完成。

CLI 0.1.3 不支持 `muvloom skill install --host workbuddy`。本流程使用 WorkBuddy 官方的技能包上传机制，不手动编辑其内部数据库或未知配置。

## 3. 按技能完成账号连接

按包内 `references/workbuddy.md` 执行账号连接与本地权限错误处理。关键顺序：

1. 前台运行 `muvloom auth status`，已经 `ready` 就保留连接。
2. 未登录时前台执行 `muvloom auth login --no-wait`，打开授权链接，提示用户确认，然后立即结束本回合。
3. 用户确认后先再次检查状态；仍未就绪时，前台执行 `muvloom auth login --timeout 15` 收尾。
4. 遇到本地写入失败时，暂停并说明必要权限；不要将其说成授权码过期，也不要循环发码。

认证不使用后台任务，不引导用户开启全局完全访问。凭据仍由 CLI 安全存储管理，Agent 不手动操作凭据文件。

## 4. 验收

确认技能可见且启用、`muvloom auth status` 返回 `ready`、`muvloom capabilities` 成功后，报告安装完成。任何一项未完成，就说明当前状态与剩余操作，不能仅凭浏览器显示已授权就宣告成功。

参考：[WorkBuddy 官方技能导入说明](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Skills-Market)、[官方权限说明](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Permission-Modes)。
