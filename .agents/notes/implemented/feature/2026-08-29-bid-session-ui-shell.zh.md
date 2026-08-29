# Agent Note: Projection-owned Bid Session UI

Status: implemented

[English](2026-08-29-bid-session-ui-shell.md) | 中文

## Problem

标书会话需要在现有 Web conversation 中展示阶段面板、文件选择和用户操作。如果浏览器根据 Session 事件重建阶段或权限，它就会成为第二个 workflow engine，其状态可能与 Host 准入发生偏差。独立的 Bid toggle、附件管线或聊天 surface 也会拆分 Session identity，并绕过现有插件组合。

## Decision

browser-safe 导出 `@deepseek-ai/dsh-bid/control-plane` 拥有 `BidClientProjection`、`BidClientAction` 和 composer capability 类型，而且不导入 workspace 解析代码。Host 通过通用 Session Projection channel 发布完整 `bid.runtime` Projection。Host 解析出的 Session Preset 才是 Bid 身份；Projection Registry 是进程级能力，因此不能仅凭 Projection 是否存在识别 Session。

`@deepseek-ai/dsh-client-ui-bid` 向 `conversation.input.dock` 贡献一个 `BidStagePanel` entry。组件要求解析后的 Preset 为 `bid`，读取 `useProjection(BID_RUNTIME_PROJECTION_KEY)`，把前五个 `BidStage` 值映射为本地化标签，并且只显示 Host 列出的 action。它不折叠事件、不推断已完成阶段、不根据 runtime status 推导权限，也不乐观修改阶段与状态。

面板只把 `projection.composer` 映射到现有的 per-session composer block registry。浏览器选中的 `File` 对象、请求 pending 与错误反馈都是组件本地 UI state。文件选择绝不进入 `session.prompt()`；Host 上传与 action 调用保持为显式注入的回调，因此回调缺失时不会退回普通聊天准入。

发布的 `bid` Agent Preset 提供 roster identity 与“标书模式”展示元数据。`AgentPresetSeat` 保持通用，只列出 Host roster，不增加 Bid 专用 toggle。

## Alternatives considered

**在浏览器折叠 Bid 事件。** 这会复制 Host workflow policy，并使不同客户端版本对当前阶段和允许操作产生分歧。

**在 ConversationRoot、InputBar 或 AgentPresetSeat 中加入 Bid 分支。** 这些包会开始了解可选领域，后续每个 workflow UI 都会继续扩大同一张中心分支表。

**复用普通消息附件。** 现有附件路径会把图片序列化到 `session.prompt()`；Bid 文档是由独立 Host action 准入的 workspace input。

**维护客户端 `isBidMode` toggle。** 本地 toggle 可能比所选 Session 存活更久或识别错误，而且无法证明 Host 已组合 Bid capability。

## Consequences

即使 Host Registry 包含 `bid.runtime`，非 Bid Session 仍通过原有 conversation 渲染和提交，不增加 Bid block 或附件变更。Bid Session 同时需要解析后的 Preset Identity 和 Projection；不可用的 Host action 保持禁用而不模拟成功。最终的上传、重试、确认和 Bid message 准入仍需要 Host action API 提供注入回调。
