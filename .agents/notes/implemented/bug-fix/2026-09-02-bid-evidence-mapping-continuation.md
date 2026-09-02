# Agent Note: Bid S3 映射子 Agent 的同会话修复

Status: implemented

## Problem

S3 对同一 Mapping Task 的校验失败会重新启动一次性 Child Session。每次重试都丢失已读 Corpus、工具调用和被拒结果，页面因此出现重复的同名 Child；不透明 Corpus `file_id` 被模型截断或重复时，即使 chunk 正确也会触发无意义的本地 Evidence 错误。

## Decision

Evidence Mapping Executor 为每个 Mapping Task 建立一个 fresh-context、可继续的 Child，并在同一 Child 的后续轮次投递 Host 的具体校验问题。Child 的最终回复是原始 JSON；Host 在每轮 idle 后从该轮 assistant 消息读取 JSON，并继续执行严格 partial Schema、覆盖、Corpus 和网页证据校验。执行日志的所有 attempts 因而共享同一 `child_session_id`。

Host 对结果中的 `file_id` 仅在前 24 个字符唯一匹配 manifest 文件时还原完整 id，随后仍以完整 id 和 chunk 验证。不能唯一匹配的值保持原样并按原有规则拒绝。

## Alternatives considered

**每次校验失败都启动新的 one-shot Child。** 不采用，因为重试无法复用已经取得的资料和错误上下文，也直接造成重复任务卡片。

**让模型继续手写完整哈希且不做 Host 还原。** 不采用，因为 `file_id` 是不承载业务语义的内部标识；在唯一前缀条件下由 Host 还原不会放宽对实际 Corpus chunk 的验证。

**扩展 continuable 子 Agent 的跨轮 structured output 协议。** 暂不采用，因为该协议当前明确只服务一次性 run。S3 以 JSON 回复加 Host 严格解析实现同会话修复，不改变通用 subagent 的一次性 structured-output 约定。

## Consequences

每个 S3 Mapping Task 在一次阶段执行中只创建一个 Child Session，失败修复不会重新拉起同任务的 Child，已通过的兄弟任务仍不重跑。JSON 前后缀或字段错误会被 Host 明确记录并反馈到同一 Child；该路径不再获得 one-shot structured-output 工具的模型侧参数约束，但严格 Host 校验仍是 Artifact 准入条件。聚焦测试覆盖同 Child repair、兄弟任务隔离和唯一前缀 id 还原。
