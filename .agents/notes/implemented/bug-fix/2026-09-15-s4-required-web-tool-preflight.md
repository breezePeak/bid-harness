# Agent Note: S4 必需 Web 工具由 Bid preset 提供并在 Host 准入

Status: implemented

## Problem

Web App 为避免把 Web 工具绑定到全局会话而关闭全局 `tool-web`，Bid preset 需要在 Bid Agent 作用域重新挂载搜索和抓取工具。S4 的 Final Check 与 remap 仍从全局工具视图检查能力时，会把正确的 preset 配置误判为缺少 `web_search` 或 `web_fetch`；缺少工具若在 Section 调度后才暴露，还会污染章节失败记录并触发无意义的基础设施重试。

## Decision

Bid preset 显式挂载 `@deepseek-ai/dsh-tool-web` 的 `search: true` 和 `fetch: true`，覆盖 base 层 `fetch: false` 的共享默认值。S4 在创建任何研究任务前，以当前 Bid Agent 的 `tools.schemas(agent)` 执行一次 Host preflight，始终要求 `web_search` 与 `web_fetch`；该检查不受 S4 的恢复 Web 策略关闭值影响。缺少工具时直接以缺失名称失败，不创建 Section Subagent、不写入 Section 级失败、不进入 Mapping Subagent 基础设施重试。子 Agent 继续通过父 Agent 的 Bid preset 作用域继承这两个工具，并由工具过滤器限制为 S4 允许的名称。

## Alternatives considered

**删除或放宽 `requiredTools`：** 未采用，因为 Web 搜索和抓取是 S4 的必需能力，放宽只会把配置错误变成不完整的研究结果。

**重新启用 Web App 全局 `tool-web`：** 未采用，因为这会绕过按任务 Provider 选择的 preset 边界，使无 Bid 会话也获得 Web 工具。

**在每个 Section 子任务中单独检查工具：** 未采用，因为它会重复报告同一个 Host 配置错误，并可能启动失败任务和基础设施重试；一次 Host preflight 已覆盖创建任务前的必要条件。

## Consequences

Bid 的主 Agent、Mapping Subagent、Final Check 和 remap 均从同一份按会话挂载的 Web 工具能力运行，且 `web_fetch` 的启用状态由 preset 明确表达。base 与 Web App 仍可保持全局关闭，因此其他 preset 不会因 Bid 的能力要求获得额外工具。用户修复 preset 或宿主配置后，可以从未创建 Section 任务的 S4 Run 重新执行。
