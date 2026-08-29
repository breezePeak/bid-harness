# Agent Note: 将 Bid 工作流准入保留在 Host

Status: implemented

[English](2026-08-29-bid-host-runtime-admission.md) | 中文

## Problem

Bid 浏览器投影曾使用两个键，并通过浏览器入口导出 Host 运行时函数；同时，系统还暴露了没有生产路由的消息、重试和确认操作。因此，Bid Session 可以进入通用提示词路径，在 Host 拒绝不受支持的工作流输入前写入用户消息。

## Decision

`@deepseek-ai/dsh-bid/control-plane` 只导出浏览器安全的常量和类型，`bid.runtime` 是唯一的 Bid 投影键。Bid Host 插件使用已配置的文件限制注册该 Projection，并在 `createUserMessage`、follow-up 或 steer 执行前，根据 Session 解析出的 `bid` Preset 拒绝通用 Prompt 准入。ApiProxy 从根 Context 分发 Prompt 准入事件，使同一 Host composition 中的同级插件参与统一决策。Projection 只暴露已有 Host route 的操作：`file_intake` 为 pending 或 failed 时允许文件上传，输入框始终用规范原因禁用。Reducer 只接受当前运行阶段完成；目录确认只有在要求确认并收到 `confirmed: true` 后才会进入运行状态。Projection state version 3 包含持久化失败原因，并使旧转换规则生成的缓存失效。

## Alternatives considered

**保留通用提示词投递并由 Bid Agent 拒绝。** 不采用，因为工作流权限判断前，用户消息已经持久化并对模型可见。

**暴露仅由本地 UI 回调支持的操作。** 不采用，因为投影操作描述的是 Host 能力；没有生产路由的操作会让浏览器获得虚假的权限信息。

**为兼容性注册第二个客户端别名。** 不采用，因为项目尚无已发布的兼容性义务，单一键可避免投影分叉。

## Consequences

Bid Session 不能使用通用输入框，而是通过专用 Bid Remote 上传接入文件。Standard Session 仍保留通用提示词投递。浏览器代码不导入依赖 Node 的 Bid 运行时模块，回放也无法通过无关或乱序阶段事件推进状态。
