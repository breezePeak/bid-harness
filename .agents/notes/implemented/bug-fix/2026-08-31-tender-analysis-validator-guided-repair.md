# Agent Note: S2 Validator 导向的多轮 Artifact 修复

Status: implemented

## Problem

S2 Agent 可以在对话中声称分析完成，但四个正式 Artifact 仍可能包含 JSON 语法或严格 Schema 错误。Validator 将这些错误合并成一条通用消息，Orchestrator 又丢失 Artifact 和字段路径，因此 Agent 无法根据 Host 证据修复，用户也无法定位最终失败。

## Decision

`validateTenderAnalysis()` 分别返回文件缺失、JSON 语法错误和 Zod Schema 错误。Zod Issue 转换为仅含稳定错误码、Session 相对 Artifact、字段路径和安全中文说明的 `StageValidationIssue`；事件、Reducer 和 Projection 保留 `failureIssues`，Client 仅渲染这些 Host 产生的字段。

S2 Executor 在生成和 Coverage Audit 后运行预校验。校验失败时，它把最新 Issues 作为同一 live Agent 的 Repair follow-up，等待 idle 后重新校验，直到通过或用完 `tenderAnalysisRepairAttempts`。该配置默认为 3，允许 1–20。Repair 期间仍只允许 `grep`、`read` 和 `write`，只能覆盖四个正式 S2 Artifact。

Executor 预校验只为修复提供反馈。Orchestrator 仍使用正式 Validator 决定是否记录 `bid.user_confirmation.required`；用户确认前不记录 S2 完成，也不启动 S3。修复预算用完后仍失败时，用户可见具体 Issues 并可完整重跑 S2。

## Alternatives considered

**根据 Agent 回复文本完成阶段。** 回复不能证明 Artifact 可解析、字段完整或引用有效，因此不取代 Host Validator。

**放宽严格 Schema。** 将必填字段改为可选只会把无法使用的数据推进用户确认和后续阶段。

**无上限修复。** 模型、工具、语料或引用缺失时无法保证收敛，无上限循环会占用 Session 并持续消耗模型请求。可配置多轮 Repair 使 Host 能够根据部署预算提高自动收敛率，同时保留明确的失败状态。

**Artifact 无效时开放用户确认。** Client 无法安全读取严格 Artifact，且会绕过控制面的完成权限，因此失败状态只开放完整重试。

## Consequences

Schema 错误可在 Agent 和 UI 中定位到文件与字段，同一 Agent 可以根据每轮的最新 Host Issues 继续修复。Host 会为每次 S2 执行最多增加配置数量的 Agent 回合；达到预算仍不合法的 Artifact 不会进入用户确认或 S3。单元、Host 组合与 Client 测试分别固定详细错误转换、多轮修复、事件重放和失败展示。
