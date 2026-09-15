# Agent Note: Bid 联网搜索统一业务开关

Status: implemented

## Problem

Bid 的联网工具权限由 `resumePolicy.webAccess`、S4 固定工具列表和 S5 Writer 条件共同决定，恢复或重试时可能让同一项目的联网行为发生变化；S4 缺少 Web 工具时还可能在进入子任务后重复暴露基础设施错误。

## Decision

`BidHostRuntime` 配置以 `webSearchEnabled` 作为联网业务开关，默认值为 `true`，并将解析后的值传给 S4 与 S5 执行器。`web_search` 和 `web_fetch` 始终作为一组能力处理：S4 开启时在调度 Child 前一次性检查两者，关闭时不检查且不把两者加入 Child 的允许列表；S5 Writer 使用同一值。`resumePolicy.webAccess` 不再参与 Bid 联网决策。`tool-web` 仍只负责注册工具能力。

## Alternatives considered

**继续让 `resumePolicy.webAccess` 覆盖联网配置。** 否决：恢复、重试和新执行会产生不同的工具集合，无法保证一次 Host 配置在整个 Bid 生命周期内保持一致。

**为 S4、S5 和 Final Check 分别增加开关。** 否决：多个业务判断正是现有回归的来源，也会让 `web_search` 与 `web_fetch` 产生不对称配置。

## Consequences

Host 配置成为 Bid 联网行为的唯一业务来源，工具注册缺失与业务禁用被明确分离。关闭联网时主 Bid Agent 的直接 Web 调用由 Host 工具守卫拒绝，S4 Mapping Child 和 S5 Writer 则从创建请求中移除 Web 工具；恢复流程仍可保留既有 `resumePolicy` 数据，但它不会改变联网权限。
