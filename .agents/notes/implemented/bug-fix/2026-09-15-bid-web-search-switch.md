# Agent Note: Bid 联网搜索统一业务开关

Status: implemented

## Problem

Bid 的联网工具权限由 S4 固定工具列表和 S5 Writer 条件共同决定，恢复或重试时可能让同一项目的联网行为发生变化；S4 缺少 Web 工具时还可能在进入子任务后重复暴露基础设施错误。

## Decision

`BidHostRuntime` 配置以 `webSearchEnabled` 作为联网业务开关，默认值为 `true`，并将解析后的值传给 S4 与 S5 执行器。`web_search` 和 `web_fetch` 始终作为一组能力处理：S4 开启时在调度 Child 前一次性检查两者，关闭时不检查且不把两者加入 Child 的允许列表；S5 Writer 使用同一值。S4 Task 指纹直接包含该值，避免恢复时复用不同联网条件下的结果。`tool-web` 仍只负责注册工具能力。

## Alternatives considered

**保留仅承载联网字段的 Resume Policy。** 否决：恢复策略没有独立业务语义，保留空策略或兼容字段会让联网权限重新获得第二个潜在来源。

**为 S4、S5 和 Final Check 分别增加开关。** 否决：多个业务判断正是现有回归的来源，也会让 `web_search` 与 `web_fetch` 产生不对称配置。

## Consequences

Host 配置成为 Bid 联网行为的唯一业务来源，工具注册缺失与业务禁用被明确分离。关闭联网时主 Bid Agent 的直接 Web 调用由 Host 工具守卫拒绝，S4 Mapping Child 和 S5 Writer 则从创建请求中移除 Web 工具；恢复流程只保留 Run 身份与工作描述，不携带联网策略。
