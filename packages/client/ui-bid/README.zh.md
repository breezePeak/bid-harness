# @deepseek-ai/dsh-client-ui-bid

[English](README.md) | 中文

标书会话浏览器 UI。插件把 `BidStagePanel` 贡献到会话声明的 `conversation.input.dock` 列表，并且只在 Host 解析出的 Session Preset 为 `bid` 且 `bid.runtime` Projection 可用时渲染。五个 MVP 阶段只是 `projection.runtime` 的展示标签；客户端不折叠 Bid 事件、不推进阶段、不推导权限，也不保存本地阶段或状态。

`projection.allowedActions` 控制上传、重试和目录确认控件是否出现，Host 投影的文件限制配置选择器和规则文案。文件选择只在浏览器本地保存 `File` 对象，用于展示和移除；它绝不调用 `session.prompt()`，也不宣称上传或解析成功。Bid Host action API 组合完成前，重试与确认回调保持不可用，因此 Host 允许的控件以禁用态呈现，不绕过 Host 准入。

面板把 `projection.composer.enabled` 及其稳定 reason code 映射到同一 Session 的 `ctx.conversation.blocks`。非 Bid Preset 或 Projection 不可用时会清除 block 并隐藏面板，从而让非 Bid Session 保持原有 composer 与附件路径。发布的 `bid` Agent Preset 经 Host roster 发现并显示为“标书模式”；Preset seat 不包含 Bid 专用分支或 toggle。

## 模型体验

没有直接影响。本包不添加提示词内容，也不发送普通 Session prompt；所有模型可见的 Bid 输入与操作均由 Host 拥有。

#### KV Cache 影响

无。渲染投影和选择本地文件不会改变模型请求前缀。

## 已知局限与延后工作

- **尚未组合 Bid action transport**——重试与目录确认保持禁用，选中的文件在 Host 上传和 action API 可用前只保留在浏览器本地。
- **面板只展示五个 MVP 阶段**——Host 进入后续阶段时面板仍然显示，但不会创建第二套客户端阶段模型。
