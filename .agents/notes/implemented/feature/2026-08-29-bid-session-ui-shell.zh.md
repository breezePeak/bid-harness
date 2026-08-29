# Agent Note: Projection-owned Bid Session UI

Status: implemented

[English](2026-08-29-bid-session-ui-shell.md) | 中文

## Problem

标书会话需要在现有 Web conversation 中展示阶段面板、文件选择和用户操作。如果浏览器根据 Session 事件重建阶段或权限，它就会成为第二个 workflow engine，其状态可能与 Host 准入发生偏差。独立的 Bid toggle、附件管线或聊天 surface 也会拆分 Session identity，并绕过现有插件组合。

## Decision

browser-safe 导出 `@deepseek-ai/dsh-bid/control-plane` 拥有 `BidClientProjection`、`BidClientAction` 和 composer capability 类型，而且不导入 workspace 解析代码。Host 通过通用 Session Projection channel 发布完整 `bid.runtime` Projection。Host 解析出的 Session Preset 才是 Bid 身份；Projection Registry 是进程级能力，因此不能仅凭 Projection 是否存在识别 Session。

`@deepseek-ai/dsh-client-ui-bid` 向 `conversation.input.dock` 贡献一个 `BidStagePanel` entry。组件要求解析后的 Preset 为 `bid`，读取 `useProjection(BID_RUNTIME_PROJECTION_KEY)`，并把当前阶段和状态渲染为紧凑的 DSH Composer Dock 状态行。它复用共享状态标记、按钮、Composer 布局和字体；执行进度继续由 DSH Transcript、Todo 和工具视图展示。面板只显示 Host 列出的 action，不折叠事件、不推断已完成阶段、不根据 runtime status 推导权限，也不乐观修改阶段与状态。

面板只把 `projection.composer` 映射到现有的 per-session composer block registry。浏览器选中的 `File` 对象、请求 pending 与错误反馈都是组件本地 UI state。文件选择绝不进入 `session.prompt()`；生成的 `bid/uploadFiles` Remote 是显式注入的回调，因此回调缺失时不会退回普通聊天准入。阶段、状态、允许操作与持久化失败原因仍只来自 Host Projection。面板不重复固定 Bid 阶段序列，避免在 DSH 自有执行视图旁形成第二套任务进度模型。

发布的 `bid` Agent Preset 提供 roster identity 与“标书模式”展示元数据。`AgentPresetSeat` 保持通用，只列出 Host roster，不增加 Bid 专用 toggle。

## Alternatives considered

**在浏览器折叠 Bid 事件。** 这会复制 Host workflow policy，并使不同客户端版本对当前阶段和允许操作产生分歧。

**在 ConversationRoot、InputBar 或 AgentPresetSeat 中加入 Bid 分支。** 这些包会开始了解可选领域，后续每个 workflow UI 都会继续扩大同一张中心分支表。

**把完整 Bid 阶段序列渲染为专用进度卡。** 这会在 DSH Todo 与工具视图旁重复任务进度，并让可选业务域偏离共享 Composer Stack 的视觉语言。

**复用普通消息附件。** 现有附件路径会把图片序列化到 `session.prompt()`；Bid 文档是由独立 Host action 准入的 workspace input。

**维护客户端 `isBidMode` toggle。** 本地 toggle 可能比所选 Session 存活更久或识别错误，而且无法证明 Host 已组合 Bid capability。

## Consequences

即使 Host Registry 包含 `bid.runtime`，非 Bid Session 仍通过原有 conversation 渲染和提交，不增加 Bid block 或附件变更。Bid Session 同时需要解析后的 Preset Identity 和 Projection；不可用的 Host action 保持禁用而不模拟成功。Bid 状态行与其他 Composer Dock 保持一致，但不会同时展示完整业务阶段序列。文件上传使用生成的 Host Remote；重试、确认和后续 Bid message 准入仍需要专用 Host action。
