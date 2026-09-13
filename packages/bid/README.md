# bid/ — 标书写作域

标书（投标文件）写作产品域的共享基础：标书 Workspace 的文档接入与解析、控制面契约与 `bid.*` 会话事件、Host 端阶段编排运行时，以及 Word 模板与导出原语。总体架构见 [docs/bid-harness-architecture](../../docs/bid-harness-architecture/bid-overall-architecture.zh.md)。

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`bid/`](bid/README.md) | 标书 Workspace 文档接入与解析（`BidWorkspace`、`extractDocument()`）、七个 `bid.*` 会话事件与控制面契约、`BidHostRuntime` 阶段编排、Word 模板与 DOCX 导出 | `ctx.bid` |
