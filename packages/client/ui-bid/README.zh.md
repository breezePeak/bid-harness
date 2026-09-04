# @deepseek-ai/dsh-client-ui-bid

[English](README.md) | 中文

标书会话浏览器 UI。插件把 `BidStagePanel` 贡献到会话声明的 `conversation.input.dock` 列表，并且只在 Host 解析出的 Session Preset 为 `bid` 且 `bid.runtime` Projection 可用时渲染。紧凑状态行复用 DSH Composer 的布局、状态标记、字体和按钮，只显示当前 `projection.runtime` 阶段与状态；执行进度继续由 DSH Transcript、Todo 和工具视图展示。客户端不折叠 Bid 事件、不推进阶段、不推导权限，也不保存本地阶段或状态。

`projection.allowedActions` 控制上传、重试、目录决策和 Word 导出控件是否可用，Host 投影的文件限制配置选择器和规则文案。文件选择会把浏览器 `File` 对象保留在本地，直到用户明确上传整个批次。上传控件为生成的 `bid/uploadFiles` Remote 编码这些字节，重试控件只调用生成的 `bid/retryStage` Remote；两者都不调用 `session.prompt()`，只有刷新的 Host Projection 才会报告阶段成功或失败。目录确认提供“使用该目录”和“修改目录”两行：前者提交当前目录编辑，后者要求非空修改意见并调用 `bid/regenerateOutline`，由 Host 重新执行 S4 后返回目录确认。

“审核项”标签在 S2–S4 等待确认时显示，并从 S5 开始常驻。S5 运行中实时展示正文和 Reviewer 状态；S5 完成后仍保留全部章节状态，并在工作台顶部提供可重复执行的“导出 Word”。旧项目保存为 `docx_export/completed` 时也按完成的 S5 展示，不切换到单独的导出页面。

面板把 `projection.composer.enabled` 及其稳定 reason code 映射到同一 Session 的 `ctx.conversation.blocks`。S5 审核项使用三栏工作台展示目录、正文、资料和 Reviewer 状态，通过专用 Remote 读取审核报告与章节；完成后的 Word 导出通过 `bid/exportDocx` 生成独立文件，不改变 S5 Projection。非 Bid Preset 或 Projection 不可用时会清除 block 并隐藏面板，从而让非 Bid Session 保持原有 composer 与附件路径。发布的 `bid` Agent Preset 经 Host roster 发现并显示为“标书模式”；Preset seat 不包含 Bid 专用分支或 toggle。

S2–S5 重置完成后，面板显示 `waiting_start` 和“开始本阶段”按钮，并保持 Composer 禁用。按钮调用 `bid/startStage`；成功进入执行状态后才恢复该阶段的常规进度展示，避免重置操作在用户确认前自动消耗模型调用。

S4 运行时，状态行分别显示 Host 返回的初始任务数与补充任务数。初始数量等于初步确认目录中的可写叶子数；目录深化和最终用户编辑产生的补映射计入补充数量，任务名称使用真实章节标题路径。

## 模型体验

没有直接影响。本包不添加提示词内容，也不发送普通 Session prompt；文件持久化、工作流事件与所有模型可见的 Bid 输入均由 Host 拥有。

#### KV Cache 影响

无。渲染投影和选择本地文件不会改变模型请求前缀。

## 已知局限与延后工作

- **文件接入使用单次 JSON/base64 请求**——浏览器与 Host 内存会在配置限制内持有编码后的整个批次。
- **面板只显示业务状态**——它不重复 DSH 的任务列表和工具调用树。

文件接入为每个本地选择文件显示名称背景进度，并把 Host 返回的解析错误显示在对应名称下方。Host 的文件级失败不会清除同批次的成功文件；当前传输协议仍是一次 JSON/base64 批次请求。
