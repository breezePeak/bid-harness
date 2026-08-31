# Agent Note: 会话 View 可用性与嵌入表面回退

Status: implemented

## Problem

会话 View 的注册是全局的，但功能 View 的可用性可能按会话阶段变化。技术标审核工作台在非 S7 阶段没有嵌入 Chat 和 Composer 的宿主；若仍选择该 View，基础 Portal 会把常驻对话或输入栏渲染为 null，运行中的会话因此停止显示更新。

## Decision

`ui-conversation` 为每个 Session 保存已注册 View 的可用性，并将不可用 View 从标签和激活解析中排除。功能插件通过 scope-addressed `conversation.setViewAvailable()` 提供自己的阶段判断；不可用的持久化 View 自动写回稳定的 `chat` 选择。

只有显式声明嵌入 Chat 的 View 才会迁移常驻 Chat；其 Portal 宿主暂缺时继续在会话区域渲染。Composer 也只有在嵌入宿主实际存在时才通过 Portal 迁移。`ui-bid` 仅在 S2、S5 或 S7 处于 `waiting_user` 时公开“审核项” View，并在每次进入待确认状态时自动选择一次。S2 和 S5 的详情通过专用 Portal 从常驻状态面板移入审核项；主对话保留对应的直接确认操作。

## Alternatives considered

**由审核工作台在非 S7 显示占位页。** 否决：标签仍可在错误阶段选择，且不能保护 Chat 与 Composer 的基础生命周期。

**在 ui-conversation 中判断 Bid 阶段。** 否决：通用会话包不拥有 Bid Projection，也无法让其他功能 View 使用同一可用性机制。

## Consequences

功能插件必须在其可用性变化时更新会话级 View 状态；未声明限制的 View 保持默认可用。只有声明嵌入 Chat 的功能 View 会在 Portal 宿主短暂卸载时保留 Chat 常驻树；轨迹等独立 View 不会追加 Chat。Composer 在嵌入宿主短暂卸载时同样保留单一常驻树。审核详情使用独立的 `review` Portal，不影响 Chat 或 Composer 的归属。

## Testing

`ui-bid` 覆盖审核 View 的阶段可用性和进入 S7 的一次性自动选择。`ui-conversation` 覆盖空 Chat Portal Host、空 Composer Host，以及按 Session 隔离的 View 可用性。
